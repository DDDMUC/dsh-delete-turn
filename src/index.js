// dsh-delete-turn - host half.
//
// Two loopback-only JSON routes:
//
//   GET  /dsh-delete-turn/state?sessionId=<id>
//   POST /dsh-delete-turn/delete   { sessionId, mode, seq?, messageId?, turn? }
//
// A deletion appends ONE turn-less `user/message` carrier carrying the official
// surface intent `{ surfaceOp: { op: 'replace', startSeq, endSeq } }` and the
// complete shadowed-node list in `sourceEventSeqs`. The carrier's content is
// empty (or one zero-width space, see below), so the addressed content leaves
// the derived context while the append-only log keeps every original byte. The
// carrier source names this plugin, which is how the browser half rebuilds its
// hidden-row ledger after a reload without any private sidecar.
//
// The fourth action (`mode: 'turn'`) deletes a WHOLE turn - prompt included - as
// one ordinary range replace: every live surface node of that turn (prompt,
// injected context, reply steps and tool results) is shadowed by a single
// turn-less carrier, and the later turns stay exactly where they are. No replay
// and no renumbering: the official surface contract needs neither, so the log
// grows by one event and nothing else.
//
// The module imports nothing from the DSH SDK: `sessions`, `sessionQuery` and
// `sessionController` are resolved through the cordis context at call time, so
// the plugin loads on any profile and degrades to a clear HTTP failure when a
// service is absent.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import {
  PLUGIN_ID,
  PlanError,
  contentEditPairs,
  deletableReplyTurns,
  foldSurface,
  hiddenEntriesOfFold,
  isBusy,
  planRange,
  turnableSeqs,
} from './logic.js'

export const name = PLUGIN_ID

const ROUTE_PREFIX = '/dsh-delete-turn'
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// `turn` is the fourth action: the widest ordinary range replace (every live
// surface node of one turn). It dispatches through the same route and the same
// planner as the other three; nothing here is special-cased.
const MODES = new Set(['message', 'step', 'reply', 'turn'])

// The one adapter line that makes a deletion invisible: `dsh-llm-pi-ai` drops a
// user message whose converted content is empty (the official DeepSeek adapter
// already does this natively; upstream has not added the pi-ai skip yet). When
// that line is present, the carrier can be an empty content list and never
// reaches any model.
//
// Otherwise the carrier MUST carry a zero-width space. An empty content list is
// not a cheaper alternative, and this was measured rather than assumed: the
// session append accepts `content: []` (it derives to a user message with no
// blocks, priced at 4 tokens), but the adapter then hands the provider
// `{ role: 'user', content: '' }` and the provider refuses the whole request.
// Probed 2026-10-03 against the provider this repository deploys on
// (cline-pass -> api.cline.bot -> Vercel deepseek/deepseek-v4.1-flash):
//
//   { role: 'user', content: '' }                        -> HTTP 400
//     {"message":"user message must have content", "type":"invalid_request_error"}
//   the same shape midway through a conversation         -> HTTP 400, same error
//   a normal user message through the same route         -> past validation
//     (fails only because max_tokens:1 produced no text)
//
// So the zero-width space is load-bearing, and its ~9 heuristic tokens (4 role
// framing + 4 block overhead + 1 char) are the price of a deletion every
// provider will accept. Dropping the character instead of the message is not an
// option: an empty string is what the provider rejects.
//
// A global capability probe cannot relax this either. The flag is decided once
// at load while the adapter in play depends on the session's provider, so a
// profile holding both a DeepSeek-adapter provider and an unpatched pi-ai one
// would write an empty carrier for the latter and break its deletions. The
// empty carrier is therefore used only when the one adapter this plugin can
// prove skips it is patched. The probe reads the installed adapter once at
// load; any failure falls back to the safe carrier.
const ADAPTER_PATCH_MARKER = 'dsh-delete-turn:skip-empty-user'

function adapterDropsEmptyUserContent() {
  try {
    const entry = process.argv[1]
    const require = createRequire(entry ?? import.meta.url)
    const resolved = require.resolve('@deepseek-ai/dsh-llm-pi-ai', { paths: entry ? [dirname(entry)] : [] })
    return readFileSync(resolved, 'utf8').includes(ADAPTER_PATCH_MARKER)
  } catch {
    return false
  }
}

const SILENT_CARRIER = adapterDropsEmptyUserContent()

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

// A session id travels in two spellings: the raw uuid and `session-<uuid>`.
// The store, the persistence directories and the workspace rows disagree about
// which one they hold, so every lookup tries both.
function idVariants(sessionId) {
  const out = new Set([sessionId])
  if (sessionId.startsWith('session-')) out.add(sessionId.slice('session-'.length))
  else out.add(`session-${sessionId}`)
  return [...out]
}

function findLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return undefined
  for (const variant of idVariants(sessionId)) {
    const found = sessions.get(variant)
    if (found) return found
  }
  return undefined
}

// Resolve the live Session that owns the append. An already-open session is
// used directly; a cold one is resumed through the official controller, which
// is exactly what the web UI does when the user opens it.
async function resolveSession(ctx, sessionId) {
  const live = findLiveSession(ctx, sessionId)
  if (live) return live
  const controller = ctx.get('sessionController')
  if (controller && typeof controller.resolveAgent === 'function') {
    try {
      const result = await controller.resolveAgent(sessionId)
      if (result && result.agent && result.agent.session) return result.agent.session
    } catch {
      // fall through to the explicit failure below
    }
  }
  return undefined
}

function eventsFromLive(session) {
  if (session && typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch {
      // fall through to the query service
    }
  }
  return undefined
}

// Live-preferred read through the public query service; the live session's own
// snapshot is the fallback when the service is absent.
async function readEvents(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      if (snapshot && Array.isArray(snapshot.events)) return snapshot.events
    } catch {
      // fall through to the live snapshot
    }
  }
  const events = eventsFromLive(findLiveSession(ctx, sessionId))
  return events ?? null
}

function surfaceOf(ctx, sessionId, events) {
  const live = findLiveSession(ctx, sessionId)
  const nodes = live && live.surface && Array.isArray(live.surface.nodes) ? live.surface.nodes : undefined
  return nodes ?? foldSurface(events).nodes
}

// The append is committed in memory the moment `session.append` returns; the
// persistence writer buffers asynchronously. Await the official durability
// checkpoint so a reload or a DSH restart still sees the deletion. A failed
// flush is not fatal — the event is already committed — but the request waits
// for the checkpoint when one exists.
async function flushSession(ctx, session) {
  const errors = []
  const sessions = ctx.get('sessions')
  if (sessions && typeof sessions.flush === 'function') {
    try {
      await Promise.race([sessions.flush(session), new Promise((resolve) => setTimeout(resolve, 5000))])
      return { flushed: true }
    } catch (error) {
      errors.push(String((error && error.message) || error))
    }
  } else {
    errors.push('sessions.flush unavailable')
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence && typeof persistence.flush === 'function') {
    try {
      await Promise.race([persistence.flush(), new Promise((resolve) => setTimeout(resolve, 5000))])
      return { flushed: true }
    } catch (error) {
      errors.push(String((error && error.message) || error))
    }
  } else {
    errors.push('sessionPersistence.flush unavailable')
  }
  return { flushed: false, flushError: errors.join(' | ') }
}

// --- operations --------------------------------------------------------------

// Turns opened purely as deletion bookkeeping: each carries one empty carrier
// system message and no real content. The host still renders a process row
// ("用时 N 秒") for them, so the browser half needs their numbers to hide them.
function markerTurnsOf(events) {
  const turns = new Set()
  for (const event of events) {
    if (event.type !== 'system/message') continue
    const data = event.data || {}
    const source = (data.message && data.message.source) || {}
    if (source.kind !== 'system-prompt' || source.plugin !== PLUGIN_ID) continue
    if (typeof data.turn === 'number') turns.add(data.turn)
  }
  return [...turns].sort((a, b) => a - b)
}

async function stateOf(ctx, sessionId) {
  const events = await readEvents(ctx, sessionId)
  if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id')
  const folded = foldSurface(events)
  // The live surface is what a delete will actually be validated against, so
  // expose exactly that when the session is open.
  const surfaceNodes = surfaceOf(ctx, sessionId, events)
  return {
    hidden: hiddenEntriesOfFold(folded, events),
    // The current surface lets the browser half tell a row that still has
    // context content from one whose content a compaction already removed;
    // `replyTurns` narrows that to turns with an actually deletable reply.
    surface: surfaceNodes,
    replyTurns: deletableReplyTurns(events, surfaceNodes),
    // Rows that may offer the turn-delete action. The list is produced by the
    // SAME planner check the route uses (see turnableSeqs), so a row never
    // advertises a turn delete the host would refuse.
    turnSeqs: turnableSeqs(events, surfaceNodes),
    // In-place rewrites by other producers (dsh-edit-turn): the transcript row
    // stays anchored to the original seq while the context holds the
    // replacement, so the browser half needs the chain to keep the row's
    // action and to address the live node.
    edits: contentEditPairs(folded, events),
    // Bookkeeping turns a deletion opened (they must not show as empty
    // process rows in the transcript).
    markerTurns: markerTurnsOf(events),
    live: Boolean(findLiveSession(ctx, sessionId)),
    busy: isBusy(events),
    lastSeq: events.length > 0 ? events[events.length - 1].seq : -1,
  }
}

async function deleteTarget(ctx, sessionId, body) {
  const mode = typeof body.mode === 'string' ? body.mode : ''
  if (!MODES.has(mode)) throw new HttpError(400, 'invalid', 'mode must be message, step, reply or turn')
  const session = await resolveSession(ctx, sessionId)
  if (!session || typeof session.append !== 'function') {
    throw new HttpError(409, 'session-not-active', 'the session is not open in DSH')
  }
  const events = await readEvents(ctx, sessionId)
  if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id')
  if (isBusy(events)) throw new HttpError(409, 'busy', 'the session is still working')

  const surfaceNodes = surfaceOf(ctx, sessionId, events)
  let plan
  try {
    plan = planRange(events, surfaceNodes, {
      mode,
      seq: typeof body.seq === 'number' ? body.seq : undefined,
      messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
      turn: typeof body.turn === 'number' ? body.turn : undefined,
    })
  } catch (error) {
    if (error instanceof PlanError) {
      const status = error.code === 'not-deletable' ? 400 : 409
      throw new HttpError(status, error.code, error.message)
    }
    throw error
  }

  // The live surface is the append authority; a node that vanished between the
  // read and this check means another writer landed first.
  for (const seq of plan.shadowed) {
    if (!surfaceNodes.includes(seq)) throw new HttpError(409, 'stale', 'the session changed, retry')
  }

  // The carrier must be a turn-less `user/message`.
  //
  // Opening a synthetic turn+step to host a model-invisible empty
  // `system/message` corrupts the log: the agent loop advances its turn counter
  // only from the turns it opens itself, so its next real turn reuses the
  // number this plugin burned (`turn/start does not open the expected turn` on
  // the next cold read) and every turn-number-keyed client hiding then swallows
  // the reused turn's rows. That failure was reproduced in production; do not
  // reintroduce a synthetic turn here.
  //
  // What the carrier holds depends on the installed pi-ai adapter: when it
  // drops empty user content (see {@link adapterDropsEmptyUserContent}) the
  // carrier is an empty content list and never reaches any model; otherwise the
  // safest accepted content is a single ZERO-WIDTH SPACE (a readable marker
  // like "[deleted]" is quoted back by the model, and empty content is refused
  // by gateways whose adapter predates that skip).
  let replacement
  try {
    replacement = session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: SILENT_CARRIER ? [] : [{ type: 'text', text: '\u200b' }],
        // v4 format: plugin wrappers are retired; the producer kind carries the id.
        source: { kind: `plugin:${PLUGIN_ID}` },
      },
      {
        surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
        sourceEventSeqs: plan.shadowed,
      },
    )
  } catch (error) {
    throw new HttpError(409, 'stale', `the surface refused the replacement: ${String((error && error.message) || error)}`)
  }
  const flush = await flushSession(ctx, session)

  return {
    replacementSeq: replacement.seq,
    ...flush,
    hidden: plan.shadowed.map((seq) => ({ seq, mode: plan.mode })),
  }
}

// --- http --------------------------------------------------------------------

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const name = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// Context rewriting is destructive for the model: loopback socket, loopback
// Host header, and a same-origin check when the browser sends Origin.
function guard(req, res) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' })
    return false
  }
  const host = req.headers.host
  if (!isLocalHostHeader(host)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = null
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'cross-origin request' })
      return false
    }
  }
  return true
}

function sessionIdFromQuery(url) {
  try {
    const value = new URL(url, 'http://localhost').searchParams.get('sessionId') || ''
    return value.trim()
  } catch {
    return ''
  }
}

function requireSessionId(value) {
  if (!value) throw new HttpError(400, 'invalid', 'sessionId required')
  if (!SESSION_ID_RE.test(value)) throw new HttpError(400, 'invalid', 'invalid session id')
  return value
}

// --- plugin ------------------------------------------------------------------

export function apply(ctx) {
  const registerRoutes = (webServer, fiber) => {
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            const sessionId = requireSessionId(sessionIdFromQuery(req.url))
            sendJson(res, 200, { ok: true, ...(await stateOf(ctx, sessionId)) })
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            const code = error instanceof HttpError ? error.code : 'internal'
            sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
          }
        },
      }),
    )

    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/delete`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
            return
          }
          let body = {}
          try {
            const raw = await readBody(req)
            if (raw) body = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
            return
          }
          try {
            const sessionId = requireSessionId(typeof body.sessionId === 'string' ? body.sessionId.trim() : '')
            // Every mode - including the whole-turn delete - is one range
            // replace, so one planner and one append path serve them all.
            const result = await deleteTarget(ctx, sessionId, body)
            sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            const code = error instanceof HttpError ? error.code : 'internal'
            sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
          }
        },
      }),
    )
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoutes(webServer, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
  }
}
