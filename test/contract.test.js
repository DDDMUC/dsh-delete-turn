// Contract test against the REAL installed platform validator.
//
// The pure suites prove the planner's arithmetic; this file proves the WRITES
// are legal. It builds real sessions with the official `@deepseek-ai/dsh-session`
// `Session` class, drives the plugin's actual HTTP route against them, and then
// puts the resulting log through the strict cold read the persistence reader
// uses (`sessionFormatCatalog.createRestore` - the v4 vocabulary, relationship
// and lifecycle validators). Two negative controls are asserted too: a window
// that shadows only the deleted turn duplicates the tail, and a replay that
// reuses the original turn numbers is refused by that same validator.
//
// The DSH packages are resolved from the installed platform (see
// tools/dsh-modules.mjs); the plugin itself never imports them.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { loadDshModule } from '../tools/dsh-modules.mjs'
import { apply } from '../src/index.js'
import { buildSpliceReplayWrites, planSplice } from '../src/logic.js'

const { Session, SessionId, SESSION_FORMAT_VERSION } = await loadDshModule('@deepseek-ai/dsh-session')
const { sessionFormatCatalog } = await loadDshModule('@deepseek-ai/dsh-session-format-catalog')

const text = (value) => ({ type: 'text', text: value })

function makeSession() {
  const id = SessionId('session-' + randomUUID())
  const header = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd: '/tmp/dsh-delete-turn-contract',
    delegationDepth: 0,
  }
  return { session: Session.create(id, [], header), header }
}

function plainTurn(session, turn, prompt, reply) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const promptSeq = session.append(
    'user/message',
    { id: randomUUID(), role: 'user', content: [text(prompt)], source: { kind: 'user', rpcId: randomUUID() } },
    { surfaceOp: 'append' },
  ).seq
  const replySeq = session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: { id: randomUUID(), role: 'assistant', content: [text(reply)], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
      usage: { input: 10, output: 2 },
    },
    { surfaceOp: 'append' },
  ).seq
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { promptSeq, replySeq }
}

function toolTurn(session, turn, prompt, reply, callId, result, finalReply) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const promptSeq = session.append(
    'user/message',
    { id: randomUUID(), role: 'user', content: [text(prompt)], source: { kind: 'user', rpcId: randomUUID() } },
    { surfaceOp: 'append' },
  ).seq
  const replySeq = session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [text(reply), { type: 'tool-call', id: callId, name: 'run_code', arguments: '{}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    },
    { surfaceOp: 'append' },
  ).seq
  const callSeq = session.append('tool/call', { turn, step: 1, callId, name: 'run_code', arguments: '{}' }).seq
  session.append(
    'tool/result',
    {
      turn,
      step: 1,
      message: { id: randomUUID(), role: 'tool', toolCallId: callId, content: [text(result)], isError: false, source: { kind: 'tool', callId } },
    },
    { surfaceOp: 'append', sourceEventSeqs: [callSeq] },
  )
  session.append('step/end', { turn, step: 1 })
  session.append('step/start', { turn, step: 2 })
  session.append(
    'assistant/message',
    { turn, step: 2, message: { id: randomUUID(), role: 'assistant', content: [text(finalReply)], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn, step: 2 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { promptSeq, replySeq }
}
// A four-turn conversation: A, B (with an injected context row), C (tool pair), D.
function conversation() {
  const built = makeSession()
  const session = built.session
  plainTurn(session, 1, 'A', 'A1')
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', { id: randomUUID(), role: 'user', content: [text('B')], source: { kind: 'user', rpcId: randomUUID() } }, { surfaceOp: 'append' })
  session.append('user/message', { id: randomUUID(), role: 'user', content: [text('B context')], source: { kind: 'plugin:dsh-system-prompt' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 2, step: 1, message: { id: randomUUID(), role: 'assistant', content: [text('B1')], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  toolTurn(session, 3, 'C', 'C1 working', 'call-c', 'C result', 'C1 final')
  plainTurn(session, 4, 'D', 'D1')
  return built
}

// The strict cold read the persistence reader uses: encode every event through
// the shipped codec and restore it, running the v4 vocabulary, relationship and
// lifecycle validators over the complete artifact.
function coldRead(header, events) {
  const headerValue = sessionFormatCatalog.encodeCurrentHeader(header, 0)
  const restore = sessionFormatCatalog.createRestore(headerValue, { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  return restore.finish()
}

// What the conversation view draws, derived by the PLATFORM (deriveEventMessage
// over the folded surface): one row per visible message. `hide` names the rows
// the transcript hides - the client hides the replacement carrier's own row
// through the ledger's replacement -> shadowed link (hiddenVia) - so the rows
// without it are exactly what the user sees.
function visibleShape(session, hide = new Set()) {
  const events = session.snapshotEvents()
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const rows = []
  for (const seq of session.surface.nodes) {
    if (hide.has(seq)) continue
    const event = bySeq.get(seq)
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    const body = Array.isArray(message.content) ? message.content : []
    const value = body.filter((block) => block && block.type === 'text').map((block) => block.text).join(' ').trim()
    if (value === '') continue
    rows.push(message.role + ':' + value)
  }
  return rows
}

const SPLICE_SHAPE = ['user:A', 'assistant:A1', 'user:C', 'assistant:C1 working', 'tool:C result', 'assistant:C1 final', 'user:D', 'assistant:D1']

// Drive the plugin's real route against a real Session.
function routeHarness(session) {
  const routes = new Map()
  const agent = { session, phase: { kind: 'idle', lastTurn: 0 } }
  const ctx = {
    effect: (fn) => fn(),
    inject: () => {},
    get: (name) => {
      if (name === 'webServer') return { register: (spec) => { routes.set(spec.path, spec); return () => {} } }
      if (name === 'sessions') return { get: () => session, flush: async () => true }
      if (name === 'sessionQuery') return { readSession: async () => ({ events: session.snapshotEvents() }) }
      if (name === 'sessionController') return { resolveAgent: async () => ({ agent }) }
      return undefined
    },
  }
  apply(ctx)
  const route = routes.get('/dsh-delete-turn/delete')
  assert.ok(route, 'the delete route registers')
  return async (body) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/dsh-delete-turn/delete'
    req.socket = { remoteAddress: '127.0.0.1' }
    req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
    const res = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code }, end(payload) { this.body = payload } }
    await route.handler(req, res)
    return { status: res.statusCode, payload: JSON.parse(res.body), agent }
  }
}

function replayInto(session, plan, spliceId, transform) {
  session.append(
    'user/message',
    { id: randomUUID(), role: 'user', content: [], source: { kind: 'plugin:dsh-delete-turn', spliceId } },
    { surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq }, sourceEventSeqs: plan.shadowed },
  )
  const writes = buildSpliceReplayWrites(session.snapshotEvents(), plan, spliceId, session.seq)
  for (const write of transform === undefined ? writes : transform(writes)) {
    const opts = write.surfaceOp === undefined ? [] : [{ surfaceOp: write.surfaceOp, ...(write.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: write.sourceEventSeqs }) }]
    session.append(write.type, write.data, ...opts)
  }
}

test('a splice passes the real validator and leaves A, C-prime and D-prime', async () => {
  const { session, header } = conversation()
  const before = [...session.surface.nodes]
  const call = routeHarness(session)
  const response = await call({ sessionId: header.id, mode: 'splice', turn: 2 })
  assert.equal(response.status, 200, JSON.stringify(response.payload))
  assert.equal(response.payload.deletedTurn, 2)
  assert.deepEqual(response.payload.replayTurns, [3, 4])
  assert.equal(response.payload.baseTurn, 5)
  assert.equal(response.payload.sync, 'synced', 'the loop counter was re-pointed at the replay maximum')

  const after = [...session.surface.nodes]
  for (const item of response.payload.hidden) assert.equal(after.includes(item.seq), false, 'seq ' + item.seq + ' left the surface')
  // The folded node sequence: A, the carrier standing where the retired window
  // was, then the copies. The carrier is the one node the fold adds; its own row
  // is the one the transcript hides, so the conversation draws A, C-prime and D-prime.
  assert.deepEqual(after.slice(0, 3), [before[0], before[1], response.payload.replacementSeq])
  assert.deepEqual(visibleShape(session, new Set([response.payload.replacementSeq])), SPLICE_SHAPE, 'the conversation view is A, C-prime and D-prime')
  assert.equal(visibleShape(session).length, SPLICE_SHAPE.length + 1, 'the only extra derived row is the carrier itself')
  const carrier = session.snapshotEvents()[response.payload.replacementSeq]
  assert.equal(carrier.data.turn, undefined, 'the carrier is turn-less')
  assert.equal(
    carrier.data.content.length === 0 || (carrier.data.content.length === 1 && carrier.data.content[0].text === '\u200b'),
    true,
    'the carrier carries no readable text',
  )
  assert.ok(after.length < before.length, 'the deleted turn and its context row are gone')

  const events = session.snapshotEvents()
  const copies = events.filter((event) => {
    const source = event.type === 'user/message' ? event.data.source : event.data.message && event.data.message.source
    return source && source.spliceId === response.payload.spliceId
  })
  const copyTurns = [...new Set(copies.filter((event) => event.type === 'assistant/message').map((event) => event.data.turn))].sort((a, b) => a - b)
  assert.deepEqual(copyTurns, [5, 6], 'the copies carry the fresh numbers the format requires')
  assert.deepEqual(copies.filter((event) => event.type === 'tool/result').map((event) => event.sourceEventSeqs.length), [1], 'a copied result cites the copied call')
  assert.equal(events.some((event) => event.type === 'assistant/message' && event.data.usage !== undefined && event.data.turn >= 5), false, 'usage is not replayed')

  // The real validator accepts the whole log, and still does after the loop
  // opens its next turn from the counter the host just synced.
  const artifact = coldRead(header, events)
  assert.equal(artifact.events.length, events.length)
  const reloaded = Session.create(header.id, artifact.events, header)
  assert.deepEqual(visibleShape(reloaded, new Set([response.payload.replacementSeq])), SPLICE_SHAPE, 'the round trip preserves the fold')
  assert.ok(response.agent.phase.lastTurn > 0, 'the loop counter was synced before the next turn')
  plainTurn(reloaded, response.agent.phase.lastTurn + 1, 'E', 'E1')
  coldRead(header, reloaded.snapshotEvents())
})

test('the negative control: a window over the deleted turn alone duplicates the tail', () => {
  const { session, header } = conversation()
  const events = session.snapshotEvents()
  const plan = planSplice(events, [...session.surface.nodes], { mode: 'splice', turn: 2 })
  const turnOf = new Map()
  let current
  for (const event of events) {
    if (event.type === 'turn/start') current = event.data.turn
    if (event.type === 'turn/end') current = undefined
    turnOf.set(event.seq, event.data && typeof event.data.turn === 'number' ? event.data.turn : current)
  }
  // Exactly the mutation this design must never ship: shadow the deleted turn
  // only, then append the replayed copies.
  const ownTurn = plan.shadowed.filter((seq) => turnOf.get(seq) === plan.turn)
  const narrow = { ...plan, startSeq: ownTurn[0], endSeq: ownTurn[ownTurn.length - 1], shadowed: ownTurn }
  const spliceId = randomUUID()
  session.append(
    'user/message',
    { id: randomUUID(), role: 'user', content: [], source: { kind: 'plugin:dsh-delete-turn', spliceId } },
    { surfaceOp: { op: 'replace', startSeq: narrow.startSeq, endSeq: narrow.endSeq }, sourceEventSeqs: narrow.shadowed },
  )
  const writes = buildSpliceReplayWrites(events, plan, spliceId, session.seq)
  for (const write of writes) {
    const opts = write.surfaceOp === undefined ? [] : [{ surfaceOp: write.surfaceOp, ...(write.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: write.sourceEventSeqs }) }]
    session.append(write.type, write.data, ...opts)
  }
  const shape = visibleShape(session)
  assert.deepEqual(shape, [...SPLICE_SHAPE.slice(0, 2), ...SPLICE_SHAPE.slice(2), ...SPLICE_SHAPE.slice(2)], 'the old C and D are still on the surface, so the copies duplicate them')
  assert.notDeepEqual(shape, SPLICE_SHAPE, 'the acceptance assertion is what catches it - the validator cannot see duplicates')
  // The duplicated log still passes the cold read.
  coldRead(header, session.snapshotEvents())
})

test('the negative control: reusing the original turn numbers is refused', () => {
  const { session, header } = conversation()
  const events = session.snapshotEvents()
  const plan = planSplice(events, [...session.surface.nodes], { mode: 'splice', turn: 2 })
  const numbers = new Map(plan.replayTurns.map((turn, index) => [plan.baseTurn + index, turn]))
  replayInto(session, plan, randomUUID(), (writes) =>
    writes.map((write) => (write.data && numbers.has(write.data.turn) ? { ...write, data: { ...write.data, turn: numbers.get(write.data.turn) } } : write)),
  )
  assert.throws(
    () => coldRead(header, session.snapshotEvents()),
    (error) => /turn\/start does not open the expected turn/.test(String(error.message)),
  )
})
