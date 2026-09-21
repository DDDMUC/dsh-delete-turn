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

function harness(events) {
  const calls = { appended: null, routes: new Map() }
  const session = {
    surface: { nodes: foldSurface(events).nodes },
    append(type, data, intent) {
      calls.appended = { type, data, intent }
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

test('the delete route appends a non-empty marker carrier', async () => {
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
  assert.equal(calls.appended.type, 'user/message')
  assert.deepEqual(calls.appended.data.content, [{ type: 'text', text: '[deleted]' }])
  assert.equal(calls.appended.data.content.length > 0, true)
  assert.deepEqual(calls.appended.intent.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 })
  assert.deepEqual(calls.appended.intent.sourceEventSeqs, [3])
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
