import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PLUGIN_ID,
  PlanError,
  deletableReplyTurns,
  foldSurface,
  hiddenEntries,
  isBusy,
  messageIdOf,
  planRange,
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

function toolResult(seq, id, turn, step, callId) {
  return event(
    seq,
    'tool/result',
    {
      turn,
      step,
      message: { id, role: 'user', content: [{ type: 'tool_result', toolCallId: callId }], source: { kind: 'tool', callId } },
    },
    { surfaceOp: 'append' },
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

function deletionReplacement(seq, shadowed) {
  return event(
    seq,
    'user/message',
    {
      id: `del-${seq}`,
      role: 'user',
      content: [],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    },
    { surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] }, sourceEventSeqs: shadowed },
  )
}

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
  const log = baseLog()
  const step = deletionReplacement(15, [6, 7])
  const message = deletionReplacement(16, [5])
  const reply = deletionReplacement(17, [12, 13])
  const foreign = event(
    18,
    'user/message',
    {
      id: 'compact-1',
      role: 'user',
      content: [],
      source: { kind: 'plugin', plugin: 'compact' },
    },
    { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] },
  )
  const entries = hiddenEntries([...log, step, message, reply, foreign])
  assert.deepEqual(entries, [
    { seq: 6, mode: 'step', replacement: 15 },
    { seq: 7, mode: 'step', replacement: 15 },
    { seq: 5, mode: 'message', replacement: 16 },
    { seq: 12, mode: 'reply', replacement: 17 },
    { seq: 13, mode: 'reply', replacement: 17 },
  ])
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
  const withPlaceholder = [...log, deletionReplacement(8, [5], 'message')]
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
    { id: 'compact-1', role: 'user', content: [], source: { kind: 'plugin', plugin: 'compact' } },
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
    { id: 'compact-1', role: 'user', content: [], source: { kind: 'plugin', plugin: 'compact' } },
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
