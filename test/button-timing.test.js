// Delete-button timing: the scenarios that decide when the action appears.
//
// These are the gate conditions behind `applyDom` / `rowDeletable` in the
// browser half, each paired with what the host actually does when the button is
// clicked. A scenario where the button appears but the host refuses is a false
// button; one where the host would accept but no button appears is a missing
// button. Both are asserted here so the timing contract is explicit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { foldSurface, planRange, deletableReplyTurns, isBusy } from '../src/logic.js'

// Only the four official surface types ever carry `surfaceOp` in a real log;
// lifecycle events (turn/start, step/start, ...) never do. Getting this wrong
// is what makes a hand-built fixture disagree with a recorded session.
const SURFACE = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])
const ev = (seq, type, data, extra = {}) =>
  SURFACE.has(type) ? { seq, type, data, surfaceOp: 'append', ...extra } : { seq, type, data, ...extra }
const sys = (seq, id, turn, step) =>
  ev(seq, 'system/message', { message: { id, role: 'system', content: [{ type: 'text', text: 's' }], turn, step } })
const user = (seq, id, turn) =>
  ev(seq, 'user/message', { id, role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
const asst = (seq, id, turn, step) =>
  ev(seq, 'assistant/message', { message: { id, role: 'assistant', content: [{ type: 'text', text: 'a' }], turn, step } })

/** A settled turn: prompt plus one answered step, closed. */
function closedTurn() {
  return [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'step/start', { turn: 1, step: 1 }),
    sys(2, 'sys', 1, 1),
    user(3, 'u1', 1),
    asst(4, 'a1', 1, 1),
    ev(5, 'step/end', { turn: 1, step: 1 }),
    ev(6, 'turn/end', { turn: 1 }),
  ]
}

/** True when the client would render a reply delete action for `turn`. */
function buttonShown(events, turn) {
  const folded = foldSurface(events)
  return deletableReplyTurns(events, folded.nodes).includes(turn)
}

/** The host's verdict on the same click. */
function hostVerdict(events, turn) {
  const folded = foldSurface(events)
  try {
    planRange(events, folded.nodes, { mode: 'reply', turn })
    return 'accept'
  } catch (error) {
    return error.code
  }
}

test('a settled turn offers a button, and the host accepts it', () => {
  const log = closedTurn()
  assert.equal(buttonShown(log, 1), true)
  assert.equal(hostVerdict(log, 1), 'accept')
})

test('a prompt-only turn offers no reply button', () => {
  const log = [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'step/start', { turn: 1, step: 1 }),
    sys(2, 'sys', 1, 1),
    user(3, 'u1', 1),
    ev(4, 'turn/end', { turn: 1 }),
  ]
  assert.equal(buttonShown(log, 1), false)
  assert.equal(hostVerdict(log, 1), 'nothing-to-delete')
})

test('a running turn still offers a button, and the busy check happens later', () => {
  // The button deliberately stays visible while a turn is generating: the
  // planner has no opinion on liveness, and the HTTP handler refuses the click
  // with `busy` before it ever reaches planRange.
  const log = closedTurn().slice(0, 5)
  assert.equal(buttonShown(log, 1), true)
  assert.equal(isBusy(log), true)
  assert.equal(hostVerdict(log, 1), 'accept')
})

test('compaction that empties a turn hides the button and refuses the click', () => {
  // The checkpoint carrier replaces the turn's prompt and answer, leaving only
  // the carrier on the surface. No reply content survives, so the timing gate
  // must not offer an action — and the host agrees.
  const log = [
    ...closedTurn(),
    ev(7, 'compaction/start', {}),
    ev(
      8,
      'user/message',
      { id: 'compact', role: 'user', content: [], source: { kind: 'plugin', plugin: 'compact' } },
      { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] },
    ),
    ev(9, 'compaction/end', {}),
  ]
  assert.equal(isBusy(log), false)
  assert.equal(buttonShown(log, 1), false)
  assert.equal(hostVerdict(log, 1), 'not-deletable')
})

test('a foreign empty placeholder placed over a step keeps the reply button', () => {
  // dsh-edit-turn rewrites a step by appending an empty system placeholder and
  // a replacement answer. The placeholder shadows the old node and the new
  // answer is the turn's only remaining reply content, so the action shows and
  // the reply window stays clean.
  const log = [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'step/start', { turn: 1, step: 1 }),
    sys(2, 'sys', 1, 1),
    user(3, 'u1', 1),
    asst(4, 'a1', 1, 1),
    ev(
      5,
      'system/message',
      { turn: 1, step: 1, message: { id: 'edit', role: 'system', content: [], source: { kind: 'plugin:dsh-edit-turn' } } },
      { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 } },
    ),
    asst(6, 'a2', 1, 1),
    ev(7, 'turn/end', { turn: 1 }),
  ]
  assert.equal(buttonShown(log, 1), true)
  assert.equal(hostVerdict(log, 1), 'accept')
})

test('a reply button never appears on a turn the host would refuse', () => {
  // The invariant the timing contract is supposed to guarantee. `not-deletable`
  // is the "no button needed" answer; anything the gate shows must be accepted.
  const compacted = [
    ...closedTurn(),
    ev(7, 'compaction/start', {}),
    ev(
      8,
      'user/message',
      { id: 'compact', role: 'user', content: [], source: { kind: 'plugin', plugin: 'compact' } },
      { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] },
    ),
    ev(9, 'compaction/end', {}),
  ]
  const cases = [
    { label: 'settled', log: closedTurn(), turn: 1 },
    { label: 'compacted', log: compacted, turn: 1 },
  ]
  const violations = []
  for (const c of cases) {
    if (buttonShown(c.log, c.turn) && hostVerdict(c.log, c.turn) !== 'accept') {
      violations.push(`${c.label}: shown but host says ${hostVerdict(c.log, c.turn)}`)
    }
  }
  assert.deepEqual(violations, [], violations.join('; '))
})
