// Browser-half tests: src/client.js is a classic client-module factory, so it
// loads in Node against a small DOM stub the same way the host loads it.
//
// What is locked down here (interop contract):
//   * §4 / I4 hidden-row attribution — a row another component declared hidden
//     must stay hidden when this plugin lifts its own claim, and the foreign
//     attribute must never be touched;
//   * §5 / I3 injection idempotency — repeated observer passes reuse the same
//     button node, never duplicate it, and never disturb a foreign sibling;
//   * I6 web/desktop isomorphism — relative routes only, no origin or
//     window.open, no Chromium-only surface.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')
const SESSION_ID = 'session-11111111-1111-1111-1111-111111111111'
const OWNERS = { dshdt: 'data-dshdt-hidden', dshet: 'data-dshet-hidden', dsrr: 'data-dsrr-hidden' }

// --- selector support (only what the bundle and these tests use) ------------

function camelToAttr(prop) {
  return 'data-' + prop.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase())
}

function splitSelector(selector) {
  const parts = []
  let current = ''
  let depth = 0
  for (const ch of selector.trim()) {
    if (ch === '[') depth += 1
    if (ch === ']') depth -= 1
    if (depth === 0 && /\s/.test(ch)) {
      if (current.length > 0) parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.length > 0) parts.push(current)
  return parts
}

function parseCompound(part) {
  const compound = { tag: null, id: null, attrs: [], classes: [] }
  let rest = part
  const tag = /^[a-zA-Z][\w-]*/.exec(rest)
  if (tag) {
    compound.tag = tag[0].toUpperCase()
    rest = rest.slice(tag[0].length)
  }
  while (rest.length > 0) {
    if (rest[0] === '[') {
      const end = rest.indexOf(']')
      const body = rest.slice(1, end).trim()
      const parsed = /^([\w-]+)\s*(?:([*^$]?=)\s*"?([^"\]]*)"?)?$/.exec(body)
      if (parsed === null) throw new Error('unsupported attribute selector: ' + body)
      compound.attrs.push({
        name: parsed[1].toLowerCase(),
        op: parsed[2] || null,
        value: parsed[3] === undefined ? null : parsed[3],
      })
      rest = rest.slice(end + 1)
    } else if (rest[0] === '.') {
      const parsed = /^\.([\w-]+)/.exec(rest)
      compound.classes.push(parsed[1])
      rest = rest.slice(parsed[0].length)
    } else if (rest[0] === '#') {
      const parsed = /^#([\w-]+)/.exec(rest)
      compound.id = parsed[1]
      rest = rest.slice(parsed[0].length)
    } else {
      throw new Error('unsupported selector token: ' + rest)
    }
  }
  return compound
}

const SELECTOR_CACHE = new Map()
function parseSelector(selector) {
  let parsed = SELECTOR_CACHE.get(selector)
  if (parsed === undefined) {
    parsed = splitSelector(selector).map(parseCompound)
    SELECTOR_CACHE.set(selector, parsed)
  }
  return parsed
}

function matchesCompound(element, compound) {
  if (compound.tag !== null && element.tagName !== compound.tag) return false
  if (compound.id !== null && element.getAttribute('id') !== compound.id) return false
  for (const name of compound.classes) if (!element.classList.contains(name)) return false
  for (const attr of compound.attrs) {
    const actual = element.getAttribute(attr.name)
    if (actual === null) return false
    if (attr.op === null) continue
    if (attr.op === '=' && actual !== attr.value) return false
    if (attr.op === '*=' && !actual.includes(attr.value)) return false
    if (attr.op === '^=' && !actual.startsWith(attr.value)) return false
    if (attr.op === '$=' && !actual.endsWith(attr.value)) return false
  }
  return true
}

function matchesSelector(element, compounds) {
  if (!matchesCompound(element, compounds[compounds.length - 1])) return false
  let index = compounds.length - 2
  let node = element.parentElement
  while (index >= 0 && node !== null) {
    if (matchesCompound(node, compounds[index])) index -= 1
    node = node.parentElement
  }
  return index < 0
}

// --- tiny DOM stub ----------------------------------------------------------

class StubElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.childNodes = []
    this.parentElement = null
    this.attrs = new Map()
    this.style = {}
    this.textContent = ''
    this.rectHeight = 20
    const self = this
    this.classList = {
      add(...names) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean))
        for (const name of names) set.add(name)
        self.className = [...set].join(' ')
      },
      remove(...names) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean))
        for (const name of names) set.delete(name)
        self.className = [...set].join(' ')
      },
      contains(name) {
        return self.className.split(/\s+/).includes(name)
      },
    }
    // Real-DOM semantics: dataset properties and data-* attributes are the same
    // storage, which is exactly what the attribution guard reads.
    this.dataset = new Proxy({}, {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined
        const value = self.getAttribute(camelToAttr(prop))
        return value === null ? undefined : value
      },
      set: (_target, prop, value) => {
        self.setAttribute(camelToAttr(prop), String(value))
        return true
      },
      deleteProperty: (_target, prop) => {
        self.removeAttribute(camelToAttr(prop))
        return true
      },
      has: (_target, prop) => typeof prop === 'string' && self.hasAttribute(camelToAttr(prop)),
    })
  }

  get className() {
    return this.getAttribute('class') || ''
  }

  set className(value) {
    this.setAttribute('class', String(value))
  }

  get firstElementChild() {
    return this.childNodes.length > 0 ? this.childNodes[0] : null
  }

  get lastElementChild() {
    return this.childNodes.length > 0 ? this.childNodes[this.childNodes.length - 1] : null
  }

  setAttribute(name, value) {
    this.attrs.set(String(name).toLowerCase(), String(value))
  }

  getAttribute(name) {
    const key = String(name).toLowerCase()
    return this.attrs.has(key) ? this.attrs.get(key) : null
  }

  hasAttribute(name) {
    return this.attrs.has(String(name).toLowerCase())
  }

  removeAttribute(name) {
    this.attrs.delete(String(name).toLowerCase())
  }

  appendChild(node) {
    if (node.parentElement !== null) node.parentElement.removeChild(node)
    this.childNodes.push(node)
    node.parentElement = this
    return node
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) this.childNodes.splice(index, 1)
    node.parentElement = null
    return node
  }

  remove() {
    if (this.parentElement !== null) this.parentElement.removeChild(this)
  }

  descendants(out = []) {
    for (const child of this.childNodes) {
      out.push(child)
      child.descendants(out)
    }
    return out
  }

  querySelectorAll(selector) {
    const compounds = parseSelector(selector)
    return this.descendants().filter((element) => matchesSelector(element, compounds))
  }

  querySelector(selector) {
    const found = this.querySelectorAll(selector)
    return found.length > 0 ? found[0] : null
  }

  closest(selector) {
    const compounds = parseSelector(selector)
    let node = this
    while (node !== null) {
      if (matchesSelector(node, compounds)) return node
      node = node.parentElement
    }
    return null
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 100, bottom: this.rectHeight, width: 100, height: this.rectHeight }
  }
}

class StubDocument {
  constructor() {
    this.head = new StubElement('head', this)
    this.body = new StubElement('body', this)
    this.documentElement = new StubElement('html', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }

  createElement(tagName) {
    return new StubElement(tagName, this)
  }

  querySelectorAll(selector) {
    const compounds = parseSelector(selector)
    return [...this.head.descendants(), ...this.body.descendants()].filter((element) => matchesSelector(element, compounds))
  }

  querySelector(selector) {
    const found = this.querySelectorAll(selector)
    return found.length > 0 ? found[0] : null
  }
}

// --- bundle host ------------------------------------------------------------

const DEFAULT_PAYLOAD = { ok: true, hidden: [], surface: [3], replyTurns: [], edits: [], markerTurns: [], lastSeq: 3 }

function createEnv(options = {}) {
  // A caller can hand in a document another module instance already worked on:
  // that is what a re-apply over a live page looks like (new factory, new
  // module-level WeakMaps, same DOM).
  const document = options.document || new StubDocument()
  const state = { loaded: null, fetchCalls: [], rafQueue: [], timers: [], observers: [], cleanups: [] }
  const payload = options.payload || DEFAULT_PAYLOAD
  const fetchStub = (url, init) => {
    state.fetchCalls.push({ url, init })
    if (options.fetchFails === true) return Promise.reject(new Error('offline'))
    return Promise.resolve({ ok: true, status: 200, json: async () => payload })
  }
  class MutationObserverStub {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      state.observers.push(this)
    }

    observe(target, opts) {
      this.target = target
      this.options = opts
    }

    disconnect() {
      this.disconnected = true
    }
  }
  const window = {
    __ModuleLoader__: { load: (spec) => { state.loaded = spec } },
    setTimeout: (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length },
    clearTimeout: () => {},
  }
  const requestAnimationFrame = (fn) => { state.rafQueue.push(fn); return state.rafQueue.length }
  const react = {
    useEffect(effect) {
      const cleanup = effect()
      if (typeof cleanup === 'function') state.cleanups.push(cleanup)
    },
    // Enough for a one-shot render: the settings card's toggle writes through
    // the store itself, so a re-render is not needed to observe the change.
    useState(initial) {
      return [initial, () => {}]
    },
  }
  const jsx = (type, props) => ({ type, props })
  const requireStub = (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol('Fragment') }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: jsx, Button: jsx, Checkbox: jsx }
    throw new Error('unexpected client require: ' + id)
  }
  const factory = new Function(
    'window',
    'document',
    'MutationObserver',
    'HTMLElement',
    'fetch',
    'requestAnimationFrame',
    'console',
    SOURCE,
  )
  factory(window, document, MutationObserverStub, StubElement, fetchStub, requestAnimationFrame, console)
  const spec = state.loaded
  assert.ok(spec, 'the bundle must register itself with window.__ModuleLoader__')

  return {
    document,
    state,
    spec,
    module: spec.factory(requireStub),
    addRow(rowOptions = {}) {
      const row = document.createElement('div')
      row.setAttribute('data-chat-flow-key', rowOptions.key || 'k1')
      if (rowOptions.turn !== undefined) row.setAttribute('data-chat-turn', String(rowOptions.turn))
      if (rowOptions.actions === true) {
        const bar = document.createElement('div')
        bar.setAttribute('class', 'ds_chat_message_actions_1a2b')
        const own = document.createElement('button')
        own.setAttribute('class', 'host-action')
        bar.appendChild(own)
        row.appendChild(bar)
      }
      document.body.appendChild(row)
      return row
    },
    snapshotFor(rows, seqOf) {
      const nodes = new Map()
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        const key = row.getAttribute('data-chat-flow-key')
        // A row normally names the seq the log appended, but a message another
        // producer replaced is drawn from its live node - so a caller can pin
        // that seq and test the mapping in both directions.
        const seq = seqOf && typeof seqOf[key] === 'number' ? seqOf[key] : 3
        nodes.set(key, {
          kind: 'user',
          data: { seq },
          anchorSeq: seq,
        })
      }
      return { nodes }
    },
    // What another owner does when it hides a row: its own attribution
    // attribute plus the inline hide.
    hideByPlugin(row, ns) {
      row.setAttribute(OWNERS[ns], '1')
      row.style.display = 'none'
    },
    settle() {
      return new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    },
    mutate() {
      for (const observer of state.observers) if (!observer.disconnected) observer.callback([])
      for (const fn of state.rafQueue.splice(0)) fn()
    },
    fireTimers() {
      for (const timer of state.timers.splice(0)) timer.fn()
    },
  }
}

function mount(options = {}) {
  const env = createEnv(options)
  const components = new Map()
  const locales = new Map()
  // Every cleanup an effect registered, so a test can run what a fiber teardown
  // runs (cordis disposes them newest first).
  const disposers = []
  const ctx = {
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return cleanup
    },
    inject: (names, fn) => fn({}),
    slots: {
      inject: (name, fn) => fn(),
      register(slotSpec, Component) {
        components.set(slotSpec.name + '#' + slotSpec.id, { spec: slotSpec, Component })
        return () => {}
      },
    },
    locale: {
      register(ns, dict) {
        locales.set(ns, dict)
        return () => {}
      },
    },
  }
  env.module.apply(ctx)
  env.components = components
  env.locales = locales
  env.dispose = () => {
    for (const cleanup of disposers.splice(0).reverse()) cleanup()
  }
  return env
}

// Mount the overlay entry the way the host does: the slot registration hands
// back the controller, and the standard hooks feed it the chat snapshot.
function mountOverlay(options = {}) {
  const env = mount(options)
  const entry = env.components.get('conversation.input.overlay#delete-turn')
  assert.ok(entry, 'the overlay slot must register under its own id')
  const injected = entry.spec.inject(options.sessionId || SESSION_ID)
  const dict = env.locales.get('dsh-delete-turn')
  const t = (key) => (dict && dict.zh[key]) || key
  const render = (snapshot) => {
    for (const cleanup of env.state.cleanups.splice(0)) cleanup()
    return entry.Component({
      useChat: (selector) => selector(snapshot),
      useDeletion: (selector) => selector(injected.hooks.deletion.getSnapshot()),
      controller: injected.controller,
      t,
    })
  }
  return { env, controller: injected.controller, render, spec: entry.spec }
}

// --- I4 hidden-row attribution ---------------------------------------------

test('a row another component declared hidden stays hidden when we lift our own claim', async () => {
  const { env, render } = mountOverlay()
  const row = env.addRow({ key: 'k1', turn: 1 })
  env.hideByPlugin(row, 'dshdt')
  env.hideByPlugin(row, 'dshet')
  const snapshot = env.snapshotFor(row)

  render(snapshot)
  await env.settle()
  render(snapshot)

  assert.equal(row.hasAttribute('data-dshdt-hidden'), false, 'our own claim is dropped')
  assert.equal(row.getAttribute('data-dshet-hidden'), '1', 'a foreign claim is never cleared')
  assert.equal(row.style.display, 'none', 'the foreign hide keeps the row hidden')
  assert.equal(row.style.height, '', 'our collapse styles are still cleaned up')
  assert.equal(row.querySelectorAll('.dshdt-action').length, 1, 'the row action is still injected')
})

test('rerun-turn attribution is honored the same way', async () => {
  const { env, render } = mountOverlay()
  const row = env.addRow({ key: 'k1', turn: 1 })
  env.hideByPlugin(row, 'dshdt')
  env.hideByPlugin(row, 'dsrr')
  const snapshot = env.snapshotFor(row)

  render(snapshot)
  await env.settle()
  render(snapshot)

  assert.equal(row.hasAttribute('data-dshdt-hidden'), false)
  assert.equal(row.getAttribute('data-dsrr-hidden'), '1')
  assert.equal(row.style.display, 'none')
})

test('a foreign claim set only through the attribute is honored too', async () => {
  const { env, render } = mountOverlay()
  const row = env.addRow({ key: 'k1', turn: 1 })
  env.hideByPlugin(row, 'dshdt')
  row.setAttribute('data-dshet-hidden', '1')
  row.style.display = ''
  const snapshot = env.snapshotFor(row)

  render(snapshot)
  await env.settle()
  render(snapshot)

  assert.equal(row.style.display, 'none', 'attribution alone is enough to keep the row hidden')
})

test('our own hide is still restorable when nobody else claims the row', async () => {
  const { env, render } = mountOverlay()
  const row = env.addRow({ key: 'k1', turn: 1 })
  env.hideByPlugin(row, 'dshdt')
  const snapshot = env.snapshotFor(row)

  render(snapshot)
  await env.settle()
  render(snapshot)

  assert.equal(row.hasAttribute('data-dshdt-hidden'), false)
  assert.equal(row.style.display, '')
  assert.equal(row.style.height, '')
})

test('a row the ledger still holds hidden keeps its own collapse', async () => {
  const payload = { ok: true, hidden: [{ seq: 3, mode: 'message' }], surface: [], replyTurns: [], edits: [], markerTurns: [], lastSeq: 3 }
  const { env, render } = mountOverlay({ payload })
  const row = env.addRow({ key: 'k1', turn: 1 })
  const snapshot = env.snapshotFor(row)

  render(snapshot)
  await env.settle()
  render(snapshot)

  assert.equal(row.dataset.dshdtHidden, '1')
  assert.equal(row.style.display, 'none')
  assert.equal(row.querySelectorAll('.dshdt-action').length, 0)
})

// The row of a deleted message names the LIVE node - the deletion carrier this
// plugin appended - not the seq the log recorded as shadowed. A hide check that
// consults 'hidden' alone never matches that row, so the deletion succeeds, the
// model context loses the message, and the row (now drawing the carrier's empty
// content) stays on screen: the empty bubble a user sees after deleting. The
// host already publishes the link as 'replacement' on every hidden entry, so the
// check indexes it and the row collapses like any other.
test('a deleted row is hidden when the transcript names its replacement carrier', async () => {
  const payload = { ok: true, hidden: [{ seq: 10, mode: 'message', replacement: 11 }], surface: [11], replyTurns: [], edits: [], markerTurns: [], lastSeq: 11 }
  const { env, render } = mountOverlay({ payload })
  const row = env.addRow({ key: 'k1', turn: 1 })
  const snapshot = env.snapshotFor(row, { k1: 11 })

  render(snapshot)
  await env.settle()
  render(snapshot)

  assert.equal(row.dataset.dshdtHidden, '1', 'the row naming the carrier is hidden')
  assert.equal(row.style.display, 'none')
  assert.equal(row.querySelectorAll('.dshdt-action').length, 0, 'a hidden row offers no action')
})

test('the same row is still hidden when it names the shadowed seq', async () => {
  // The other direction, which already worked: the row reports the original.
  const payload = { ok: true, hidden: [{ seq: 10, mode: 'message', replacement: 11 }], surface: [11], replyTurns: [], edits: [], markerTurns: [], lastSeq: 11 }
  const { env, render } = mountOverlay({ payload })
  const row = env.addRow({ key: 'k1', turn: 1 })
  const snapshot = env.snapshotFor(row, { k1: 10 })

  render(snapshot)
  await env.settle()
  render(snapshot)

  assert.equal(row.dataset.dshdtHidden, '1', 'the shadowed seq still hides')
})

test('the turn-navigation mark follows foreign attribution as well', async () => {
  const { env, render } = mountOverlay()
  const nav = env.document.createElement('nav')
  const mark = env.document.createElement('button')
  mark.setAttribute('data-index', '0')
  mark.setAttribute('aria-label', 'turn 1')
  nav.appendChild(mark)
  env.document.body.appendChild(nav)
  const row = env.addRow({ key: 'k1', turn: 1 })
  const snapshot = env.snapshotFor(row)

  render(snapshot)
  await env.settle()
  render(snapshot)
  assert.equal(mark.hasAttribute('data-dshdt-hidden'), false, 'a visible turn keeps its mark')

  row.setAttribute('data-dshet-hidden', '1')
  render(snapshot)
  assert.equal(mark.getAttribute('data-dshdt-hidden'), '1', 'a turn another component hid keeps no mark')

  row.removeAttribute('data-dshet-hidden')
  render(snapshot)
  assert.equal(mark.hasAttribute('data-dshdt-hidden'), false, 'the mark comes back with the row')
})

// --- I3 injection idempotency ----------------------------------------------

test('repeated observer passes reuse one button and never move a foreign sibling', async () => {
  const { env, render } = mountOverlay()
  const row = env.addRow({ key: 'k1', turn: 1, actions: true })
  const bar = row.querySelector('[class*="_actions"]')
  const hostButton = bar.firstElementChild
  const snapshot = env.snapshotFor(row)

  render(snapshot)
  await env.settle()
  render(snapshot)

  const injected = row.querySelectorAll('.dshdt-action-host')
  assert.equal(injected.length, 1, 'exactly one injected host')
  const host = injected[0]
  assert.equal(host.parentElement, bar, 'the row own action bar is the anchor')

  // Another component's node lands after ours...
  const foreign = env.document.createElement('span')
  foreign.setAttribute('data-dshet-action', '1')
  bar.appendChild(foreign)

  env.mutate()
  env.mutate()

  const after = row.querySelectorAll('.dshdt-action-host')
  assert.equal(after.length, 1, 'no duplicate after observer re-entry')
  assert.equal(after[0], host, 'the same node is reused, never removed and re-inserted')
  assert.equal(bar.lastElementChild, foreign, 'a foreign sibling keeps its position')
  assert.equal(hostButton.parentElement, bar, 'the host own button is untouched')
  assert.equal(row.querySelectorAll('.dshdt-action').length, 1)
})

// --- I3 re-apply: a second apply adopts, it never stacks --------------------
//
// The live symptom this locks down: the bundle is re-applied while the page
// keeps its DOM (HMR, a plugin toggle, a bundle-group reload). Every apply
// starts with a fresh module instance - fresh WeakMaps - while the host nodes
// the previous one injected are still sitting in the rows, so an injection that
// cannot recognise its own nodes stacks one more button per apply.

test('a re-apply round leaves exactly one host and never touches host or foreign nodes', async () => {
  const document = new StubDocument()
  const first = mountOverlay({ document })
  const row = first.env.addRow({ key: 'k1', turn: 1, actions: true })
  const bar = row.querySelector('[class*="_actions"]')
  const hostButton = bar.firstElementChild
  const foreign = document.createElement('span')
  foreign.setAttribute('data-dshet-action', '1')
  bar.appendChild(foreign)
  const snapshot = first.env.snapshotFor(row)

  first.render(snapshot)
  await first.env.settle()
  first.render(snapshot)
  const before = row.querySelectorAll('.dshdt-action-host')
  assert.equal(before.length, 1, 'the first apply injects exactly one host')
  const injected = before[0]

  assert.equal(bar.childNodes[0], hostButton, 'the host own button stays first')
  assert.equal(bar.childNodes[1], foreign, 'a sibling plugin node keeps its position')
  assert.equal(bar.childNodes[2], injected, 'our host is appended behind both')

  // What a fiber teardown runs: the nodes this plugin injected go away, and
  // nothing else does.
  first.env.dispose()
  assert.equal(injected.parentElement, null, 'dispose takes the injected host away')
  assert.equal(row.querySelectorAll('.dshdt-action-host').length, 0, 'no injected host survives a dispose')
  assert.equal(bar.childNodes.length, 2, 'dispose removed exactly the node it injected')
  assert.equal(bar.childNodes[0], hostButton, 'dispose never touches the host own button')
  assert.equal(bar.childNodes[1], foreign, 'dispose never touches a sibling plugin node')

  // A fresh module instance onto the same, still-live DOM.
  const second = mountOverlay({ document })
  second.render(snapshot)
  await second.env.settle()
  second.render(snapshot)

  assert.equal(row.querySelectorAll('.dshdt-action-host').length, 1, 'the second apply leaves one host')
  assert.equal(row.querySelectorAll('.dshdt-action').length, 1, 'and one button')
  assert.equal(bar.childNodes[0], hostButton, 'the host own button is still first')
  assert.equal(bar.childNodes[1], foreign, 'the sibling plugin node is still next')
  assert.equal(bar.childNodes.length, 3, 'exactly one injected host came back')

  // A third round, to catch anything that only leaks after two of them.
  second.env.dispose()
  const third = mountOverlay({ document })
  third.render(snapshot)
  await third.env.settle()
  third.render(snapshot)
  assert.equal(row.querySelectorAll('.dshdt-action-host').length, 1, 'still one host after two re-applies')
  assert.equal(document.querySelectorAll('style[data-plugin-css="dsh-delete-turn/delete-turn.css"]').length, 1, 'the style tag never stacks either')
})

test('a second live instance adopts the existing host node instead of rebuilding it', async () => {
  const document = new StubDocument()
  const first = mountOverlay({ document })
  const row = first.env.addRow({ key: 'k1', turn: 1, actions: true })
  const bar = row.querySelector('[class*="_actions"]')
  const snapshot = first.env.snapshotFor(row)

  first.render(snapshot)
  await first.env.settle()
  const tree = first.render(snapshot)
  assert.equal(tree.props.children[0].props['data-dshdt-overlay'], '1', 'the slot root carries the namespace too')
  const host = row.querySelectorAll('.dshdt-action-host')[0]
  assert.equal(host.getAttribute('data-dshdt-action-host'), '1', 'the injected host carries this plugin namespace')

  // Re-applied over a live page: no teardown has run yet, so the previous
  // instance's node is still there. This is the order the ghost buttons came
  // from, and it must end in one node, the same object (contract §5: never
  // remove and re-insert).
  const second = mountOverlay({ document })
  second.render(snapshot)
  await second.env.settle()
  second.render(snapshot)

  const after = row.querySelectorAll('.dshdt-action-host')
  assert.equal(after.length, 1, 'no ghost host is stacked on the row')
  assert.equal(after[0], host, 'the existing node is adopted as it is')
  assert.equal(host.parentElement, bar, 'adoption does not move it either')

  // The old instance is torn down afterwards (a reload racing a re-apply). Its
  // sweep takes that node out; the live instance still holds it and puts it
  // back, which is the self-healing we want.
  first.env.dispose()
  second.render(snapshot)
  const settled = row.querySelectorAll('.dshdt-action-host')
  assert.equal(settled.length, 1, 'exactly one host once the old instance is gone')
  assert.equal(settled[0], host, 'the surviving instance re-attaches the node it holds')
})

test('a host left by a build without the namespace attribute is adopted, not duplicated', async () => {
  const document = new StubDocument()
  const { env, render } = mountOverlay({ document })
  const row = env.addRow({ key: 'k1', turn: 1, actions: true })
  const bar = row.querySelector('[class*="_actions"]')
  // What the previous release of this bundle leaves behind: class only, no
  // namespace attribute, so the WeakMap of the new module cannot see it.
  const ghost = document.createElement('span')
  ghost.className = 'dshdt-action-host'
  const ghostButton = document.createElement('button')
  ghostButton.className = 'dshdt-action dshdt-row-action'
  ghost.appendChild(ghostButton)
  bar.appendChild(ghost)
  const snapshot = env.snapshotFor(row)

  render(snapshot)
  await env.settle()
  render(snapshot)

  const hosts = row.querySelectorAll('.dshdt-action-host')
  assert.equal(hosts.length, 1, 'the pre-namespace host is adopted instead of stacking a ghost')
  assert.equal(hosts[0], ghost)
  assert.equal(ghost.getAttribute('data-dshdt-action-host'), '1', 'the adopted host is stamped with the namespace')
  assert.equal(ghostButton.getAttribute('aria-label'), '删除这条消息', 'the adopted button is rewired to this instance')
})

test('row and reasoning hosts are adopted separately and never swapped', async () => {
  const document = new StubDocument()
  const first = mountOverlay({ document })
  const row = first.env.addRow({ key: 'k1', turn: 1 })
  const think = document.createElement('div')
  think.setAttribute('data-variant', 'think')
  row.appendChild(think)
  const snapshot = { nodes: new Map([['k1', { kind: 'assistant-step', data: { seq: 3, finalNode: { seq: 3 } }, anchorSeq: 3 }]]) }
  const rowHosts = () => row.querySelectorAll('.dshdt-action-host').filter((host) => !host.classList.contains('dshdt-think-action'))
  const thinkHosts = () => think.querySelectorAll('.dshdt-action-host')

  first.render(snapshot)
  await first.env.settle()
  first.render(snapshot)
  assert.equal(rowHosts().length, 1, 'the row gets its own host')
  assert.equal(thinkHosts().length, 1, 'the reasoning card gets its own host')
  const firstRowHost = rowHosts()[0]
  const firstThinkHost = thinkHosts()[0]
  assert.notEqual(firstRowHost, firstThinkHost)
  assert.equal(firstThinkHost.getAttribute('data-dshdt-think-action'), '1', 'a reasoning host is marked as such')
  assert.equal(firstRowHost.hasAttribute('data-dshdt-think-action'), false, 'a row host is not')
  assert.equal(firstThinkHost.parentElement, think, 'the reasoning button stays inside the reasoning card')

  // Second instance while the first one's nodes are still in the DOM. The
  // reasoning host is inside the message row, so a row injection that only
  // looked for "my namespace attribute" would hijack the reasoning button and
  // pull it into the message row.
  const second = mountOverlay({ document })
  second.render(snapshot)
  await second.env.settle()
  second.render(snapshot)

  assert.equal(rowHosts().length, 1, 'still one row host')
  assert.equal(thinkHosts().length, 1, 'still one reasoning host')
  assert.equal(rowHosts()[0], firstRowHost, 'the row host is the same node')
  assert.equal(thinkHosts()[0], firstThinkHost, 'the reasoning host is the same node')
  assert.equal(thinkHosts()[0].parentElement, think, 'the reasoning host is still inside the reasoning card')
  assert.equal(row.querySelectorAll('.dshdt-action-host').length, 2, 'two hosts in this row, no ghosts')

  first.env.dispose()
  second.env.dispose()
  const third = mountOverlay({ document })
  third.render(snapshot)
  await third.env.settle()
  third.render(snapshot)
  assert.equal(row.querySelectorAll('.dshdt-action-host').length, 2, 'one row host and one reasoning host after the round')
  assert.equal(thinkHosts().length, 1)
  assert.equal(rowHosts().length, 1)
})

// --- I6 web / desktop isomorphism ------------------------------------------

test('the client half keeps relative routes and no web-only surface', async () => {
  const { env, render } = mountOverlay()
  render(env.snapshotFor(env.addRow({ key: 'k1', turn: 1 })))
  await env.settle()

  assert.ok(env.state.fetchCalls.length >= 1, 'the state route is read on mount')
  const url = env.state.fetchCalls[0].url
  assert.ok(url.startsWith('/dsh-delete-turn/state?sessionId='), 'relative route, got: ' + url)
  assert.equal(url.includes('//'), false, 'no origin is concatenated')
  assert.equal(new URL(url, 'http://localhost').searchParams.get('sessionId'), SESSION_ID)

  assert.doesNotMatch(SOURCE, /location\.(origin|port|host|protocol|href)/)
  assert.doesNotMatch(SOURCE, /window\.open\b/)
  assert.doesNotMatch(SOURCE, /showDirectoryPicker|navigator\.clipboard/)
  assert.doesNotMatch(SOURCE, /showPopover|showModal\(|<dialog/)
  assert.doesNotMatch(SOURCE, /__DSH_BOOT__/)
})

// --- the turn-delete entry (mode splice) ------------------------------------

const SPLICE_PAYLOAD = { ok: true, hidden: [], surface: [3], spliceSeqs: [3], replyTurns: [], edits: [], markerTurns: [], lastSeq: 3 }

function click(button) {
  button.onclick({ preventDefault() {}, stopPropagation() {} })
}

test('an advertised prompt offers the turn-delete beside the delete action', async () => {
  const { env, render, controller } = mountOverlay({ payload: SPLICE_PAYLOAD })
  const row = env.addRow({ key: 'k1', turn: 1, actions: true })
  const snapshot = env.snapshotFor(row)
  render(snapshot)
  await env.settle()
  // The state arrives asynchronously and the overlay re-applies on publish, the
  // same second pass the real client runs when the controller publishes.
  render(snapshot)

  // The trash action's own contract is untouched: one host, one row button.
  assert.equal(row.querySelectorAll('.dshdt-action-host').length, 1, 'still exactly one injected host')
  assert.equal(row.querySelectorAll('.dshdt-action').length, 1, 'still exactly one trash button')
  assert.equal(row.getAttribute('data-dshdt-splice'), '1', 'the row declares the second entry')
  const splice = row.querySelectorAll('.dshdt-splice')
  assert.equal(splice.length, 1, 'one turn-delete button, inside the same host')
  assert.equal(splice[0].getAttribute('aria-label'), '删除这一轮并接上后面')
  assert.equal(splice[0].parentElement, row.querySelectorAll('.dshdt-action-host')[0], 'it rides in the row host')

  click(splice[0])
  assert.deepEqual(controller.getSnapshot().dialog, { mode: 'splice', seq: 3, label: 'splice' })
  click(row.querySelectorAll('.dshdt-action')[0])
  assert.deepEqual(controller.getSnapshot().dialog, { mode: 'message', seq: 3, label: 'message' }, 'the trash action keeps its own mode')
})

test('a row the host does not advertise carries no turn-delete entry', async () => {
  // The default payload advertises no spliceable row: the button exists in the
  // host (adoption is cheap and idempotent) but the row never offers it.
  const { env, render } = mountOverlay()
  const row = env.addRow({ key: 'k1', turn: 1, actions: true })
  render(env.snapshotFor(row))
  await env.settle()
  assert.equal(row.querySelectorAll('.dshdt-action').length, 1)
  assert.equal(row.hasAttribute('data-dshdt-splice'), false)
})

test('a context row never anchors a turn delete, even when its seq is listed', async () => {
  const { env, render } = mountOverlay({ payload: SPLICE_PAYLOAD })
  const row = env.addRow({ key: 'k1', turn: 1, actions: true })
  const snapshot = { nodes: new Map([['k1', { kind: 'context', data: { seq: 3 }, anchorSeq: 3 }]]) }
  render(snapshot)
  await env.settle()
  render(snapshot)
  assert.equal(row.querySelectorAll('.dshdt-action').length, 1, 'the context row still offers its own delete')
  assert.equal(row.getAttribute('data-dshdt-splice'), null)
})

test('a hidden row offers neither action', async () => {
  const payload = { ...SPLICE_PAYLOAD, hidden: [{ seq: 3, mode: 'splice', replacement: 9 }] }
  const { env, render } = mountOverlay({ payload })
  const row = env.addRow({ key: 'k1', turn: 1, actions: true })
  const snapshot = env.snapshotFor(row)
  render(snapshot)
  await env.settle()
  render(snapshot)
  assert.equal(row.querySelectorAll('.dshdt-action-host').length, 0, 'the whole host leaves a hidden row')
  assert.equal(row.hasAttribute('data-dshdt-splice'), false)
})

test('a re-apply round leaves exactly one turn-delete button', async () => {
  const document = new StubDocument()
  const first = mountOverlay({ document, payload: SPLICE_PAYLOAD })
  const row = first.env.addRow({ key: 'k1', turn: 1, actions: true })
  first.render(first.env.snapshotFor(row))
  await first.env.settle()
  assert.equal(row.querySelectorAll('.dshdt-splice').length, 1)
  first.env.dispose()
  // A dispose sweeps the whole injected host - both buttons leave together.
  assert.equal(row.querySelectorAll('.dshdt-action-host').length, 0)
  assert.equal(row.querySelectorAll('.dshdt-splice').length, 0)

  const second = mountOverlay({ document, payload: SPLICE_PAYLOAD })
  second.render(second.env.snapshotFor(row))
  await second.env.settle()
  assert.equal(row.querySelectorAll('.dshdt-action-host').length, 1, 'one host came back')
  assert.equal(row.querySelectorAll('.dshdt-action').length, 1)
  assert.equal(row.querySelectorAll('.dshdt-splice').length, 1, 'no ghost turn-delete button')
})

test('a second live instance adopts the turn-delete button inside the existing host', async () => {
  const document = new StubDocument()
  const first = mountOverlay({ document, payload: SPLICE_PAYLOAD })
  const row = first.env.addRow({ key: 'k1', turn: 1, actions: true })
  first.render(first.env.snapshotFor(row))
  await first.env.settle()
  const host = row.querySelectorAll('.dshdt-action-host')[0]
  const splice = row.querySelectorAll('.dshdt-splice')[0]

  const second = mountOverlay({ document, payload: SPLICE_PAYLOAD })
  const snapshot = second.env.snapshotFor(row)
  second.render(snapshot)
  await second.env.settle()
  second.render(snapshot)

  assert.equal(row.querySelectorAll('.dshdt-action-host').length, 1, 'no ghost host is stacked')
  assert.equal(row.querySelectorAll('.dshdt-action-host')[0], host, 'the existing host node is adopted')
  assert.equal(row.querySelectorAll('.dshdt-splice').length, 1)
  assert.equal(row.querySelectorAll('.dshdt-splice')[0], splice, 'the existing turn-delete button is adopted')
  click(splice)
  assert.equal(second.controller.getSnapshot().dialog.mode, 'splice', 'the adopted button is rewired to this instance')
})

// --- the plugin page: "ask before deleting" (slot plugins.row.config) -------

function rowConfigEntry(env) {
  for (const entry of env.components.values()) {
    if (entry.spec.name === 'plugins.row.config') return entry
  }
  return undefined
}

function deleteCallCount(env) {
  return env.state.fetchCalls.filter((call) => call.url.indexOf('/dsh-delete-turn/delete') !== -1).length
}

test('the plugin page registers a row.config entry under the bundle#row key', () => {
  const env = mount()
  const entry = rowConfigEntry(env)
  assert.ok(entry, 'the settings page must register a plugins.row.config entry')
  assert.equal(entry.spec.key, 'dsh-delete-turn#dsh-delete-turn', 'the key is <bundle>#<row id>')
})

test('the row.config summary reports the current ask state', () => {
  const env = mount()
  const entry = rowConfigEntry(env)
  const dict = env.locales.get('dsh-delete-turn')
  const t = (key) => (dict && dict.zh[key]) || key
  assert.equal(entry.Component({ view: 'summary', t }), '删除前询问')
})

test('with asking on (the default) a click only opens the dialog', async () => {
  const { env, controller, render } = mountOverlay()
  const row = env.addRow({ key: 'k1', turn: 1, actions: true })
  const snapshot = env.snapshotFor(row)
  render(snapshot)
  await env.settle()
  render(snapshot)

  const before = deleteCallCount(env)
  click(row.querySelectorAll('.dshdt-action')[0])
  await env.settle()

  assert.deepEqual(controller.getSnapshot().dialog, { mode: 'message', seq: 3, label: 'message' })
  assert.equal(deleteCallCount(env), before, 'nothing is deleted until the dialog is confirmed')
})

test('unticking the checkbox deletes straight away without a dialog', async () => {
  const { env, controller, render } = mountOverlay()
  const row = env.addRow({ key: 'k1', turn: 1, actions: true })
  const snapshot = env.snapshotFor(row)
  render(snapshot)
  await env.settle()
  render(snapshot)

  // Open the plugin page and untick "ask before deleting".
  const entry = rowConfigEntry(env)
  const dict = env.locales.get('dsh-delete-turn')
  const t = (key) => (dict && dict.zh[key]) || key
  const tree = entry.Component({ view: 'page', t })
  tree.props.children[0].props.onChange(false)

  const before = deleteCallCount(env)
  click(row.querySelectorAll('.dshdt-action')[0])
  await env.settle()
  await env.settle()

  assert.equal(controller.getSnapshot().dialog, null, 'no dialog is opened while asking is off')
  assert.equal(deleteCallCount(env), before + 1, 'the delete is issued straight away')
})
