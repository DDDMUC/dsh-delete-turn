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
  const document = new StubDocument()
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
  }
  const jsx = (type, props) => ({ type, props })
  const requireStub = (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol('Fragment') }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: jsx, Button: jsx }
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
    snapshotFor(rows) {
      const nodes = new Map()
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        nodes.set(row.getAttribute('data-chat-flow-key'), {
          kind: 'user',
          data: { seq: 3 },
          anchorSeq: 3,
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
  const ctx = {
    effect: (fn) => fn(),
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
