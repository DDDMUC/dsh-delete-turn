// dsh-delete-turn - pure session-log logic.
//
// Everything here operates on the plain event JSON read back through the
// host's public sessionQuery service, so the module has no DSH SDK imports and
// runs unchanged under `node --test`. The two central pieces are the official
// surface fold (which nodes the model currently sees, and which earlier nodes a
// replacement shadowed), the range planner that turns one UI target into a
// canonical, contiguous surface-replace range, and the splice planner that
// deletes a whole turn and replays every later turn after it with fresh,
// consecutive turn numbers (the only numbering the session format accepts).
//
// The only import is the platform's own id generator: a replay copy must carry
// a FRESH message id, never the id of the message it copies.

import { randomUUID } from 'node:crypto'

/** Plugin id shared by the host and browser halves. */
export const PLUGIN_ID = 'dsh-delete-turn'

/** The four event types that may carry `surfaceOp` (official surface contract). */
const SURFACE_TYPES = new Set([
  'system/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Whether one event participates in the model-visible surface.
 * @param event - raw session event.
 * @returns true for a message-producing event type.
 */
export function isSurfaceEvent(event) {
  return SURFACE_TYPES.has(event.type)
}

/**
 * Replay the surface operations of a complete log.
 *
 * Mirrors the official fold: `append` pushes the event onto the tail; a
 * `replace` swaps the inclusive window between its two surface nodes for the
 * replacing event. Replacements whose anchors are no longer present are
 * skipped defensively (a corrupt log must not throw inside an HTTP handler).
 *
 * @param events - complete contiguous raw event log in seq order.
 * @returns current surface seqs in model order plus every landed replacement
 *   with the exact seqs it shadowed.
 */
export function foldSurface(events) {
  const nodes = []
  const replacements = []
  for (const event of events) {
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace') continue
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq, shadowed })
  }
  return { nodes, replacements }
}

/**
 * Durable message identity of one surface event.
 * @param event - raw session event.
 * @returns the message id, or undefined for an event without one.
 */
export function messageIdOf(event) {
  const data = event.data
  if (!data || typeof data !== 'object') return undefined
  if (event.type === 'user/message') return typeof data.id === 'string' ? data.id : undefined
  if (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'system/message') {
    const message = data.message
    return message && typeof message.id === 'string' ? message.id : undefined
  }
  return undefined
}

/**
 * Whether one message source belongs to this plugin.
 *
 * DSH 0.1.7 migrated stored logs to session format v4, whose canonicalization
 * flattens plugin sources: `{ kind: 'plugin', plugin: X }` becomes
 * `{ kind: 'plugin:X' }`. Both shapes must be recognized, because a session
 * keeps its on-disk v3 log until it is opened, and reads after that return the
 * canonical v4 shape. Deletion carriers written as system messages cannot use a
 * plugin kind at all — both replay validators require `system-prompt` — so they
 * carry the plugin id in an extra `plugin` key instead.
 * @param source - message source object from a log event.
 * @returns true when the source names this plugin.
 */
export function sourceOwnsPlugin(source) {
  if (!source || typeof source !== 'object') return false
  if (source.kind === 'plugin' && source.plugin === PLUGIN_ID) return true
  if (source.kind === 'system-prompt' && source.plugin === PLUGIN_ID) return true
  return source.kind === `plugin:${PLUGIN_ID}`
}

/**
 * Rebuild this plugin's deletion ledger from the log alone.
 *
 * Every deletion is one replacement event whose message source is
 * `{ kind: 'plugin', plugin: 'dsh-delete-turn' }` (v3) or
 * `{ kind: 'plugin:dsh-delete-turn' }` (v4). The mode is inferred from
 * the shadowed window: one user message is a single-message delete, one step's
 * assistant/tool nodes are a step delete, anything wider is a reply delete.
 * A replacement landed by any other producer — compaction, for instance — is
 * ignored.
 *
 * @param events - complete contiguous raw event log.
 * @returns one entry per hidden seq: `{ seq, mode, replacement }`.
 */
export function hiddenEntries(events) {
  return hiddenEntriesOfFold(foldSurface(events), events)
}

/**
 * Rebuild the deletion ledger from an existing fold result.
 * @param folded - result of {@link foldSurface}.
 * @param events - the same log the fold was computed from.
 * @returns one entry per hidden seq: `{ seq, mode, replacement }`.
 */
export function hiddenEntriesOfFold(folded, events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const out = []
  for (const replacement of folded.replacements) {
    const event = bySeq.get(replacement.seq)
    const data = event && event.data
    const source = data && (data.source || (data.message && data.message.source))
    if (!sourceOwnsPlugin(source)) continue
    const mode = inferMode(bySeq, replacement.shadowed)
    for (const seq of replacement.shadowed) out.push({ seq, mode, replacement: replacement.seq })
  }
  return out
}

/**
 * Turns whose reply window still holds deletable surface content.
 *
 * The transcript keeps rows whose content left the model context through a
 * compaction (that is the whole point of compaction), so the browser half must
 * not offer a delete action on them. This mirrors the member scan of
 * {@link planRange}'s reply mode without its cleanliness validation; the host
 * remains authoritative when a delete actually lands.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @returns turn numbers with at least one non-prompt surface node after the
 *   turn's last human prompt.
 */
export function deletableReplyTurns(events, surfaceNodes) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const turnOf = turnIndex(events)
  const lastHuman = new Map()
  const members = new Map()
  surfaceNodes.forEach((seq, index) => {
    const event = bySeq.get(seq)
    if (!event || event.type === 'system/message') return
    const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : turnOf.get(seq)
    if (typeof turn !== 'number') return
    if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') {
      lastHuman.set(turn, index)
      return
    }
    const list = members.get(turn) ?? []
    list.push(index)
    members.set(turn, list)
  })
  const out = []
  for (const [turn, indexes] of members) {
    const last = lastHuman.get(turn)
    if (last === undefined || indexes.some((index) => index > last)) out.push(turn)
  }
  return out.sort((a, b) => a - b)
}

/**
 * Classify one deletion from its shadowed window, so a reloaded client can
 * tell a step deletion (the process row survives) from a reply deletion.
 * @param bySeq - seq -> event lookup of the same log.
 * @param shadowed - shadowed surface seqs in model order.
 * @returns `message`, `step` or `reply`.
 */
export function inferMode(bySeq, shadowed) {
  const members = shadowed.map((seq) => bySeq.get(seq)).filter((event) => event !== undefined)
  if (members.length === 1 && members[0].type === 'user/message') return 'message'
  if (members.length > 0 && members.every((event) => event.type === 'assistant/message' || event.type === 'tool/result')) {
    const turn = members[0].data && members[0].data.turn
    const step = members[0].data && members[0].data.step
    if (members.every((event) => event.data && event.data.turn === turn && event.data.step === step)) return 'step'
  }
  return 'reply'
}

/**
 * In-place content rewrites landed by other producers.
 *
 * The official transcript keeps the original row of a shadowed event and draws
 * the replacement content in its place (dsh-edit-turn does exactly this for an
 * edited message), so the browser half needs `from -> to` pairs to keep that
 * row's actions and to address the live node.
 *
 * Only a single-node replacement of the same event type counts as an in-place
 * rewrite: it is the shape dsh-edit-turn lands when it rewrites one message in
 * place, and it cannot impersonate the mixed rows of a rollback window, whose
 * content the edit already superseded. This plugin's own deletion placeholders
 * and the official compaction checkpoints rewrite context, not content, and
 * are excluded — a compacted row must keep offering no delete action.
 *
 * @param folded - result of {@link foldSurface}.
 * @param events - the same log the fold was computed from.
 * @returns `[shadowedSeq, replacementSeq]` pairs, one per edited node.
 */
export function contentEditPairs(folded, events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const out = []
  for (const replacement of folded.replacements) {
    if (replacement.shadowed.length !== 1) continue
    const event = bySeq.get(replacement.seq)
    if (!event) continue
    const data = event.data
    const source = data && (data.source || (data.message && data.message.source))
    if (sourceOwnsPlugin(source)) continue
    if (source && source.kind === 'compact-checkpoint') continue
    const shadowed = bySeq.get(replacement.shadowed[0])
    if (!shadowed || shadowed.type !== event.type) continue
    out.push([replacement.shadowed[0], replacement.seq])
  }
  return out
}

/**
 * Map every event seq to the turn that encloses it.
 *
 * Turn brackets are the durable source for user messages (their payload has no
 * turn field); assistant and tool events carry their own turn and override the
 * bracket reading.
 *
 * @param events - complete contiguous raw event log.
 * @returns seq -> turn number (undefined outside any turn).
 */
export function turnIndex(events) {
  const turnOf = new Map()
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = event.data && event.data.turn
      turnOf.set(event.seq, current)
      continue
    }
    if (event.type === 'turn/end') {
      turnOf.set(event.seq, current)
      current = undefined
      continue
    }
    const data = event.data
    const explicit =
      (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'tool/call') &&
      data && typeof data.turn === 'number'
        ? data.turn
        : undefined
    turnOf.set(event.seq, explicit !== undefined ? explicit : current)
  }
  return turnOf
}

/** The turn still awaiting its `turn/end`, or null when every turn closed. */
export function openTurn(events) {
  let open = null
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data && event.data.turn
    else if (event.type === 'turn/end' && (open === null || event.data.turn === open)) open = null
  }
  return open
}

/** Whether an operation is in flight that will still write the surface. */
export function isBusy(events) {
  if (openTurn(events) !== null) return true
  let compaction = false
  for (const event of events) {
    if (event.type === 'compaction/start') compaction = true
    else if (event.type === 'compaction/end') compaction = false
  }
  return compaction
}

/** Planner rejection with a machine code the HTTP layer forwards verbatim. */
export class PlanError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PlanError'
    this.code = code
  }
}

/**
 * Whether one event is this plugin's own empty deletion placeholder.
 * Placeholders are no-ops already removed from the context, so a later window
 * may shadow them again; any other foreign node keeps its veto.
 * @param event - raw session event.
 * @returns true for a user/message produced by this plugin.
 */
export function isOwnPlaceholder(event) {
  const data = event && event.data
  const source = data && (data.source || (data.message && data.message.source))
  return sourceOwnsPlugin(source)
}

/**
 * Turn one UI target into a canonical replacement range.
 *
 * Modes:
 *   - `message`: exactly the addressed user message (human prompt or injected
 *     context) — never a system prompt, never an assistant message;
 *   - `step`: the addressed step's assistant message plus every tool result
 *     that step produced, so a tool_use/tool_result pair never splits;
 *   - `reply`: every surface node of the addressed turn after its last human
 *     prompt (injected context, assistant steps, tool results), so the
 *     question survives while the whole answer attempt leaves the context.
 *
 * The returned window is contiguous in surface order and contains no foreign
 * node, so the landed replacement cannot shadow content the user did not aim
 * at.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @param request - `{ mode, seq?, messageId?, turn? }`.
 * @returns `{ mode, targetSeq, startSeq, endSeq, shadowed, turn, step }`.
 * @throws {PlanError} with a stable code when the target cannot be planned.
 */
export function planRange(events, surfaceNodes, request) {
  const mode = request && request.mode
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const nodeIndex = new Map(surfaceNodes.map((seq, index) => [seq, index]))
  const turnOf = turnIndex(events)

  const targetSeq = resolveTargetSeq(events, surfaceNodes, request, mode)
  if (targetSeq === undefined) throw new PlanError('not-deletable', 'target not found')
  if (!nodeIndex.has(targetSeq)) throw new PlanError('already-deleted', 'target is not on the current surface')
  const target = bySeq.get(targetSeq)
  if (!target) throw new PlanError('not-deletable', 'target event not found')

  // Surface node 0 is the system prompt head: the official append contract only
  // lets a system/message rewrite exactly that node, and no UI row targets it.
  if (targetSeq === surfaceNodes[0]) throw new PlanError('not-deletable', 'the system prompt head cannot be deleted')
  if (target.type === 'system/message') throw new PlanError('not-deletable', 'the system prompt cannot be deleted')

  if (mode === 'message') {
    if (target.type !== 'user/message') {
      throw new PlanError('not-deletable', 'only user messages can be removed on their own')
    }
    const turn = turnOf.get(targetSeq)
    return {
      mode,
      targetSeq,
      startSeq: targetSeq,
      endSeq: targetSeq,
      shadowed: [targetSeq],
      turn: typeof turn === 'number' ? turn : 0,
      step: 0,
    }
  }

  if (mode === 'step') {
    if (target.type !== 'assistant/message' && target.type !== 'tool/result') {
      throw new PlanError('not-deletable', 'step deletion requires an assistant message or a tool result')
    }    const turn = target.data && target.data.turn
    const step = target.data && target.data.step
    if (typeof turn !== 'number' || typeof step !== 'number') {
      throw new PlanError('not-deletable', 'step deletion requires a closed step')
    }
    const members = events
      .filter(
        (event) =>
          (event.type === 'assistant/message' || event.type === 'tool/result') &&
          event.data &&
          event.data.turn === turn &&
          event.data.step === step &&
          nodeIndex.has(event.seq),
      )
      .map((event) => event.seq)
    if (members.length === 0 || !members.includes(targetSeq)) {
      throw new PlanError('already-deleted', 'this step is no longer on the surface')
    }
    const memberSet = new Set(members)
    const indexes = members.map((seq) => nodeIndex.get(seq))
    const startIdx = Math.min(...indexes)
    const endIdx = Math.max(...indexes)
    const shadowed = surfaceNodes.slice(startIdx, endIdx + 1)
    if (shadowed.some((seq) => !memberSet.has(seq) && !isOwnPlaceholder(bySeq.get(seq)))) {
      throw new PlanError('range-not-clean', 'the step window contains unrelated surface nodes')
    }
    return {
      mode,
      targetSeq,
      startSeq: shadowed[0],
      endSeq: shadowed[shadowed.length - 1],
      shadowed,
      turn,
      step,
    }
  }

  if (mode === 'reply') {
    const turn = target.data && typeof target.data.turn === 'number' ? target.data.turn : turnOf.get(targetSeq)
    if (typeof turn !== 'number') throw new PlanError('not-deletable', 'the target does not belong to a turn')
    let lastHumanIdx = -1
    for (const event of events) {
      if (event.type !== 'user/message') continue
      if (!event.data || !event.data.source || event.data.source.kind !== 'user') continue
      if (turnOf.get(event.seq) !== turn) continue
      const index = nodeIndex.get(event.seq)
      if (index !== undefined && index > lastHumanIdx) lastHumanIdx = index
    }
    const members = []
    for (const seq of surfaceNodes) {
      const index = nodeIndex.get(seq)
      if (index <= lastHumanIdx) continue
      const event = bySeq.get(seq)
      if (!event) continue
      // The system prompt head is appended inside the first step, so its
      // enclosing turn is that turn; it is never reply content and must never
      // anchor a reply window.
      if (event.type === 'system/message') continue
      const eventTurn =
        event.data && typeof event.data.turn === 'number' ? event.data.turn : turnOf.get(seq)
      if (eventTurn !== turn) continue
      members.push(seq)
    }
    if (members.length === 0) throw new PlanError('nothing-to-delete', 'the turn has no reply content left')
    const memberSet = new Set(members)
    const startIdx = nodeIndex.get(members[0])
    const endIdx = nodeIndex.get(members[members.length - 1])
    const shadowed = surfaceNodes.slice(startIdx, endIdx + 1)
    if (shadowed.some((seq) => !memberSet.has(seq) && !isOwnPlaceholder(bySeq.get(seq)))) {
      throw new PlanError('range-not-clean', 'the reply window contains unrelated surface nodes')
    }
    const closing = bySeq.get(members[members.length - 1])
    const step = closing && closing.type === 'assistant/message' && typeof closing.data.step === 'number' ? closing.data.step : 0
    return {
      mode,
      targetSeq,
      startSeq: members[0],
      endSeq: members[members.length - 1],
      shadowed,
      turn,
      step,
    }
  }

  throw new PlanError('not-deletable', `unsupported mode ${String(mode)}`)
}
// --- target resolution -------------------------------------------------------

/**
 * Resolve the event one request addresses, shared by every mode.
 *
 * `seq` is the durable address the browser half reads off the official
 * `data-chat-flow-*` anchors; `messageId` is what the official
 * assistant-actions slot hands over; `turn` is the fallback for rows that only
 * carry a turn number (the process/disclosure row). A turn address binds to the
 * LAST surface node of that turn, which is the node whose removal covers the
 * whole attempt.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @param request - `{ seq?, messageId?, turn? }`.
 * @param mode - calling mode; only the turn-addressed modes use `turn`.
 * @returns the target seq, or undefined when nothing matches.
 */
function resolveTargetSeq(events, surfaceNodes, request, mode) {
  let targetSeq = typeof request.seq === 'number' ? request.seq : undefined
  if (targetSeq === undefined && typeof request.messageId === 'string' && request.messageId !== '') {
    for (const event of events) {
      if (messageIdOf(event) === request.messageId) {
        targetSeq = event.seq
        break
      }
    }
  }
  if (targetSeq === undefined && (mode === 'reply' || mode === 'splice') && typeof request.turn === 'number') {
    const bySeq = new Map(events.map((event) => [event.seq, event]))
    const turnOf = turnIndex(events)
    for (let index = surfaceNodes.length - 1; index >= 0; index -= 1) {
      const seq = surfaceNodes[index]
      const event = bySeq.get(seq)
      if (!event) continue
      if (turnOfSeq(bySeq, turnOf, seq) === request.turn) {
        targetSeq = seq
        break
      }
    }
  }
  return targetSeq
}

/**
 * The turn enclosing one surface node: the event's own coordinate when it has
 * one, otherwise its turn bracket (user messages carry no turn field).
 * @param bySeq - seq -> event lookup.
 * @param turnOf - {@link turnIndex} result.
 * @param seq - surface node seq.
 * @returns the turn number, or undefined outside any turn.
 */
function turnOfSeq(bySeq, turnOf, seq) {
  const event = bySeq.get(seq)
  if (!event) return undefined
  const data = event.data
  if (data && typeof data.turn === 'number') return data.turn
  return turnOf.get(seq)
}

/**
 * Whether one event is a plugin silent carrier rather than conversation
 * content.
 *
 * The ecosystem convention (dsh-rerun-turn's README, shared by this plugin):
 * a `user/message` whose source kind starts with `plugin:` and whose content is
 * EMPTY is a bookkeeping carrier - every shipped adapter drops it before the
 * request, so it carries no model-visible content. Such a node standing inside
 * a window may be retired without a copy.
 *
 * @param event - raw session event.
 * @returns true for a silent plugin carrier.
 */
export function isSilentPluginCarrier(event) {
  if (!event || event.type !== 'user/message') return false
  const data = event.data
  if (!data || typeof data !== 'object') return false
  const source = data.source
  if (!source || typeof source.kind !== 'string' || !source.kind.startsWith('plugin:')) return false
  return Array.isArray(data.content) && data.content.length === 0
}

/**
 * Every closed turn bracket in the log, keyed by turn number.
 *
 * A turn number can be opened more than once in logs written by older builds
 * (a replay that reused the loop's counter), so the value is a list in log
 * order. Brackets left open by an unterminated turn keep `endSeq: null` and
 * never take part in a plan.
 *
 * @param events - complete contiguous raw event log.
 * @returns turn -> `[{ startSeq, endSeq }]`.
 */
export function turnBrackets(events) {
  const out = new Map()
  let open = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      const turn = event.data && event.data.turn
      open = typeof turn === 'number' ? { turn, startSeq: event.seq, endSeq: null } : null
      if (open !== null) {
        const list = out.get(turn) ?? []
        list.push(open)
        out.set(turn, list)
      }
      continue
    }
    if (event.type === 'turn/end') {
      if (open !== null && event.data && event.data.turn === open.turn) open.endSeq = event.seq
      open = null
    }
  }
  return out
}

/**
 * The highest turn number the log has opened.
 * @param events - complete contiguous raw event log.
 * @returns the max `turn/start` turn, or 0 when the log has no turn.
 */
export function lastTurnOf(events) {
  let last = 0
  for (const event of events) {
    if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number' && event.data.turn > last) {
      last = event.data.turn
    }
  }
  return last
}

/**
 * The turn number the next `turn/start` must carry.
 *
 * This is the format's own rule, not an inference: the v4 relationship
 * validator (`dsh-session-format-v3-to-v4`, "turn/start does not open the
 * expected turn") starts `nextTurn` at 1 and advances it once per `turn/end`.
 * A replayed turn therefore cannot reuse an original number - it takes the next
 * one after the log's last closed turn, which is why a splice renumbers its
 * copies instead of pretending the numbering was rearranged.
 *
 * @param events - complete contiguous raw event log.
 * @returns the next accepted turn number.
 */
export function nextTurnOf(events) {
  let closed = 0
  for (const event of events) if (event.type === 'turn/end') closed += 1
  return closed + 1
}

// --- splice planner ----------------------------------------------------------

/**
 * Plan a SPLICE: delete one whole turn and replay every later turn after it.
 *
 * The window starts at the addressed turn's first surface node (its human
 * prompt, injected context or reply content) and runs to the LAST surface node
 * of the log, so no node of any later turn stays behind. The carrier that lands
 * in that position is turn-less and content-free, and the later turns are
 * re-appended as fresh copies with new, consecutive turn numbers - which is the
 * only numbering the format accepts (see {@link nextTurnOf}).
 *
 * Nodes belonging to a replayed turn travel; a system message inside the tail
 * does not (the loop owns the system prompt and re-injects it - the same rule
 * dsh-rerun-turn's replay follows), and neither does this plugin's own
 * placeholder or any other plugin's silent carrier. Anything else inside the
 * window - a node that belongs to no replayed turn - refuses the plan, so a
 * splice can never silently retire content the user did not aim at.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @param request - `{ seq?, messageId?, turn? }`.
 * @returns `{ mode, targetSeq, startSeq, endSeq, shadowed, turn, replay,
 *   replayTurns, baseTurn, logFrom, logTo }`, where `replay` carries one entry
 *   per replayed turn (`{ turn, startSeq, endSeq, shadowed }`).
 * @throws {PlanError} with a stable code when the splice cannot be planned.
 */
/**
 * The shared lookups one splice planning pass needs.
 *
 * Built once so that advertising (which rows may offer the action) and planning
 * (what the route accepts) can run the SAME checks instead of two similar ones:
 * `spliceableSeqs` and `planSplice` both go through {@link spliceWindow}.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @returns the context object {@link spliceWindow} consumes.
 */
export function spliceContext(events, surfaceNodes) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const turnOf = turnIndex(events)
  const firstIdxOf = new Map()
  let badOrphan = -1
  for (let index = 0; index < surfaceNodes.length; index += 1) {
    const event = bySeq.get(surfaceNodes[index])
    if (event === undefined) continue
    const nodeTurn = turnOfSeq(bySeq, turnOf, surfaceNodes[index])
    if (typeof nodeTurn === 'number') {
      if (!firstIdxOf.has(nodeTurn)) firstIdxOf.set(nodeTurn, index)
      continue
    }
    // A turn-less node that is neither this plugin's placeholder nor a silent
    // carrier cannot be reproduced by a replay; its index is the earliest point
    // a window may not start before.
    if (badOrphan === -1 && !isOwnPlaceholder(event) && !isSilentPluginCarrier(event)) badOrphan = index
  }
  return {
    surfaceNodes,
    bySeq,
    turnOf,
    brackets: turnBrackets(events),
    firstIdxOf,
    badOrphan,
    baseTurn: nextTurnOf(events),
    lastTurn: lastTurnOf(events),
  }
}

/**
 * The replacement window and replay one addressed surface node plans.
 * @param context - result of {@link spliceContext}.
 * @param targetSeq - the addressed surface node.
 * @returns `{ targetSeq, shadowed, turn, replay, baseTurn }`.
 * @throws {PlanError} with a stable code when the splice cannot be planned.
 */
export function spliceWindow(context, targetSeq) {
  const { surfaceNodes, bySeq, turnOf, brackets, firstIdxOf, badOrphan, baseTurn, lastTurn } = context
  const target = bySeq.get(targetSeq)
  if (!target) throw new PlanError('not-deletable', 'target event not found')
  if (targetSeq === surfaceNodes[0]) throw new PlanError('not-deletable', 'the system prompt head cannot be deleted')
  if (target.type === 'system/message') throw new PlanError('not-deletable', 'the system prompt cannot be deleted')

  const turn = turnOfSeq(bySeq, turnOf, targetSeq)
  if (typeof turn !== 'number') throw new PlanError('not-deletable', 'the target does not belong to a turn')

  const firstIdx = firstIdxOf.get(turn)
  if (firstIdx === undefined) throw new PlanError('nothing-to-delete', 'the turn has no surface content left')
  // Node 0 is the protected system prompt head: a replacement covering it must
  // itself be a system/message over exactly that node, which a splice carrier
  // never is. The first turn therefore cannot be spliced.
  if (firstIdx === 0) throw new PlanError('not-deletable', 'the turn holding the system prompt head cannot be spliced')
  if (badOrphan !== -1 && badOrphan > firstIdx) {
    throw new PlanError('range-not-clean', 'the window contains a node that belongs to no replayed turn')
  }
  if (lastTurn + 1 !== baseTurn) throw new PlanError('range-not-clean', 'the log turn numbering is not contiguous')

  const shadowed = surfaceNodes.slice(firstIdx)
  const membersOfTurn = new Map()
  for (const seq of shadowed) {
    const event = bySeq.get(seq)
    if (!event) throw new PlanError('range-not-clean', 'the window names an event the log does not hold')
    const nodeTurn = turnOfSeq(bySeq, turnOf, seq)
    if (nodeTurn === turn) continue
    if (typeof nodeTurn === 'number' && nodeTurn > turn) {
      // A system message is loop-owned machinery rather than conversation, so
      // it is retired without a copy (dsh-rerun-turn's replay rule).
      if (event.type === 'system/message') continue
      const list = membersOfTurn.get(nodeTurn) ?? []
      list.push(seq)
      membersOfTurn.set(nodeTurn, list)
      continue
    }
    // Turn-less node: only a carrier that produces no conversation content may
    // ride along in the window.
    if (!isOwnPlaceholder(event) && !isSilentPluginCarrier(event)) {
      throw new PlanError('range-not-clean', 'the window contains a node that belongs to no replayed turn')
    }
  }

  const replay = []
  for (const nodeTurn of [...membersOfTurn.keys()].sort((a, b) => a - b)) {
    const owned = membersOfTurn.get(nodeTurn)
    const closed = (brackets.get(nodeTurn) ?? []).filter((bracket) => bracket.endSeq !== null)
    // A turn number opened more than once (older builds' replays): the bracket
    // holding the turn's live content is the one whose span covers the most of
    // it. Every live node must sit inside that one bracket, or the replay would
    // copy a step event outside an open turn.
    let owner = null
    let best = 0
    for (const bracket of closed) {
      const held = owned.filter((seq) => seq >= bracket.startSeq && seq <= bracket.endSeq).length
      if (held > best) {
        best = held
        owner = bracket
      }
    }
    if (owner === null || best !== owned.length) {
      throw new PlanError('range-not-clean', 'turn ' + String(nodeTurn) + ' has no single closed bracket holding its live content')
    }
    replay.push({ turn: nodeTurn, startSeq: owner.startSeq, endSeq: owner.endSeq, shadowed: owned })
  }

  return { targetSeq, shadowed, turn, replay, baseTurn }
}

/**
 * Plan a SPLICE by the target the request addresses.
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @param request - `{ seq?, messageId?, turn? }`.
 * @returns `{ mode, targetSeq, startSeq, endSeq, shadowed, turn, replay,
 *   replayTurns, baseTurn, logFrom, logTo }`, where `replay` carries one entry
 *   per replayed turn (`{ turn, startSeq, endSeq, shadowed }`).
 * @throws {PlanError} with a stable code when the splice cannot be planned.
 */
export function planSplice(events, surfaceNodes, request) {
  const context = spliceContext(events, surfaceNodes)
  const onSurface = new Set(surfaceNodes)
  const targetSeq = resolveTargetSeq(events, surfaceNodes, request, 'splice')
  if (targetSeq === undefined) throw new PlanError('not-deletable', 'target not found')
  if (!onSurface.has(targetSeq)) throw new PlanError('already-deleted', 'target is not on the current surface')
  const window = spliceWindow(context, targetSeq)
  const { shadowed, replay } = window
  return {
    mode: 'splice',
    ...window,
    startSeq: shadowed[0],
    endSeq: shadowed[shadowed.length - 1],
    replayTurns: replay.map((entry) => entry.turn),
    logFrom: replay.length > 0 ? replay[0].startSeq : shadowed[0],
    // The walk runs to the END of the last replayed turn's bracket, not to its
    // last surface node: step/end and turn/end follow the content, and a replay
    // that stopped before them would leave the copied turn open - the log would
    // then refuse the loop's next turn.
    logTo: Math.max(replay.length > 0 ? Math.max(...replay.map((entry) => entry.endSeq)) : 0, ...shadowed),
  }
}

/**
 * The live human-prompt seqs a splice would accept right now.
 *
 * This is the ADVERTISEMENT the state route publishes so a row only offers the
 * action the host will actually accept: every candidate seq is put through the
 * identical {@link spliceWindow} the route's plan uses, so this list cannot
 * drift from what a click does.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @returns the spliceable prompt seqs, in surface order.
 */
export function spliceableSeqs(events, surfaceNodes) {
  const context = spliceContext(events, surfaceNodes)
  const out = []
  for (const seq of surfaceNodes) {
    const event = context.bySeq.get(seq)
    if (event === undefined || event.type !== 'user/message') continue
    if (!event.data || !event.data.source || event.data.source.kind !== 'user') continue
    try {
      spliceWindow(context, seq)
      out.push(seq)
    } catch {
      // A prompt whose window cannot be reproduced offers no entry.
    }
  }
  return out
}

/**
 * Source marker shared by every event a splice appends.
 * Equivalent to dsh-rerun-turn's `replaySource`.
 * @param source - the original message source.
 * @param spliceId - operation identity.
 * @param originalSeq - the seq this copy was copied from.
 * @returns the marked source.
 */
function spliceSource(source, spliceId, originalSeq) {
  return {
    ...(source && typeof source === 'object' ? source : {}),
    spliceBy: PLUGIN_ID,
    spliceId,
    originalSeq,
  }
}

/**
 * The call id one tool result resolves.
 * @param event - a tool/result event.
 * @returns the call id, or undefined for a result without one.
 */
function resultCallId(event) {
  const message = event.data && event.data.message
  const source = message && message.source
  if (source && typeof source.callId === 'string') return source.callId
  if (message && typeof message.toolCallId === 'string') return message.toolCallId
  return event.data && event.data.callId
}

/**
 * Build the replay writes of one splice.
 *
 * Equivalent to dsh-rerun-turn's `buildReplayWrites` (this repository is
 * standalone: the implementation is a copy, not a cross-package import), so the
 * copies are the platform's own ordinary events:
 *
 *   - fresh turn numbers, consecutive from `plan.baseTurn` (the format's
 *     `nextTurn` - an original number is refused by the real validator);
 *   - fresh message ids, `sourceEventSeqs` remapped onto the copies (assistant
 *     messages AND tool calls are both remappable here; a source that resolves
 *     to neither falls back to the copied assistant message);
 *   - `usage` and embedded `stream` dropped, so token statistics cannot double
 *     count and no half-streamed answer is replayed;
 *   - tool calls copied only as complete pairs, with the advertisement removed
 *     from the assistant content when its result never landed (the format
 *     refuses a step that closes with an unresolved call), while a
 *     `TOOL_NOT_STARTED` repair keeps its exact repair shape (no
 *     `sourceEventSeqs`, contract-shaped message id);
 *   - system messages and log-only records (attempts, retries, headers, splices,
 *     dispatches, workspace/todo bookkeeping) skipped: they describe the
 *     original run, not the conversation.
 *
 * One addition over the sibling's builder: a step whose content was entirely
 * retired is dropped and the surviving steps are renumbered from 1, because a
 * copied empty step would draw an empty process row. When nothing is dropped
 * the step numbering is the original one.
 *
 * @param events - complete contiguous raw event log.
 * @param plan - result of {@link planSplice}.
 * @param spliceId - operation identity stamped into every copy's source.
 * @param startSeq - the seq the first write lands at; writes are appended back
 *   to back, so each predicted seq is `startSeq` plus its offset.
 * @returns an ordered `{ type, data, surfaceOp?, sourceEventSeqs? }` write list.
 */
export function buildSpliceReplayWrites(events, plan, spliceId, startSeq) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const shadowedSet = new Set(plan.shadowed)
  const replayOfTurn = new Map(plan.replay.map((entry) => [entry.turn, entry]))
  const turnOf = turnIndex(events)
  const range = []
  for (const event of events) {
    if (event.seq < plan.logFrom || event.seq > plan.logTo) continue
    if (isSurfaceEvent(event)) {
      if (!shadowedSet.has(event.seq) || event.type === 'system/message') continue
      if (!replayOfTurn.has(turnOfSeq(bySeq, turnOf, event.seq))) continue
      range.push(event)
      continue
    }
    if (
      event.type === 'turn/start' ||
      event.type === 'turn/end' ||
      event.type === 'step/start' ||
      event.type === 'step/end' ||
      event.type === 'tool/call'
    ) {
      const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : undefined
      const entry = turn === undefined ? undefined : replayOfTurn.get(turn)
      if (entry === undefined || event.seq < entry.startSeq || event.seq > entry.endSeq) continue
      range.push(event)
    }
  }

  // Which steps survive: one that owns no copied message would draw an empty
  // process row, so it leaves with its bracket and the rest are renumbered.
  const stepMap = new Map()
  for (const entry of plan.replay) {
    const steps = []
    for (const event of range) {
      if (event.type === 'tool/call') continue
      if (!event.data || event.data.turn !== entry.turn || typeof event.data.step !== 'number') continue
      if (!steps.includes(event.data.step)) steps.push(event.data.step)
    }
    steps.sort((a, b) => a - b)
    steps.forEach((step, index) => stepMap.set(entry.turn + ':' + String(step), index + 1))
  }

  // Tool pairing facts for the whole range, so the assistant content can be
  // corrected before anything is written.
  const calledIds = new Set()
  const resultIds = new Set()
  const repairIds = new Set()
  for (const event of range) {
    if (event.type === 'tool/call') {
      calledIds.add(event.data.callId)
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = resultCallId(event)
    resultIds.add(callId)
    const error = event.data.error
    if (error && error.name === 'ToolNotStartedError' && error.code === 'TOOL_NOT_STARTED' && event.sourceEventSeqs === undefined) {
      repairIds.add(callId)
    }
  }
  const pairedIds = new Set()
  for (const id of calledIds) if (resultIds.has(id)) pairedIds.add(id)
  for (const id of repairIds) if (!calledIds.has(id)) pairedIds.add(id)

  const writes = []
  let predicted = startSeq
  let nextTurn = plan.baseTurn
  const turnMap = new Map()
  const copySeqByOriginal = new Map()
  let lastAssistantSeq = null
  const seqOf = () => {
    const seq = predicted
    predicted += 1
    return seq
  }
  const stepOf = (turn, step) => {
    const mapped = stepMap.get(String(turn) + ':' + String(step))
    return mapped === undefined ? step : mapped
  }
  for (const event of range) {
    const data = event.data || {}
    if (event.type === 'turn/start') {
      const entry = replayOfTurn.get(data.turn)
      // A second bracket reusing this turn number is not the live one; the plan
      // already proved every live node sits inside the bracket it chose.
      if (entry === undefined || event.seq !== entry.startSeq) continue
      turnMap.set(data.turn, nextTurn)
      writes.push({ type: 'turn/start', data: { turn: nextTurn } })
      seqOf()
      continue
    }
    if (event.type === 'turn/end') {
      const turn = turnMap.get(data.turn)
      if (turn === undefined) continue
      writes.push({ type: 'turn/end', data: { turn, reason: data.reason } })
      seqOf()
      nextTurn += 1
      continue
    }
    if (event.type === 'step/start' || event.type === 'step/end') {
      const turn = turnMap.get(data.turn)
      if (turn === undefined || !stepMap.has(String(data.turn) + ':' + String(data.step))) continue
      writes.push({ type: event.type, data: { turn, step: stepOf(data.turn, data.step) } })
      seqOf()
      continue
    }
    if (event.type === 'user/message') {
      writes.push({
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          id: randomUUID(),
          role: 'user',
          content: data.content,
          source: spliceSource(data.source, spliceId, event.seq),
        },
      })
      seqOf()
      continue
    }
    if (event.type === 'assistant/message') {
      const message = data.message || {}
      const source = { ...(message.source || {}) }
      // The provider's own replay state describes the original response; a copy
      // that carried it would claim to be that very response.
      delete source.replayState
      const content = Array.isArray(message.content)
        ? message.content.filter((block) => !(block && block.type === 'tool-call' && !pairedIds.has(block.id)))
        : []
      writes.push({
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn: turnMap.get(data.turn),
          step: stepOf(data.turn, data.step),
          message: {
            id: randomUUID(),
            role: 'assistant',
            content,
            source: spliceSource(source, spliceId, event.seq),
          },
          stream: [],
          ...(data.interrupted === true ? { interrupted: true } : {}),
        },
      })
      copySeqByOriginal.set(event.seq, predicted)
      lastAssistantSeq = predicted
      seqOf()
      continue
    }
    if (event.type === 'tool/call') {
      if (!pairedIds.has(data.callId)) continue
      writes.push({
        type: 'tool/call',
        data: {
          turn: turnMap.get(data.turn),
          step: stepOf(data.turn, data.step),
          callId: data.callId,
          name: data.name,
          arguments: data.arguments,
        },
      })
      copySeqByOriginal.set(event.seq, predicted)
      seqOf()
      continue
    }
    if (event.type === 'tool/result') {
      const callId = resultCallId(event)
      if (!pairedIds.has(callId)) continue
      const message = data.message || {}
      const rest = { ...message }
      delete rest.id
      delete rest.content
      delete rest.source
      // The repair carrier must keep its contract-shaped id
      // (`interrupted-tool-result-<callId>-<n>`), so the suffix becomes the
      // copy's own predicted seq and the identity stays self-describing.
      const isRepair = repairIds.has(callId)
      const messageId = isRepair ? 'interrupted-tool-result-' + String(callId) + '-' + String(predicted) : randomUUID()
      let sourceEventSeqs
      if (!isRepair) {
        const remapped = Array.isArray(event.sourceEventSeqs)
          ? event.sourceEventSeqs.map((seq) => copySeqByOriginal.get(seq)).filter((seq) => typeof seq === 'number')
          : []
        if (remapped.length > 0) sourceEventSeqs = remapped
        else if (typeof lastAssistantSeq === 'number') sourceEventSeqs = [lastAssistantSeq]
      }
      writes.push({
        type: 'tool/result',
        surfaceOp: 'append',
        ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
        data: {
          turn: turnMap.get(data.turn),
          step: stepOf(data.turn, data.step),
          message: {
            ...rest,
            id: messageId,
            content: message.content ?? [],
            source: spliceSource(message.source, spliceId, event.seq),
          },
          ...(data.error === undefined ? {} : { error: data.error }),
          ...(data.meta === undefined ? {} : { meta: data.meta }),
        },
      })
      seqOf()
      continue
    }
    // system/message and every log-only record are skipped on purpose.
  }
  return writes
}
