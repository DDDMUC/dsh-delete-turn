import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { apply } from '../src/index.js'
import { foldSurface, planRange } from '../src/logic.js'

const SESSION_ID = 'session-11111111-1111-1111-1111-111111111111'

// One closed turn whose surface is [system head, human prompt].
function buildEvents() {
  return [
    { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 2, type: 'step/start', data: { turn: 1, step: 1 } },
    {
      seq: 2,
      time: 3,
      type: 'system/message',
      data: { turn: 1, step: 1, message: { id: 'sys-1', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'plugin', plugin: 'test' } } },
      surfaceOp: 'append',
    },
    {
      seq: 3,
      time: 4,
      type: 'user/message',
      data: { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    { seq: 4, time: 5, type: 'turn/end', data: { turn: 1 } },
  ]
}

function harness(events, options = {}) {
  const calls = { appends: [], routes: new Map() }
  const session = {
    surface: { nodes: foldSurface(events).nodes },
    append(type, data, intent) {
      if (options.failOn === type) throw new Error('the surface refused')
      const entry = { type, data, intent }
      calls.appends.push(entry)
      return { seq: events.length, time: 99, type, data, ...intent }
    },
  }
  const webServer = {
    register(spec) {
      calls.routes.set(spec.path, spec)
      return () => {}
    },
  }
  const ctx = {
    effect(fn) {
      return fn()
    },
    inject() {},
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'sessions') return { get: () => session, flush: async () => true }
      if (name === 'sessionQuery') return { readSession: async () => ({ events }) }
      return undefined
    },
  }
  return { ctx, calls }
}

function fakeReq(body) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/dsh-delete-turn/delete'
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code
    },
    end(payload) {
      this.body = payload
    },
  }
}

test('the delete route appends a single turn-less carrier', async () => {
  const events = buildEvents()
  const { ctx, calls } = harness(events)
  apply(ctx)
  const route = calls.routes.get('/dsh-delete-turn/delete')
  assert.ok(route, 'the delete route must be registered')

  const res = fakeRes()
  await route.handler(fakeReq({ sessionId: SESSION_ID, mode: 'message', seq: 3 }), res)
  const payload = JSON.parse(res.body)

  assert.equal(res.statusCode, 200)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.hidden, [{ seq: 3, mode: 'message' }])

  // A synthetic turn+step must never be opened here: the agent loop counts only
  // the turns it opens itself, so the next real turn would reuse the number and
  // corrupt the log. The carrier is a turn-less user/message holding a single
  // zero-width space (empty content is gateway-rejected).
  assert.equal(calls.appends.length, 1)
  const [carrier] = calls.appends
  assert.equal(carrier.type, 'user/message')
  assert.deepEqual(carrier.data.content, [{ type: 'text', text: '\u200b' }])
  assert.deepEqual(carrier.data.source, { kind: 'plugin:dsh-delete-turn' })
  assert.deepEqual(carrier.intent.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 })
  assert.deepEqual(carrier.intent.sourceEventSeqs, [3])
  assert.equal(payload.replacementSeq, 5)
})

test('an own carrier on the surface can be deleted again with mode message', () => {
  const carrier = {
    seq: 5,
    time: 6,
    type: 'user/message',
    data: { id: 'del-1', role: 'user', content: [{ type: 'text', text: '[deleted]' }], source: { kind: 'plugin', plugin: 'dsh-delete-turn' } },
    surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
    sourceEventSeqs: [3],
  }
  const events = [...buildEvents(), carrier]
  const nodes = foldSurface(events).nodes
  assert.deepEqual(nodes, [2, 5])
  const plan = planRange(events, nodes, { mode: 'message', seq: 5 })
  assert.deepEqual(plan.shadowed, [5])
})

function fakeGet(url) {
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = url
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { host: '127.0.0.1:3080', accept: 'application/json' }
  return req
}

test('the state route reports deletion bookkeeping turns', async () => {
  const carrier = {
    seq: 5,
    time: 6,
    type: 'system/message',
    data: {
      turn: 2,
      step: 1,
      message: { id: 'del-1', role: 'system', content: [], source: { kind: 'system-prompt', plugin: 'dsh-delete-turn' } },
    },
    surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
    sourceEventSeqs: [3],
  }
  const events = [...buildEvents(), carrier]
  const { ctx, calls } = harness(events)
  apply(ctx)
  const route = calls.routes.get('/dsh-delete-turn/state')
  assert.ok(route, 'the state route must be registered')

  const res = fakeRes()
  await route.handler(fakeGet(`/dsh-delete-turn/state?sessionId=${SESSION_ID}`), res)
  const payload = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(payload.hidden, [{ seq: 3, mode: 'message', replacement: 5 }])
  assert.deepEqual(payload.markerTurns, [2])
})

// --- the turn route ----------------------------------------------------------

// Four closed turns: A, B (with an injected context row), C, D. Deleting turn B
// shadows only B's live nodes; C and D stay exactly where they are.
function turnEvents() {
  const rows = []
  const push = (seq, type, data, extra) => rows.push({ seq, time: seq + 1, type, data, ...(extra || {}) })
  const user = (seq, id) => push(seq, 'user/message', { id, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  const context = (seq, id) => push(seq, 'user/message', { id, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'plugin:dsh-system-prompt' } }, { surfaceOp: 'append' })
  const reply = (seq, id, turn) => push(seq, 'assistant/message', { turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text: id }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, { surfaceOp: 'append' })
  let seq = 0
  for (const [turn, prompt, injected] of [[1, 'A', false], [2, 'B', true], [3, 'C', false], [4, 'D', false]]) {
    push(seq++, 'turn/start', { turn })
    push(seq++, 'step/start', { turn, step: 1 })
    user(seq++, `u-${turn}`)
    if (injected) context(seq++, `ctx-${turn}`)
    reply(seq++, `a-${turn}`, turn)
    push(seq++, 'step/end', { turn, step: 1 })
    push(seq++, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
  return rows
}

// A session whose log grows with every append (the real one's seq contract).
function turnHarness(events, options = {}) {
  const calls = { appends: [], routes: new Map() }
  const log = [...events]
  const session = {
    get seq() {
      return log.length
    },
    get surface() {
      return { nodes: foldSurface(log).nodes }
    },
    snapshotEvents() {
      return log
    },
    append(type, data, intent) {
      if (options.failOn === type) throw new Error('the surface refused')
      calls.appends.push({ type, data, intent })
      const landed = { seq: log.length, time: 99, type, data, ...(intent || {}) }
      log.push(landed)
      return landed
    },
  }
  const webServer = { register(spec) { calls.routes.set(spec.path, spec); return () => {} } }
  const ctx = {
    effect: (fn) => fn(),
    inject() {},
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'sessions') return { get: () => session, flush: async () => true }
      if (name === 'sessionQuery') return { readSession: async () => ({ events: log }) }
      return undefined
    },
  }
  return { ctx, calls, session, log }
}

async function postDelete(harness, body) {
  apply(harness.ctx)
  const route = harness.calls.routes.get('/dsh-delete-turn/delete')
  assert.ok(route, 'the delete route must be registered')
  const res = fakeRes()
  await route.handler(fakeReq(body), res)
  return { status: res.statusCode, payload: JSON.parse(res.body) }
}

test('the turn route lands one carrier and leaves the later turns in place', async () => {
  const events = turnEvents()
  const harness = turnHarness(events)
  const before = foldSurface(events).nodes
  const { status, payload } = await postDelete(harness, { sessionId: SESSION_ID, mode: 'turn', turn: 2 })

  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.deepEqual(before, [2, 3, 8, 9, 10, 15, 16, 21, 22])
  assert.deepEqual(payload.hidden, [
    { seq: 8, mode: 'turn' },
    { seq: 9, mode: 'turn' },
    { seq: 10, mode: 'turn' },
  ])

  // Exactly one write: the turn-less carrier. No turn border, no copy of C or D.
  assert.equal(harness.calls.appends.length, 1)
  const [carrier] = harness.calls.appends
  assert.equal(carrier.type, 'user/message')
  assert.equal(carrier.data.turn, undefined, 'the carrier never opens a turn')
  assert.deepEqual(carrier.data.source, { kind: 'plugin:dsh-delete-turn' })
  assert.deepEqual(carrier.intent.surfaceOp, { op: 'replace', startSeq: 8, endSeq: 10 })
  assert.deepEqual(carrier.intent.sourceEventSeqs, [8, 9, 10])
  assert.equal(payload.replacementSeq, 25)

  // The folded surface after landing: A, the carrier, then C and D untouched.
  assert.deepEqual(foldSurface(harness.log).nodes, [2, 3, 25, 15, 16, 21, 22])
})

test('the turn route refuses a busy session, an unknown mode and the head turn', async () => {
  const busy = [...turnEvents(), { seq: 99, time: 99, type: 'turn/start', data: { turn: 5 } }]
  const busyHarness = turnHarness(busy)
  const refused = await postDelete(busyHarness, { sessionId: SESSION_ID, mode: 'turn', turn: 2 })
  assert.equal(refused.status, 409)
  assert.equal(refused.payload.code, 'busy')
  assert.equal(busyHarness.calls.appends.length, 0, 'a busy session is never written')

  const idleHarness = turnHarness(turnEvents())
  const invalid = await postDelete(idleHarness, { sessionId: SESSION_ID, mode: 'turnify', turn: 2 })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.payload.code, 'invalid')
  assert.equal(idleHarness.calls.appends.length, 0)

  // The first surface node belongs to turn 1: that turn may not be removed.
  const headHarness = turnHarness(turnEvents())
  const head = await postDelete(headHarness, { sessionId: SESSION_ID, mode: 'turn', turn: 1 })
  assert.equal(head.status, 400)
  assert.equal(head.payload.code, 'not-deletable')
})

test('a refused carrier write is reported as stale and nothing lands', async () => {
  const harness = turnHarness(turnEvents(), { failOn: 'user/message' })
  const { status, payload } = await postDelete(harness, { sessionId: SESSION_ID, mode: 'turn', turn: 2 })
  assert.equal(status, 409)
  assert.equal(payload.code, 'stale')
  assert.equal(harness.calls.appends.length, 0, 'the refused append never counted as landed')
})

test('the state route advertises the rows the turn route accepts', async () => {
  const harness = turnHarness(turnEvents())
  apply(harness.ctx)
  const stateRoute = harness.calls.routes.get('/dsh-delete-turn/state')
  assert.ok(stateRoute, 'the state route must be registered')
  const res = fakeRes()
  await stateRoute.handler(fakeGet(`/dsh-delete-turn/state?sessionId=${SESSION_ID}`), res)
  const payload = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  // The surface is [2, 3, 8, 9, 10, 15, 16, 21, 22]; the live human prompts are
  // 2 (the first turn, protected), 8, 15 and 21.
  assert.deepEqual(payload.turnSeqs, [8, 15, 21])
  for (const seq of payload.turnSeqs) {
    const accepted = await postDelete(turnHarness(turnEvents()), { sessionId: SESSION_ID, mode: 'turn', seq })
    assert.equal(accepted.status, 200, `an advertised seq must be accepted: ${seq}`)
  }
})
