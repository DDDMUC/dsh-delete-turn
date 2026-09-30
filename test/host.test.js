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
