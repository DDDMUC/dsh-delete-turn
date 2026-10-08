import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PLUGIN_ID,
  PlanError,
  contentEditPairs,
  deletableReplyTurns,
  foldSurface,
  hiddenEntries,
  isBusy,
  messageIdOf,
  planRange,
  sourceOwnsPlugin,
  turnableSeqs,
} from '../src/logic.js'

let clock = 0
function event(seq, type, data, extra = {}) {
  clock += 1
  return { type, seq, time: clock, data, ...extra }
}

function userMessage(seq, id, source = { kind: 'user' }) {
  return event(seq, 'user/message', { id, role: 'user', content: [{ type: 'text', text: id }], source }, { surfaceOp: 'append' })
}

function assistantMessage(seq, id, turn, step, extraData = {}) {
  return event(
    seq,
    'assistant/message',
    {
      turn,
      step,
      message: { id, role: 'assistant', content: [{ type: 'text', text: id }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
      ...extraData,
    },
    { surfaceOp: 'append' },
  )
}

function toolResult(seq, id, turn, step, callId, extra = {}) {
  return event(
    seq,
    'tool/result',
    {
      turn,
      step,
      message: { id, role: 'user', content: [{ type: 'tool_result', toolCallId: callId }], source: { kind: 'tool', callId } },
    },
    { surfaceOp: 'append', ...extra },
  )
}

function systemMessage(seq, id, turn, step) {
  return event(
    seq,
    'system/message',
    { turn, step, message: { id, role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'plugin', plugin: 'x' } } },
    { surfaceOp: 'append' },
  )
}

function deletionReplacement(seq, shadowed, source = { kind: 'plugin', plugin: PLUGIN_ID }) {
  return event(
    seq,
    'user/message',
    {
      id: `del-${seq}`,
      role: 'user',
      content: [{ type: 'text', text: '\u200b' }],
      source,
    },
    { surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] }, sourceEventSeqs: shadowed },
  )
}

// Session format v4 canonicalization flattens plugin sources to `plugin:<name>`.
const V4_SOURCE = { kind: `plugin:${PLUGIN_ID}` }

function baseLog() {
  clock = 0
  return [
    event(0, 'permission/preset', {}),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'step/start', { turn: 1, step: 1 }),
    systemMessage(3, 'sys-1', 1, 1),
    userMessage(4, 'u-1'),
    userMessage(5, 'ctx-1', { kind: 'plugin', plugin: 'dsh-system-prompt' }),
    assistantMessage(6, 'a-1', 1, 1),
    toolResult(7, 't-1', 1, 1, 'call-1'),
    assistantMessage(8, 'a-2', 1, 2),
    event(9, 'step/end', { turn: 1, step: 2 }),
    event(10, 'turn/end', { turn: 1 }),
    event(11, 'turn/start', { turn: 2 }),
    userMessage(12, 'u-2'),
    assistantMessage(13, 'a-3', 2, 1),
    event(14, 'turn/end', { turn: 2 }),
  ]
}

test('foldSurface follows append and replace operations', () => {
  const log = baseLog()
  const first = foldSurface(log)
  assert.deepEqual(first.nodes, [3, 4, 5, 6, 7, 8, 12, 13])
  assert.equal(first.replacements.length, 0)

  // A replacement occupies the shadowed window's position, not the tail.
  const replacement = deletionReplacement(15, [5], 'message')
  const second = foldSurface([...log, replacement])
  assert.deepEqual(second.nodes, [3, 4, 15, 6, 7, 8, 12, 13])
  assert.deepEqual(second.replacements, [{ seq: 15, startSeq: 5, endSeq: 5, shadowed: [5] }])
})

test('hiddenEntries infers the deletion mode and ignores foreign producers', () => {
  const step = hiddenEntries([...baseLog(), deletionReplacement(15, [6, 7])])
  assert.deepEqual(step, [
    { seq: 6, mode: 'step', replacement: 15 },
    { seq: 7, mode: 'step', replacement: 15 },
  ])

  const message = hiddenEntries([...baseLog(), deletionReplacement(15, [5])])
  assert.deepEqual(message, [{ seq: 5, mode: 'message', replacement: 15 }])

  // A reply window holds no human prompt and no single step.
  const reply = hiddenEntries([...baseLog(), deletionReplacement(15, [6, 7, 8])])
  assert.deepEqual(reply, [
    { seq: 6, mode: 'reply', replacement: 15 },
    { seq: 7, mode: 'reply', replacement: 15 },
    { seq: 8, mode: 'reply', replacement: 15 },
  ])

  // A window carrying the turn's own human prompt is a whole-turn delete.
  const turn = hiddenEntries([...baseLog(), deletionReplacement(15, [4, 5, 6, 7, 8])])
  assert.deepEqual(turn, [
    { seq: 4, mode: 'turn', replacement: 15 },
    { seq: 5, mode: 'turn', replacement: 15 },
    { seq: 6, mode: 'turn', replacement: 15 },
    { seq: 7, mode: 'turn', replacement: 15 },
    { seq: 8, mode: 'turn', replacement: 15 },
  ])

  // A replacement landed by any other producer is ignored.
  const foreign = event(
    18,
    'user/message',
    {
      id: 'compact-1',
      role: 'user',
      content: [{ type: 'text', text: 'compacted' }],
      source: { kind: 'plugin', plugin: 'compact' },
    },
    { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] },
  )
  assert.deepEqual(hiddenEntries([...baseLog(), foreign]), [])
})

test('message plan replaces exactly the addressed user message', () => {
  const log = baseLog()
  const nodes = foldSurface(log).nodes
  assert.deepEqual(planRange(log, nodes, { mode: 'message', seq: 4 }), {
    mode: 'message',
    targetSeq: 4,
    startSeq: 4,
    endSeq: 4,
    shadowed: [4],
    turn: 1,
    step: 0,
  })
  assert.throws(() => planRange(log, nodes, { mode: 'message', seq: 6 }), (error) => error instanceof PlanError && error.code === 'not-deletable')
})

test('step plan groups the assistant message with its tool results', () => {
  const log = baseLog()
  const nodes = foldSurface(log).nodes
  const plan = planRange(log, nodes, { mode: 'step', seq: 7 })
  assert.deepEqual(plan.shadowed, [6, 7])
  assert.equal(plan.startSeq, 6)
  assert.equal(plan.endSeq, 7)
  assert.equal(plan.turn, 1)
  assert.equal(plan.step, 1)
})

test('reply plan keeps the human prompt and removes the rest of the turn', () => {
  const log = baseLog()
  const nodes = foldSurface(log).nodes
  const plan = planRange(log, nodes, { mode: 'reply', seq: 8 })
  assert.deepEqual(plan.shadowed, [5, 6, 7, 8])
  assert.equal(plan.turn, 1)
  assert.equal(plan.step, 2)

  const second = planRange(log, nodes, { mode: 'reply', messageId: 'a-3' })
  assert.deepEqual(second.shadowed, [13])
  assert.equal(second.turn, 2)
})

test('planning a shadowed target reports already-deleted', () => {
  const log = [...baseLog(), deletionReplacement(15, [4], 'message')]
  const nodes = foldSurface(log).nodes
  assert.throws(() => planRange(log, nodes, { mode: 'message', seq: 4 }), (error) => error instanceof PlanError && error.code === 'already-deleted')
})

test('reply plan ignores the protected system head when the human prompt is gone', () => {
  // The human prompt (seq 4) is deleted first; without the head guard the
  // system node (seq 3, appended inside step 1) would anchor the window and
  // make the placeholder between it and the reply look like foreign content.
  const log = [...baseLog(), deletionReplacement(15, [4], 'message')]
  const nodes = foldSurface(log).nodes
  assert.deepEqual(nodes, [3, 15, 5, 6, 7, 8, 12, 13])
  const plan = planRange(log, nodes, { mode: 'reply', seq: 8 })
  assert.deepEqual(plan.shadowed, [5, 6, 7, 8])
  assert.equal(plan.turn, 1)
})

test('a reply window may shadow this plugin own placeholders', () => {
  const log = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'step/start', { turn: 1, step: 1 }),
    systemMessage(2, 'sys-1', 1, 1),
    userMessage(3, 'u-1'),
    assistantMessage(4, 'a-1', 1, 1),
    userMessage(5, 'ctx-1', { kind: 'plugin', plugin: 'other-plugin' }),
    toolResult(6, 't-1', 1, 1, 'call-1'),
    event(7, 'turn/end', { turn: 1 }),
  ]
  const withPlaceholder = [...log, deletionReplacement(8, [5])]
  const nodes = foldSurface(withPlaceholder).nodes
  assert.deepEqual(nodes, [2, 3, 4, 8, 6])
  const plan = planRange(withPlaceholder, nodes, { mode: 'reply', seq: 4 })
  assert.deepEqual(plan.shadowed, [4, 8, 6])
})

test('a foreign node inside the window still refuses the plan', () => {
  const log = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'step/start', { turn: 1, step: 1 }),
    systemMessage(2, 'sys-1', 1, 1),
    userMessage(3, 'u-1'),
    assistantMessage(4, 'a-1', 1, 1),
    userMessage(5, 'ctx-1', { kind: 'plugin', plugin: 'other-plugin' }),
    toolResult(6, 't-1', 1, 1, 'call-1'),
    event(7, 'turn/end', { turn: 1 }),
  ]
  // A compaction checkpoint replacing the context row: not this plugin's
  // placeholder, so the reply window must refuse to shadow it silently.
  const foreign = event(
    8,
    'user/message',
    { id: 'compact-1', role: 'user', content: [{ type: 'text', text: 'compacted' }], source: { kind: 'plugin', plugin: 'compact' } },
    { surfaceOp: { op: 'replace', startSeq: 5, endSeq: 5 }, sourceEventSeqs: [5] },
  )
  const withForeign = [...log, foreign]
  const nodes = foldSurface(withForeign).nodes
  assert.deepEqual(nodes, [2, 3, 4, 8, 6])
  assert.throws(() => planRange(withForeign, nodes, { mode: 'reply', seq: 4 }), (error) => error instanceof PlanError && error.code === 'range-not-clean')
})

test('deletableReplyTurns skips turns with no reply content left', () => {
  const log = baseLog()
  const nodes = foldSurface(log).nodes
  assert.deepEqual(deletableReplyTurns(log, nodes), [1, 2])

  // A compaction checkpoint over the whole first turn leaves its transcript
  // rows in place but removes every deletable node from the surface.
  const compaction = event(
    15,
    'user/message',
    { id: 'compact-1', role: 'user', content: [{ type: 'text', text: 'compacted' }], source: { kind: 'plugin', plugin: 'compact' } },
    { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 8 }, sourceEventSeqs: [3, 4, 5, 6, 7, 8] },
  )
  const compacted = [...log, compaction]
  assert.deepEqual(deletableReplyTurns(compacted, foldSurface(compacted).nodes), [2])

  // A turn holding only the human prompt has nothing to delete either.
  const promptOnly = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'step/start', { turn: 1, step: 1 }),
    systemMessage(2, 'sys-1', 1, 1),
    userMessage(3, 'u-1'),
    event(4, 'turn/end', { turn: 1 }),
  ]
  assert.deepEqual(deletableReplyTurns(promptOnly, foldSurface(promptOnly).nodes), [])
})

test('the ledger recognizes the v4 flattened plugin source', () => {
  assert.equal(sourceOwnsPlugin({ kind: 'plugin', plugin: PLUGIN_ID }), true)
  assert.equal(sourceOwnsPlugin({ kind: `plugin:${PLUGIN_ID}` }), true)
  assert.equal(sourceOwnsPlugin({ kind: 'system-prompt', plugin: PLUGIN_ID }), true)
  assert.equal(sourceOwnsPlugin({ kind: 'system-prompt' }), false)
  assert.equal(sourceOwnsPlugin({ kind: 'plugin', plugin: 'somebody-else' }), false)
  assert.equal(sourceOwnsPlugin({ kind: 'plugin:somebody-else' }), false)

  const log = [...baseLog(), deletionReplacement(15, [4], V4_SOURCE)]
  assert.deepEqual(hiddenEntries(log), [{ seq: 4, mode: 'message', replacement: 15 }])

  // A window may shadow an own placeholder in either source shape: the carrier
  // sits between the injected context (5) and the reply nodes (7, 8).
  const withPlaceholder = [...baseLog(), deletionReplacement(15, [6], V4_SOURCE)]
  const placeholderNodes = foldSurface(withPlaceholder).nodes
  assert.deepEqual(placeholderNodes, [3, 4, 5, 15, 7, 8, 12, 13])
  const plan = planRange(withPlaceholder, placeholderNodes, { mode: 'reply', seq: 8 })
  assert.deepEqual(plan.shadowed, [5, 15, 7, 8])
})

test('isBusy tracks open turns and compaction brackets', () => {
  const closed = baseLog()
  assert.equal(isBusy(closed), false)
  const open = [...closed, event(15, 'turn/start', { turn: 3 })]
  assert.equal(isBusy(open), true)
  const compacting = [...closed, event(15, 'compaction/start', { compactionId: 'c' })]
  assert.equal(isBusy(compacting), true)
})

test('messageIdOf reads each surface event shape', () => {
  const log = baseLog()
  assert.equal(messageIdOf(log[4]), 'u-1')
  assert.equal(messageIdOf(log[6]), 'a-1')
  assert.equal(messageIdOf(log[7]), 't-1')
  assert.equal(messageIdOf(log[3]), 'sys-1')
})

test('contentEditPairs exposes an in-place message rewrite', () => {
  const edit = event(
    15,
    'user/message',
    {
      id: 'u-1-edited',
      role: 'user',
      content: [{ type: 'text', text: 'u-1 (edited)' }],
      source: { kind: 'plugin:dsh-edit-turn', editedBy: 'dsh-edit-turn' },
    },
    { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] },
  )
  const log = [...baseLog(), edit]
  const folded = foldSurface(log)
  assert.deepEqual(folded.nodes, [3, 15, 5, 6, 7, 8, 12, 13])
  assert.deepEqual(contentEditPairs(folded, log), [[4, 15]])

  // Chains compose: a second edit of the replacement yields its own pair.
  const again = event(
    20,
    'user/message',
    {
      id: 'u-1-edited-again',
      role: 'user',
      content: [{ type: 'text', text: 'u-1 (edited twice)' }],
      source: { kind: 'plugin:dsh-edit-turn', editedBy: 'dsh-edit-turn' },
    },
    { surfaceOp: { op: 'replace', startSeq: 15, endSeq: 15 }, sourceEventSeqs: [15] },
  )
  const twice = [...log, again]
  assert.deepEqual(contentEditPairs(foldSurface(twice), twice), [[4, 15], [15, 20]])
})

test('contentEditPairs ignores rollbacks, compaction checkpoints and own deletions', () => {
  const rollback = event(
    15,
    'user/message',
    { id: 'rb', role: 'user', content: [{ type: 'text', text: 'rb' }], source: { kind: 'plugin:dsh-edit-turn' } },
    { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 13 }, sourceEventSeqs: [4, 5, 6, 7, 8, 12, 13] },
  )
  const rollbackLog = [...baseLog(), rollback]
  assert.deepEqual(contentEditPairs(foldSurface(rollbackLog), rollbackLog), [])

  const compaction = event(
    15,
    'user/message',
    { id: 'cp', role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'compact-checkpoint' } },
    { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] },
  )
  const compactLog = [...baseLog(), compaction]
  assert.deepEqual(contentEditPairs(foldSurface(compactLog), compactLog), [])

  const own = deletionReplacement(15, [4])
  const ownLog = [...baseLog(), own]
  assert.deepEqual(contentEditPairs(foldSurface(ownLog), ownLog), [])
})

// --- turn: delete one whole turn as a single range replace -------------------

// A four-turn log: turn 2 carries an injected context row, turn 3 a complete
// tool pair, turn 4 a re-injected system message (which never travels).
function fourTurnLog() {
  clock = 0
  return [
    event(0, 'permission/preset', {}),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'step/start', { turn: 1, step: 1 }),
    systemMessage(3, 'sys-1', 1, 1),
    userMessage(4, 'u-1'),
    assistantMessage(5, 'a-1', 1, 1),
    event(6, 'step/end', { turn: 1, step: 1 }),
    event(7, 'turn/end', { turn: 1 }),
    event(8, 'turn/start', { turn: 2 }),
    event(9, 'step/start', { turn: 2, step: 1 }),
    userMessage(10, 'u-2'),
    userMessage(11, 'ctx-2', { kind: 'plugin', plugin: 'dsh-system-prompt' }),
    assistantMessage(12, 'a-2', 2, 1),
    event(13, 'step/end', { turn: 2, step: 1 }),
    event(14, 'turn/end', { turn: 2 }),
    event(15, 'turn/start', { turn: 3 }),
    event(16, 'step/start', { turn: 3, step: 1 }),
    userMessage(17, 'u-3'),
    assistantMessage(18, 'a-3', 3, 1),
    event(19, 'tool/call', { turn: 3, step: 1, callId: 'call-3', name: 'run_code', arguments: '{}' }),
    toolResult(20, 't-3', 3, 1, 'call-3'),
    event(21, 'step/end', { turn: 3, step: 1 }),
    event(22, 'turn/end', { turn: 3 }),
    event(23, 'turn/start', { turn: 4 }),
    event(24, 'step/start', { turn: 4, step: 1 }),
    systemMessage(25, 'sys-4', 4, 1),
    userMessage(26, 'u-4'),
    assistantMessage(27, 'a-4', 4, 1),
    event(28, 'step/end', { turn: 4, step: 1 }),
    event(29, 'turn/end', { turn: 4 }),
  ]
}

test('a turn plan replaces every live surface node of the addressed turn', () => {
  const log = fourTurnLog()
  const nodes = foldSurface(log).nodes
  assert.deepEqual(nodes, [3, 4, 5, 10, 11, 12, 17, 18, 20, 25, 26, 27])
  assert.deepEqual(planRange(log, nodes, { mode: 'turn', seq: 10 }), {
    mode: 'turn',
    targetSeq: 10,
    startSeq: 10,
    endSeq: 12,
    shadowed: [10, 11, 12],
    turn: 2,
    step: 1,
  })
})

test('a turn plan is addressable by seq, message id and turn number', () => {
  const log = fourTurnLog()
  const nodes = foldSurface(log).nodes
  const bySeq = planRange(log, nodes, { mode: 'turn', seq: 18 })
  const byId = planRange(log, nodes, { mode: 'turn', messageId: 'a-3' })
  const byTurn = planRange(log, nodes, { mode: 'turn', turn: 4 })
  assert.deepEqual(bySeq.shadowed, [17, 18, 20])
  assert.deepEqual(byId.shadowed, [17, 18, 20])
  assert.deepEqual(byTurn.shadowed, [26, 27])
  assert.equal(bySeq.turn, 3)
  assert.equal(byTurn.turn, 4)
})

test('landing a turn replace leaves every later turn exactly in place', () => {
  const log = fourTurnLog()
  const nodes = foldSurface(log).nodes
  const plan = planRange(log, nodes, { mode: 'turn', seq: 10 })
  const carrier = {
    type: 'user/message',
    seq: 100,
    time: 999,
    data: { id: 'turn-carrier', role: 'user', content: [], source: { kind: `plugin:${PLUGIN_ID}` } },
    surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
    sourceEventSeqs: plan.shadowed,
  }
  const landed = [...log, carrier]
  // The carrier stands where turn 2 stood; turns 3 and 4 are untouched, and no
  // event was appended for them - no replay, no renumbering.
  assert.deepEqual(foldSurface(landed).nodes, [3, 4, 5, 100, 17, 18, 20, 25, 26, 27])
  assert.equal(landed.filter((event) => event.type === 'turn/start').length, 4)
  // The ledger reads the landed window back as a whole-turn delete.
  assert.deepEqual(hiddenEntries(landed), [
    { seq: 10, mode: 'turn', replacement: 100 },
    { seq: 11, mode: 'turn', replacement: 100 },
    { seq: 12, mode: 'turn', replacement: 100 },
  ])
})

test('a turn plan rides over this plugin own placeholder inside its window', () => {
  const log = [...fourTurnLog(), deletionReplacement(30, [11])]
  const nodes = foldSurface(log).nodes
  assert.deepEqual(nodes, [3, 4, 5, 10, 30, 12, 17, 18, 20, 25, 26, 27])
  const plan = planRange(log, nodes, { mode: 'turn', seq: 10 })
  assert.deepEqual(plan.shadowed, [10, 30, 12])
})

test('a turn plan refuses a window holding a foreign node', () => {
  const foreign = event(
    30,
    'user/message',
    { id: 'compact-1', role: 'user', content: [{ type: 'text', text: 'compacted' }], source: { kind: 'plugin:compact' } },
    { surfaceOp: { op: 'replace', startSeq: 11, endSeq: 11 }, sourceEventSeqs: [11] },
  )
  const withForeign = [...fourTurnLog(), foreign]
  assert.throws(
    () => planRange(withForeign, foldSurface(withForeign).nodes, { mode: 'turn', seq: 10 }),
    (error) => error instanceof PlanError && error.code === 'range-not-clean',
  )
  // A SILENT carrier of another plugin (plugin source plus no readable content)
  // carries nothing, so it rides along instead of refusing the window.
  const silent = event(
    30,
    'user/message',
    { id: 'carrier-other', role: 'user', content: [], source: { kind: 'plugin:dsh-rerun-turn' } },
    { surfaceOp: { op: 'replace', startSeq: 11, endSeq: 11 }, sourceEventSeqs: [11] },
  )
  const withCarrier = [...fourTurnLog(), silent]
  const plan = planRange(withCarrier, foldSurface(withCarrier).nodes, { mode: 'turn', seq: 10 })
  assert.deepEqual(plan.shadowed, [10, 30, 12])
})

test('a turn plan cannot remove the turn holding the system prompt head', () => {
  const log = fourTurnLog()
  const nodes = foldSurface(log).nodes
  assert.throws(
    () => planRange(log, nodes, { mode: 'turn', turn: 1 }),
    (error) => error instanceof PlanError && error.code === 'not-deletable',
  )
  assert.throws(
    () => planRange(log, nodes, { mode: 'turn', seq: 3 }),
    (error) => error instanceof PlanError && error.code === 'not-deletable',
  )
})

test('turnableSeqs advertises exactly what the planner accepts', () => {
  const log = fourTurnLog()
  const nodes = foldSurface(log).nodes
  // Every live human prompt except the first turn's (it holds the system head).
  assert.deepEqual(turnableSeqs(log, nodes), [10, 17, 26])
  for (const seq of turnableSeqs(log, nodes)) {
    assert.doesNotThrow(() => planRange(log, nodes, { mode: 'turn', seq }), `advertised seq ${seq} must plan`)
  }
  // The first turn holds the protected system head: no entry, and the route refuses.
  assert.throws(
    () => planRange(log, nodes, { mode: 'turn', seq: 4 }),
    (error) => error instanceof PlanError && error.code === 'not-deletable',
  )
  // An injected context row is not an ANCHOR (the entry lives on prompts) but its
  // turn's window is the same one, so addressing it plans identically.
  assert.equal(turnableSeqs(log, nodes).includes(11), false, 'a context row is not advertised')
  assert.deepEqual(planRange(log, nodes, { mode: 'turn', seq: 11 }).shadowed, planRange(log, nodes, { mode: 'turn', seq: 10 }).shadowed)
})

test('turnableSeqs withholds only the prompts whose window is blocked', () => {
  const foreign = event(
    30,
    'user/message',
    { id: 'ctx-foreign', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin:other' } },
    { surfaceOp: { op: 'replace', startSeq: 11, endSeq: 11 }, sourceEventSeqs: [11] },
  )
  const withForeign = [...fourTurnLog(), foreign]
  assert.deepEqual(turnableSeqs(withForeign, foldSurface(withForeign).nodes), [17, 26])
})
