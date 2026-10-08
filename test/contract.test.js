// Contract test against the REAL installed platform validator.
//
// The pure suites prove the planner's arithmetic; this file proves the WRITES
// are legal. It builds real sessions with the official `@deepseek-ai/dsh-session`
// `Session` class, drives the plugin's actual HTTP route against them, and then
// puts the resulting log through the strict cold read the persistence reader
// uses (`sessionFormatCatalog.createRestore` - the v4 vocabulary, relationship
// and lifecycle validators). The whole-turn delete is one ordinary range replace,
// so the contract under test is a single append that leaves the turn numbering
// untouched; the negative control still asks the platform validator to refuse a
// turn number that does not follow the log.
//
// The DSH packages are resolved from the installed platform (see
// tools/dsh-modules.mjs); the plugin itself never imports them.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { loadDshModule } from '../tools/dsh-modules.mjs'
import { apply } from '../src/index.js'

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

// What the conversation view draws after turn B (its prompt, injected context
// and reply) is removed; C and D keep their own rows and their own numbers.
const TURN_SHAPE = ['user:A', 'assistant:A1', 'user:C', 'assistant:C1 working', 'tool:C result', 'assistant:C1 final', 'user:D', 'assistant:D1']

// Drive the plugin's real route against a real Session. No `sessionController`
// is provided on purpose: a whole-turn delete must not need the agent handle
// (the removed splice needed it only to re-point the loop's turn counter).
function routeHarness(session) {
  const routes = new Map()
  const ctx = {
    effect: (fn) => fn(),
    inject: () => {},
    get: (name) => {
      if (name === 'webServer') return { register: (spec) => { routes.set(spec.path, spec); return () => {} } }
      if (name === 'sessions') return { get: () => session, flush: async () => true }
      if (name === 'sessionQuery') return { readSession: async () => ({ events: session.snapshotEvents() }) }
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
    return { status: res.statusCode, payload: JSON.parse(res.body) }
  }
}

test('a whole-turn delete is one range replace and passes the real validator', async () => {
  const { session, header } = conversation()
  const before = [...session.surface.nodes]
  const seqBefore = session.seq
  const call = routeHarness(session)
  const response = await call({ sessionId: header.id, mode: 'turn', turn: 2 })
  assert.equal(response.status, 200, JSON.stringify(response.payload))

  // Turn B's three live nodes - prompt, injected context, reply - in one window.
  assert.equal(response.payload.hidden.length, 3)
  assert.deepEqual(response.payload.hidden.map((item) => item.mode), ['turn', 'turn', 'turn'])
  const shadowed = response.payload.hidden.map((item) => item.seq)
  assert.deepEqual(shadowed, before.slice(2, 5), "the window is exactly turn B's surface nodes")

  // Exactly one event lands: no turn border, no copy of C or D.
  const events = session.snapshotEvents()
  assert.equal(events.length, seqBefore + 1, 'one append and nothing else')
  assert.equal(events.filter((event) => event.type === 'turn/start').length, 4, 'no replayed turn is opened')
  const carrier = events[response.payload.replacementSeq]
  assert.equal(carrier.type, 'user/message')
  assert.equal(carrier.data.turn, undefined, 'the carrier is turn-less')
  assert.equal(
    carrier.data.content.length === 0 || (carrier.data.content.length === 1 && carrier.data.content[0].text === '\u200b'),
    true,
    'the carrier carries no readable text',
  )
  assert.equal(carrier.surfaceOp.op, 'replace')
  const after = [...session.surface.nodes]
  for (const seq of shadowed) assert.equal(after.includes(seq), false, 'seq ' + seq + ' left the surface')
  assert.deepEqual(
    after,
    [before[0], before[1], response.payload.replacementSeq, ...before.slice(5)],
    'the carrier stands where turn B stood; C and D are untouched',
  )

  // The transcript shows A, C and D; the only extra derived row is the carrier.
  assert.deepEqual(visibleShape(session, new Set([response.payload.replacementSeq])), TURN_SHAPE)
  assert.equal(visibleShape(session).length, TURN_SHAPE.length + 1, 'the only extra derived row is the carrier itself')

  // The real validator accepts the whole log and the round trip preserves the fold.
  const artifact = coldRead(header, events)
  assert.equal(artifact.events.length, events.length)
  const reloaded = Session.create(header.id, artifact.events, header)
  assert.deepEqual(visibleShape(reloaded, new Set([response.payload.replacementSeq])), TURN_SHAPE, 'the round trip preserves the fold')
  // The numbering was never touched, so the loop's next real turn follows the
  // closed count and the strict validator accepts it with no counter sync.
  const closed = events.filter((event) => event.type === 'turn/end').length
  plainTurn(reloaded, closed + 1, 'E', 'E1')
  coldRead(header, reloaded.snapshotEvents())
})

test('the negative control: the platform refuses a turn number that does not follow the log', () => {
  const { session, header } = conversation()
  // A delete appends no turn; nothing may reuse a closed number either.
  session.append('turn/start', { turn: 2 })
  assert.throws(
    () => coldRead(header, session.snapshotEvents()),
    (error) => /expected turn/.test(String(error.message)),
  )
})
