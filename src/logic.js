// dsh-delete-turn - pure session-log logic.
//
// Everything here operates on the plain event JSON read back through the
// host's public sessionQuery service, so the module has no DSH SDK imports and
// runs unchanged under `node --test`. The two central pieces are the official
// surface fold (which nodes the model currently sees, and which earlier nodes a
// replacement shadowed) and the range planner that turns one UI target into a
// canonical, contiguous surface-replace range. A whole-turn delete is just the
// widest range: every live surface node of the addressed turn, replaced by one
// turn-less carrier - no replay, no renumbering, one append.
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
  // A window that carries the turn's own human prompt - and is not the single
  // message shape above - is a whole-turn delete.
  if (members.some((event) => event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user')) return 'turn'
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

  // turn: every live surface node of the addressed turn - the human prompt, its
  // injected context and its whole reply - in ONE range replace. The turn
  // disappears from the model context and the later turns stay exactly where
  // they are; nothing is replayed or renumbered (a plain range replace is all
  // the official surface contract requires).
  if (mode === 'turn') {
    const turn = target.data && typeof target.data.turn === 'number' ? target.data.turn : turnOf.get(targetSeq)
    if (typeof turn !== 'number') throw new PlanError('not-deletable', 'the target does not belong to a turn')
    // Surface node 0 is the system prompt head, appended inside the first step of
    // the first turn. That turn may not be removed as a whole: the head is the
    // one node the official append contract lets nothing but a system/message
    // rewrite, and the head must stay the head.
    const head = bySeq.get(surfaceNodes[0])
    const headTurn = head ? (head.data && typeof head.data.turn === 'number' ? head.data.turn : turnOf.get(surfaceNodes[0])) : undefined
    if (headTurn === turn) throw new PlanError('not-deletable', 'the turn holding the system prompt head cannot be deleted')
    const members = []
    for (const seq of surfaceNodes) {
      const event = bySeq.get(seq)
      // The system prompt head is never reply content (reply mode makes the same
      // exclusion), and it is guarded above.
      if (!event || event.type === 'system/message') continue
      const eventTurn = event.data && typeof event.data.turn === 'number' ? event.data.turn : turnOf.get(seq)
      if (eventTurn !== turn) continue
      members.push(seq)
    }
    if (members.length === 0) throw new PlanError('nothing-to-delete', 'the turn has no surface content left')
    const startIdx = nodeIndex.get(members[0])
    const endIdx = nodeIndex.get(members[members.length - 1])
    const shadowed = surfaceNodes.slice(startIdx, endIdx + 1)
    if (shadowed.some((seq) => !members.includes(seq) && !isOwnPlaceholder(bySeq.get(seq)) && !isSilentPluginCarrier(bySeq.get(seq)))) {
      throw new PlanError('range-not-clean', 'the turn window contains unrelated surface nodes')
    }
    const closing = bySeq.get(members[members.length - 1])
    const step = closing && closing.type === 'assistant/message' && typeof closing.data.step === 'number' ? closing.data.step : 0
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
  if (targetSeq === undefined && (mode === 'reply' || mode === 'turn') && typeof request.turn === 'number') {
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
 * The live human-prompt seqs a whole-turn delete would accept right now.
 *
 * This is the ADVERTISEMENT the state route publishes so a row only offers the
 * action the host will actually accept: every candidate seq is put through the
 * identical {@link planRange} the route plans with, so this list cannot drift
 * from what a click does.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @returns the deletable prompt seqs, in surface order.
 */
export function turnableSeqs(events, surfaceNodes) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const out = []
  for (const seq of surfaceNodes) {
    const event = bySeq.get(seq)
    if (event === undefined || event.type !== 'user/message') continue
    if (!event.data || !event.data.source || event.data.source.kind !== 'user') continue
    try {
      planRange(events, surfaceNodes, { mode: 'turn', seq })
      out.push(seq)
    } catch {
      // A prompt whose turn cannot be removed offers no entry.
    }
  }
  return out
}
