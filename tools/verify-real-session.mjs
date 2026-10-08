// Verify a whole-turn delete against a REAL session log and the REAL format
// validator.
//
//   node tools/verify-real-session.mjs /tmp/session-xxxx.v4.jsonl.zstd [--turn 178]
//
// The tool never writes to the file it is given: it decodes the log, validates
// it through the platform's own strict cold read, builds a real Session from the
// decoded events, and then drives the plugin's actual HTTP route
// (POST /dsh-delete-turn/delete { mode: 'turn' }) against that session. Every
// appended event is recorded, the resulting log is put through the strict cold
// read again, and the two folded surfaces - the node sequence the conversation
// view draws - are printed side by side.
//
// Exit code 0 means every assertion held: the deleted turn's nodes left the
// surface, every later turn is still there under its own number, exactly one
// event landed, and the log plus one more loop-opened turn still passes the
// format validator.
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { loadDshModule } from './dsh-modules.mjs'
import { decodeZstdFrames } from './decode-session-log.mjs'
import { apply } from '../src/index.js'
import { foldSurface, isOwnPlaceholder, isSilentPluginCarrier, planRange } from '../src/logic.js'

const args = process.argv.slice(2)
const logPath = args[0]
const turnFlag = args.indexOf('--turn')
const requestedTurn = turnFlag === -1 ? undefined : Number(args[turnFlag + 1])
if (logPath === undefined) {
  console.error('usage: node tools/verify-real-session.mjs <session.v4.jsonl.zstd> [--turn N]')
  process.exit(2)
}

const { Session, SessionId, SESSION_FORMAT_VERSION } = await loadDshModule('@deepseek-ai/dsh-session')
const { sessionFormatCatalog } = await loadDshModule('@deepseek-ai/dsh-session-format-catalog')

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log('  ok   ' + name + (detail === undefined ? '' : ' - ' + detail))
  else { failures += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : ' - ' + detail)) }
}

function decodeLog(path) {
  const raw = readFileSync(path)
  const lines = decodeZstdFrames(raw).toString('utf8').split('\n').filter((line) => line.trim() !== '')
  return { header: JSON.parse(lines[0]), rows: lines.slice(1).map((line) => JSON.parse(line)) }
}

function strictColdRead(header, rows) {
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const row of rows) restore.decodeRow(row)
  return restore.finish()
}

function coldReadOf(header, events) {
  // The v4 physical header takes the canonical field set only; the file's own
  // header may carry extra fields this validator refuses to re-encode.
  const value = { version: SESSION_FORMAT_VERSION, id: header.id, createdAt: header.createdAt, isSeeded: false, cwd: header.cwd, delegationDepth: 0 }
  const encodedHeader = sessionFormatCatalog.encodeCurrentHeader(value, 0)
  const restore = sessionFormatCatalog.createRestore(encodedHeader, { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  return restore.finish()
}

// Turn of every seq, bracket-aware: user messages carry no turn field.
function turnIndexOf(events) {
  const map = new Map()
  let current
  for (const event of events) {
    if (event.type === 'turn/start') { current = event.data.turn; map.set(event.seq, current); continue }
    if (event.type === 'turn/end') { map.set(event.seq, current); current = undefined; continue }
    const data = event.data || {}
    map.set(event.seq, typeof data.turn === 'number' ? data.turn : current)
  }
  return map
}

function preview(event) {
  const data = event.data || {}
  const message = event.type === 'user/message' ? data : data.message
  if (!message || !Array.isArray(message.content)) return ''
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text.slice(0, 46).replace(/\s+/g, ' ')
  }
  return '[' + message.content.map((block) => (block && block.type) || '?').join(',') + ']'
}

// One line per surface node: seq, turn, type, content preview.
function surfaceLines(nodes, bySeq, turnOf) {
  return nodes.map((seq) => {
    const event = bySeq.get(seq)
    const turn = turnOf.get(seq) === undefined ? '-' : String(turnOf.get(seq))
    return '    ' + String(seq).padStart(6) + '  turn ' + turn.padStart(4) + '  ' + event.type.padEnd(17) + ' ' + preview(event)
  })
}

// --- decode + validate the original -----------------------------------------
const decoded = decodeLog(logPath)
console.log('dsh-delete-turn whole-turn delete verification on a real session log')
console.log('  log      ' + logPath)
console.log('  session  ' + decoded.header.id + '  (' + decoded.rows.length + ' rows decoded from the file)')
let originalArtifact
try {
  originalArtifact = strictColdRead(decoded.header, decoded.rows)
  console.log('  strict cold read on the original: OK (' + originalArtifact.events.length + ' events)')
} catch (error) {
  console.log('  strict cold read on the original: REFUSED - ' + String(error.message))
  process.exit(1)
}
const events = originalArtifact.events

// --- build the real session --------------------------------------------------
const id = SessionId(decoded.header.id)
const session = Session.create(id, events, {
  version: SESSION_FORMAT_VERSION,
  id,
  createdAt: decoded.header.createdAt,
  isSeeded: false,
  cwd: decoded.header.cwd,
})
const before = [...session.surface.nodes]
const beforeBySeq = new Map(events.map((event) => [event.seq, event]))
const beforeTurnOf = turnIndexOf(events)
const nodeTurn = (seq) => beforeTurnOf.get(seq)
const turns = [...new Set(events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn))]

const humanPromptTurn = (turn) =>
  before.some((seq) => {
    const event = beforeBySeq.get(seq)
    return nodeTurn(seq) === turn && event.type === 'user/message' && event.data.source && event.data.source.kind === 'user'
  })
// The first turn holds the system prompt head and must not be chosen by default.
const candidates = turns.filter((turn) => turn !== turns[0] && humanPromptTurn(turn))
const targetTurn = requestedTurn === undefined ? candidates[candidates.length - 1] : requestedTurn
if (targetTurn === undefined) { console.log('no removable turn with a human prompt'); process.exit(1) }

console.log('')
console.log('surface BEFORE: ' + before.length + ' nodes (platform fold == this plugin fold: ' + (JSON.stringify(foldSurface(events).nodes) === JSON.stringify(before)) + ')')
console.log('tail of the folded surface - every row the conversation view can draw:')
console.log(surfaceLines(before.filter((seq) => nodeTurn(seq) === undefined || nodeTurn(seq) >= targetTurn - 1), beforeBySeq, beforeTurnOf).join('\n'))

// --- drive the plugin's real route -------------------------------------------
// No `sessionController` is provided on purpose: a whole-turn delete must not
// need the agent handle (the removed splice needed it to re-point the loop).
const record = []
const append = session.append.bind(session)
session.append = (type, data, ...opts) => {
  const landed = append(type, data, ...opts)
  record.push({ type, data, opts: opts[0] || {}, seq: landed.seq })
  return landed
}
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
if (route === undefined) { console.log('the delete route did not register'); process.exit(1) }

async function get(url) {
  const stateRoute = routes.get('/dsh-delete-turn/state')
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = url
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { host: '127.0.0.1:3080', accept: 'application/json' }
  const res = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code }, end(payload) { this.body = payload } }
  await stateRoute.handler(req, res)
  return { status: res.statusCode, payload: JSON.parse(res.body) }
}

function call(body) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/dsh-delete-turn/delete'
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
  process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  const res = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code }, end(payload) { this.body = payload } }
  return Promise.resolve(route.handler(req, res)).then(() => ({ status: res.statusCode, payload: JSON.parse(res.body) }))
}

// The advertisement the state route publishes: every row it lists must be
// accepted by the planner, or a click would be a false button.
const advertised = await get('/dsh-delete-turn/state?sessionId=' + encodeURIComponent(decoded.header.id))
const advertisedSeqs = Array.isArray(advertised.payload.turnSeqs) ? advertised.payload.turnSeqs : []
let unplannable = 0
for (const seq of advertisedSeqs) {
  try { planRange(session.snapshotEvents(), [...session.surface.nodes], { mode: 'turn', seq }) } catch { unplannable += 1 }
}
check('every advertised row is plannable', advertised.status === 200 && unplannable === 0, advertisedSeqs.length + ' rows advertised, ' + unplannable + ' unplannable')

const request = { sessionId: decoded.header.id, mode: 'turn', turn: targetTurn }
const response = await call(request)
console.log('')
console.log('POST /dsh-delete-turn/delete ' + JSON.stringify(request))
console.log('  -> HTTP ' + response.status + ' ' + JSON.stringify(response.payload))
if (response.status !== 200) { console.log('the turn delete was refused; nothing else to verify'); process.exit(1) }
const result = response.payload

console.log('')
console.log('writes landed (' + record.length + '):')
record.forEach((entry, index) => {
  const turn = entry.data.turn === undefined ? '(turn-less)' : String(entry.data.turn)
  const op = entry.opts.surfaceOp === undefined ? '-' : JSON.stringify(entry.opts.surfaceOp)
  const sources =
    entry.opts.sourceEventSeqs === undefined
      ? '-'
      : entry.opts.sourceEventSeqs.length + ' seqs [' + entry.opts.sourceEventSeqs.slice(0, 3).join(',') + (entry.opts.sourceEventSeqs.length > 3 ? ',...' : '') + ']'
  console.log('  ' + String(index + 1).padStart(4) + '  seq ' + String(entry.seq).padStart(6) + '  ' + entry.type.padEnd(17) + ' turn=' + turn.padEnd(10) + ' surfaceOp=' + op.padEnd(46) + ' sourceEventSeqs=' + sources)
})

// --- the folded surface after the delete -------------------------------------
const landed = session.snapshotEvents()
const after = [...session.surface.nodes]
const afterBySeq = new Map(landed.map((event) => [event.seq, event]))
const afterTurnOf = turnIndexOf(landed)
console.log('')
console.log('surface AFTER: ' + after.length + ' nodes (platform fold == this plugin fold: ' + (JSON.stringify(foldSurface(landed).nodes) === JSON.stringify(after)) + ')')
console.log('tail of the folded surface:')
console.log(surfaceLines(after.filter((seq) => afterTurnOf.get(seq) === undefined || afterTurnOf.get(seq) >= targetTurn - 1), afterBySeq, afterTurnOf).join('\n'))

// --- assertions --------------------------------------------------------------
console.log('')
const retired = result.hidden.map((item) => item.seq)
const stillThere = retired.filter((seq) => after.includes(seq))
check('every node the carrier shadowed left the surface', stillThere.length === 0, retired.length + ' nodes retired' + (stillThere.length > 0 ? ', still present: ' + stillThere.join(',') : ''))

// One append, no turn border: the delete never replays or renumbers anything.
check('exactly one event landed', record.length === 1, record.length + ' writes')
check('the delete opened no turn', landed.filter((event) => event.type === 'turn/start').length === turns.length, turns.length + ' turns before and after')
const laterNodes = before.filter((seq) => typeof nodeTurn(seq) === 'number' && nodeTurn(seq) > targetTurn)
const laterLost = laterNodes.filter((seq) => !after.includes(seq))
check('every later turn is still on the surface under its own number', laterLost.length === 0, laterNodes.length + ' later nodes kept' + (laterLost.length > 0 ? ', lost: ' + laterLost.join(',') : ''))

// The conversation view's acceptance: the multiset of visible conversation
// rows must lose EXACTLY the deleted turn's rows, and nothing else.
const visibleText = (event) => {
  const data = event.data || {}
  const message = event.type === 'user/message' ? data : data.message
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.filter((block) => block && block.type === 'text').map((block) => block.text).join(' ').trim()
}
const conversationCounts = (nodes, bySeq) => {
  const counts = new Map()
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    // A plugin carrier is not a conversation row: the browser half hides the row
    // that names it, and both adapters drop its content before the request.
    if (isOwnPlaceholder(event) || isSilentPluginCarrier(event)) continue
    const text = visibleText(event)
    if (text === '') continue
    const key = event.type + '|' + text.slice(0, 120)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}
const beforeCounts = conversationCounts(before, beforeBySeq)
const deletedCounts = conversationCounts(
  retired.filter((seq) => nodeTurn(seq) === targetTurn),
  beforeBySeq,
)
const expectedCounts = new Map(beforeCounts)
for (const [key, count] of deletedCounts) expectedCounts.set(key, (expectedCounts.get(key) || 0) - count)
const actualCounts = conversationCounts(after, afterBySeq)
const mismatches = []
for (const key of new Set([...expectedCounts.keys(), ...actualCounts.keys()])) {
  const want = expectedCounts.get(key) || 0
  const got = actualCounts.get(key) || 0
  if (want !== got) mismatches.push(key.slice(0, 70) + ' -> expected ' + want + ', found ' + got)
}
check(
  'the visible conversation loses exactly the deleted turn (no gap, no duplicate)',
  mismatches.length === 0,
  mismatches.length === 0 ? beforeCounts.size + ' distinct rows checked' : JSON.stringify(mismatches),
)
const deletedRows = retired.filter((seq) => nodeTurn(seq) === targetTurn).length
check('turn ' + targetTurn + ' itself has no surface node left', deletedRows > 0, deletedRows + ' rows were shadowed')

// The carrier stands where the deleted window was: turn-less, and carrying no
// readable text (an empty content list, or a single zero-width space when the
// installed adapter predates the empty-user skip).
const carrier = landed[result.replacementSeq]
const carrierText = carrier.data.content.map((block) => block.text || '').join('')
check(
  'the carrier is turn-less and carries no readable text',
  carrier.data.turn === undefined && (carrier.data.content.length === 0 || carrierText === '\u200b'),
  'content ' + JSON.stringify(carrier.data.content.length === 0 ? [] : carrierText) + ', turn ' + String(carrier.data.turn),
)
check('the carrier row is hidden by the ledger', result.hidden.every((item) => item.seq !== result.replacementSeq), result.hidden.length + ' ledger entries all name shadowed rows')

let afterRead = null
try { afterRead = coldReadOf(decoded.header, landed) } catch (error) { afterRead = String(error.message) }
check('the post-delete log passes the strict cold read', typeof afterRead === 'object' && afterRead !== null, typeof afterRead === 'string' ? afterRead : afterRead.events.length + ' events')

// The numbering was never touched, so the loop's next turn follows the closed
// count and the strict validator accepts it with no counter sync.
const loopTurn = landed.filter((event) => event.type === 'turn/end').length + 1
session.append('turn/start', { turn: loopTurn })
session.append('step/start', { turn: loopTurn, step: 1 })
session.append('user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'after the delete' }], source: { kind: 'user', rpcId: randomUUID() } }, { surfaceOp: 'append' })
session.append('assistant/message', { turn: loopTurn, step: 1, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, { surfaceOp: 'append' })
session.append('step/end', { turn: loopTurn, step: 1 })
session.append('turn/end', { turn: loopTurn, reason: { kind: 'completed' } })
let finalRead = null
try { finalRead = coldReadOf(decoded.header, session.snapshotEvents()) } catch (error) { finalRead = String(error.message) }
check('a loop-opened turn ' + loopTurn + ' after the delete keeps the log readable', typeof finalRead === 'object' && finalRead !== null, typeof finalRead === 'string' ? finalRead : finalRead.events.length + ' events')

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
