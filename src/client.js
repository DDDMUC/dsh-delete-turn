// dsh-delete-turn - browser half.
//
// Two entry points:
//
//   * the assistant reply action, mounted through the official
//     `conversation.chat.assistant-actions` list slot (the owner hands it the
//     durable message id);
//   * a per-session controller mounted through `conversation.input.overlay`
//     that renders the confirmation dialog and enhances the rows the host UI
//     exposes no action slot for: user messages, injected context rows, tool
//     cards, process rows and failure rows.
//
// Row targeting reads the official `useChat` standard hook (the ChatSnapshot
// keyed by the same `data-chat-flow-key` the DOM publishes) plus the official
// `data-chat-flow-*` anchors. No React fiber introspection and no CSS-module
// class hashing are involved, so a host UI refactor cannot silently detach the
// actions.
//
// The module is a classic client bundle (client-modules protocol): it
// registers a factory with window.__ModuleLoader__ and returns apply().
window.__ModuleLoader__.load({
  id: 'dsh-delete-turn',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { jsx, jsxs, Fragment } = jsxRuntime

    const NS = 'dsh-delete-turn'
    const ROUTE_PREFIX = '/dsh-delete-turn'
    // Minimum gap between automatic snapshot refreshes while a transcript grows.
    const REFRESH_INTERVAL_MS = 3000

    // --- copy -----------------------------------------------------------------

    const zh = {
      'action.tooltip.message': '删除这条消息',
      'action.tooltip.step': '删除这一步',
      'action.tooltip.reply': '删除这条回复',
      'dialog.title.message': '删除这条消息？',
      'dialog.title.step': '删除这一步？',
      'dialog.title.reply': '删除这条回复？',
      'dialog.desc.message': '这条消息将从模型上下文中移除，并从当前转录中隐藏。原始会话日志保持不变。',
      'dialog.desc.step': '这一步的回复与它请求的工具结果将一并从模型上下文中移除，同一回合的其它步骤保留。',
      'dialog.desc.reply': '这条回复连同它的思考、工具调用与注入上下文将从模型上下文中移除，你的提问会保留。',
      'dialog.note': '删除只影响模型后续看到的内容，不会改写历史日志。',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.pending': '删除中…',
      'dialog.retry': '重试',
      'error.invalid': '请求无效，请刷新后重试。',
      'error.session-not-active': '这个会话当前未激活，请先打开该会话再删除。',
      'error.session-not-found': '找不到该会话的日志。',
      'error.busy': '该会话正在进行中，请等回复结束后再删除。',
      'error.already-deleted': '这条内容已经从上下文中删除了。',
      'error.not-deletable': '这个位置不支持删除。',
      'error.range-not-clean': '目标区间包含其它内容，已取消删除。',
      'error.nothing-to-delete': '这个回合没有可删除的回复内容。',
      'error.stale': '会话刚刚发生了变化，请重试。',
      'error.forbidden': '请求来源不被允许。',
      'error.generic': '删除失败，请重试。',
    }

    const en = {
      'action.tooltip.message': 'Delete this message',
      'action.tooltip.step': 'Delete this step',
      'action.tooltip.reply': 'Delete this reply',
      'dialog.title.message': 'Delete this message?',
      'dialog.title.step': 'Delete this step?',
      'dialog.title.reply': 'Delete this reply?',
      'dialog.desc.message': 'This message leaves the model context and is hidden from the current transcript. The original session log stays untouched.',
      'dialog.desc.step': 'This step and the tool results it requested leave the model context together; other steps in the same turn stay.',
      'dialog.desc.reply': 'This reply leaves the model context together with its reasoning, tool calls and injected context; your prompt stays.',
      'dialog.note': 'Deletion only changes what the model sees next; the append-only log is never rewritten.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.pending': 'Deleting...',
      'dialog.retry': 'Retry',
      'error.invalid': 'Invalid request; refresh and try again.',
      'error.session-not-active': 'This session is not open in DSH; open it first.',
      'error.session-not-found': 'No session log was found for this id.',
      'error.busy': 'This session is still working; wait for the reply to finish.',
      'error.already-deleted': 'This content is already removed from the context.',
      'error.not-deletable': 'This position cannot be deleted.',
      'error.range-not-clean': 'The target window contains unrelated content; the delete was cancelled.',
      'error.nothing-to-delete': 'This turn has no reply content to delete.',
      'error.stale': 'The session just changed; try again.',
      'error.forbidden': 'The request origin is not allowed.',
      'error.generic': 'Delete failed; try again.',
    }

    // --- style ----------------------------------------------------------------

    const CSS = [
      '.dshdt-action{width:28px;height:28px;padding:6px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer;transition:background-color .12s,color .12s}',
      '.dshdt-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dshdt-action:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4d6bfe);outline-offset:2px}',
      '.dshdt-action:disabled{cursor:default;opacity:.4}',
      '.dshdt-action svg{width:15px;height:15px}',
      '.dshdt-action-host{display:inline-flex;align-items:center;justify-content:center}',
      '.dshdt-row{position:relative}',
      '.dshdt-floating{position:absolute;top:2px;right:6px;z-index:2;opacity:0;transition:opacity .12s}',
      '.dshdt-row:hover .dshdt-floating,.dshdt-floating:focus-within{opacity:1}',
      '[data-variant="think"]{position:relative}',
      '.dshdt-think-action{position:absolute;top:0;right:4px;opacity:0;transition:opacity .12s}',
      '[data-variant="think"]:hover .dshdt-think-action,.dshdt-think-action:focus-within{opacity:1}',
      '.dshdt-collapsing{overflow:hidden;transition:height .2s ease,opacity .14s ease,margin .2s ease,padding .2s ease}',
      '[data-dshdt-hidden="1"]{display:none!important}',
      '[data-dshdt-no-target="1"] .dshdt-action{display:none!important}',
      '.dshdt-dialog-text{margin:0;color:var(--dsw-alias-label-primary,inherit);font-size:14px;line-height:22px}',
      '.dshdt-dialog-note{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:13px;line-height:20px}',
      '.dshdt-dialog-error{margin:10px 0 0;color:var(--dsw-alias-state-error-primary,#d54941);font-size:13px;line-height:20px}',
      '.dshdt-danger{background:var(--dsw-alias-state-error-primary,#d54941)!important;color:var(--dsw-alias-label-primary-foreground,#fff)!important}',
      '@media (prefers-reduced-motion:reduce){.dshdt-collapsing{transition:none}.dshdt-floating{transition:none}}',
    ].join('')

    const TAG_ID = 'dsh-delete-turn/delete-turn.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // --- icon -----------------------------------------------------------------

    // Hand-drawn trash glyph: lid line, trapezoid body, two ribs.
    const ICON_PATHS = [
      'M6.4 2.6h3.2',
      'M2.9 4.6h10.2',
      'M4.4 4.6l.62 7.55A1.6 1.6 0 0 0 6.61 13.6h2.78a1.6 1.6 0 0 0 1.59-1.45l.62-7.55',
      'M6.8 7.1v3.6',
      'M9.2 7.1v3.6',
    ]
    const ICON_MARKUP =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      ICON_PATHS.map(
        (d) =>
          '<path d="' + d + '" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
      ).join('') +
      '</svg>'

    function TrashIcon() {
      return jsx('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        children: ICON_PATHS.map((d, index) =>
          jsx('path', { d, stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }, index),
        ),
      })
    }

    // --- controller -----------------------------------------------------------

    class DeletionController {
      constructor(sessionId) {
        this.sessionId = sessionId
        this.listeners = new Set()
        this.inflight = null
        this.animateOnce = false
        this.view = Object.freeze({
          hidden: new Map(),
          surface: new Set(),
          replyTurns: new Set(),
          surfaceReady: false,
          surfaceThrough: -1,
          loaded: false,
          loadError: false,
          dialog: null,
          pending: false,
          failure: null,
          revision: 0,
        })
      }

      getSnapshot = () => this.view

      subscribe = (listener) => {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }

      publish(patch) {
        this.view = Object.freeze({ ...this.view, ...patch, revision: this.view.revision + 1 })
        for (const listener of this.listeners) {
          try {
            listener()
          } catch (error) {
            console.error('[dsh-delete-turn] subscriber threw:', error)
          }
        }
      }

      consumeAnimate() {
        const value = this.animateOnce === true
        this.animateOnce = false
        return value
      }

      // Refresh the snapshot when the transcript shows events newer than the
      // last read. Throttled: a streaming turn produces many new seqs, and one
      // read per interval is enough for the ledger and the gates.
      requestRefresh() {
        if (this.inflight !== null) return
        const since = typeof this.refreshedAt === 'number' ? Date.now() - this.refreshedAt : Infinity
        if (since < REFRESH_INTERVAL_MS) return
        this.load(true)
      }

      load(force) {
        if (this.inflight !== null) return this.inflight
        if (this.view.loaded && force !== true) return Promise.resolve()
        this.refreshedAt = Date.now()
        const url = `${ROUTE_PREFIX}/state?sessionId=${encodeURIComponent(this.sessionId)}`
        const pending = fetch(url, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}))
            if (!res.ok || !data.ok) throw new Error(data && data.error ? String(data.error) : `HTTP ${res.status}`)
            const hidden = new Map()
            for (const item of Array.isArray(data.hidden) ? data.hidden : []) {
              if (item && typeof item.seq === 'number') hidden.set(item.seq, typeof item.mode === 'string' ? item.mode : 'message')
            }
            const surface = new Set()
            for (const seq of Array.isArray(data.surface) ? data.surface : []) surface.add(seq)
            const replyTurns = new Set()
            for (const turn of Array.isArray(data.replyTurns) ? data.replyTurns : []) replyTurns.add(turn)
            const surfaceThrough = typeof data.lastSeq === 'number' ? data.lastSeq : -1
            this.publish({ hidden, surface, replyTurns, surfaceReady: true, surfaceThrough, loaded: true, loadError: false })
          })
          .catch(() => {
            this.publish({ loadError: true })
          })
          .finally(() => {
            this.inflight = null
          })
        this.inflight = pending
        return pending
      }

      open(target) {
        this.load()
        this.publish({ dialog: target, failure: null })
      }

      close() {
        if (this.view.pending) return
        this.publish({ dialog: null, failure: null })
      }

      async confirm() {
        const target = this.view.dialog
        if (target === null || this.view.pending) return
        this.publish({ pending: true, failure: null })
        try {
          const res = await fetch(`${ROUTE_PREFIX}/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: this.sessionId, ...target }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) {
            this.publish({ pending: false, failure: data && data.code ? String(data.code) : 'generic' })
            return
          }
          const hidden = new Map(this.view.hidden)
          for (const item of Array.isArray(data.hidden) ? data.hidden : []) {
            if (item && typeof item.seq === 'number') hidden.set(item.seq, typeof item.mode === 'string' ? item.mode : target.mode)
          }
          this.animateOnce = true
          this.publish({ pending: false, dialog: null, hidden, loaded: true, loadError: false })
        } catch {
          this.publish({ pending: false, failure: 'generic' })
        }
      }

      dispose() {
        this.listeners.clear()
      }
    }

    // --- row targets ----------------------------------------------------------

    // What one Chat view node can be asked to delete, or null when the row has
    // no deletable target (system prompt head, running step, ...).
    function targetFor(node) {
      const data = node.data || {}
      switch (node.kind) {
        case 'user':
        case 'context':
        case 'steering': {
          const seq = typeof data.seq === 'number' ? data.seq : node.anchorSeq
          return typeof seq === 'number' ? { mode: 'message', seq, label: 'message' } : null
        }
        case 'tool-call': {
          const root = data.root
          const seq = root && typeof root.seq === 'number' ? root.seq : undefined
          return seq === undefined ? null : { mode: 'step', seq, label: 'step' }
        }
        // The process/disclosure row ("已思考", "用时 N 秒") deliberately gets no
        // entry: the same whole-reply delete already lives in the turn tail's
        // official action strip, so a second hover-only icon there would only
        // duplicate the same scope.
        case 'turn-error':
        case 'model-retry':
          return typeof data.turn === 'number' ? { mode: 'reply', turn: data.turn, label: 'reply' } : null
        case 'turn-tail': {
          const closing = data.closing
          if (closing && closing.finalNode && closing.finalNode.messageId !== undefined) return null
          return typeof data.turn === 'number' ? { mode: 'reply', turn: data.turn, label: 'reply' } : null
        }
        case 'assistant-step': {
          const final = data.finalNode
          if (final && final.messageId !== undefined) return null
          return final && typeof final.seq === 'number' ? { mode: 'step', seq: final.seq, label: 'step' } : null
        }
        default:
          return null
      }
    }

    function seqsFor(node) {
      const data = node.data || {}
      const out = []
      const push = (value) => {
        if (typeof value === 'number' && !out.includes(value)) out.push(value)
      }
      switch (node.kind) {
        case 'user':
        case 'context':
        case 'steering':
          push(data.seq)
          break
        case 'assistant-step':
          push(node.anchorSeq)
          if (data.finalNode) push(data.finalNode.seq)
          break
        case 'tool-call':
          if (data.root) push(data.root.seq)
          break
        case 'turn-tail':
          push(node.anchorSeq)
          if (data.closing && data.closing.finalNode) push(data.closing.finalNode.seq)
          break
        case 'turn-process':
          // The process disclosure hides with its answer: a step deletion that
          // leaves the answer keeps the row, a reply deletion that removes the
          // answer collapses it.
          push(data.answerAnchorSeq)
          break
        default:
          push(node.anchorSeq)
      }
      return out
    }

    function isRowHidden(hidden, seqs) {
      for (const seq of seqs) {
        if (hidden.has(seq)) return true
      }
      return false
    }

    // --- dom enhancement ------------------------------------------------------

    const rowActions = new WeakMap()
    const thinkActions = new WeakMap()

    function setRowHidden(row, hide, animate) {
      if (hide) {
        if (row.dataset.dshdtHidden === '1') return
        row.dataset.dshdtHidden = '1'
        if (!animate || typeof requestAnimationFrame !== 'function') {
          row.style.display = 'none'
          return
        }
        const height = row.getBoundingClientRect().height
        row.classList.add('dshdt-collapsing')
        row.style.height = `${height}px`
        row.style.opacity = '1'
        requestAnimationFrame(() => {
          row.style.height = '0px'
          row.style.opacity = '0'
          row.style.marginTop = '0px'
          row.style.marginBottom = '0px'
          row.style.paddingTop = '0px'
          row.style.paddingBottom = '0px'
        })
        window.setTimeout(() => {
          if (row.dataset.dshdtHidden !== '1') return
          row.classList.remove('dshdt-collapsing')
          row.style.display = 'none'
        }, 240)
        return
      }
      if (row.dataset.dshdtHidden !== '1') return
      delete row.dataset.dshdtHidden
      row.classList.remove('dshdt-collapsing')
      row.style.display = ''
      row.style.height = ''
      row.style.opacity = ''
      row.style.marginTop = ''
      row.style.marginBottom = ''
      row.style.paddingTop = ''
      row.style.paddingBottom = ''
    }

    function removeRowAction(row) {
      const entry = rowActions.get(row)
      if (!entry) return
      entry.host.remove()
      rowActions.delete(row)
    }

    function injectRowAction(row, node, target, controller, t) {
      const label = t(`action.tooltip.${target.label}`)
      let entry = rowActions.get(row)
      if (!entry) {
        const host = document.createElement('span')
        host.className = 'dshdt-action-host'
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dshdt-action dshdt-row-action'
        button.innerHTML = ICON_MARKUP
        host.appendChild(button)
        entry = { host, button }
        rowActions.set(row, entry)
      }
      const { host, button } = entry
      if (button.getAttribute('aria-label') !== label) {
        button.setAttribute('aria-label', label)
        button.setAttribute('title', label)
      }
      button.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        controller.open(target)
      }
      const anchor = node.kind === 'user' || node.kind === 'steering' ? row.querySelector('[class*="_actions"]') : null
      if (anchor) {
        host.classList.remove('dshdt-floating')
        row.classList.remove('dshdt-row')
        if (host.parentElement !== anchor) anchor.appendChild(host)
      } else {
        host.classList.add('dshdt-floating')
        row.classList.add('dshdt-row')
        if (host.parentElement !== row) row.appendChild(host)
      }
    }

    function removeThinkAction(think) {
      const entry = thinkActions.get(think)
      if (!entry) return
      entry.host.remove()
      thinkActions.delete(think)
    }

    // Reasoning rows live inside their assistant message: their action targets
    // the enclosing step, so a multi-step turn can drop one step's reasoning
    // and tool work without touching the other steps.
    function injectThinkAction(think, target, controller, t) {
      const label = t('action.tooltip.step')
      let entry = thinkActions.get(think)
      if (!entry) {
        const host = document.createElement('span')
        host.className = 'dshdt-action-host dshdt-think-action'
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dshdt-action dshdt-row-action'
        button.innerHTML = ICON_MARKUP
        host.appendChild(button)
        entry = { host, button }
        thinkActions.set(think, entry)
      }
      const { host, button } = entry
      if (button.getAttribute('aria-label') !== label) {
        button.setAttribute('aria-label', label)
        button.setAttribute('title', label)
      }
      button.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        controller.open(target)
      }
      if (host.parentElement !== think) think.appendChild(host)
    }

    // A row may only offer an action while its content still exists in the
    // model context: compaction (or another producer) can remove a turn from
    // the surface while its transcript row stays visible on purpose.
    //
    // The state snapshot describes the session as of `surfaceThrough`. Rows
    // appended after that point (a message just sent in this session, before
    // the snapshot is refreshed) are NOT "missing from the surface" — they were
    // never covered by it — so they must stay actionable. The host still
    // validates every delete.
    function rowDeletable(node, seqs, view) {
      if (!view.surfaceReady) return true
      const data = node.data || {}
      const beyondSnapshot = (seq) => typeof seq === 'number' && typeof view.surfaceThrough === 'number' && seq > view.surfaceThrough
      if (seqs.length > 0 && seqs.every(beyondSnapshot)) return true
      if (node.kind === 'turn-tail' || node.kind === 'turn-process' || node.kind === 'turn-error' || node.kind === 'model-retry') {
        if (typeof data.turn === 'number') return view.replyTurns.has(data.turn)
      }
      return seqs.some((seq) => view.surface.has(seq))
    }

    function slotCoversRow(node) {
      if (node.kind !== 'turn-tail') return false
      const closing = node.data && node.data.closing
      return Boolean(closing && closing.finalNode && closing.finalNode.messageId !== undefined)
    }

    function applyDom(snapshot, view, controller, t) {
      if (!snapshot || !snapshot.nodes || typeof snapshot.nodes.get !== 'function') return
      const animate = controller.consumeAnimate()
      const rows = document.querySelectorAll('[data-chat-flow-key]')
      let maxSeq = -1
      for (const row of rows) {
        if (!(row instanceof HTMLElement)) continue
        const key = row.getAttribute('data-chat-flow-key')
        if (!key) continue
        const node = snapshot.nodes.get(key)
        if (!node) continue
        const seqs = seqsFor(node)
        for (const seq of seqs) if (typeof seq === 'number' && seq > maxSeq) maxSeq = seq
        const hidden = isRowHidden(view.hidden, seqs)
        setRowHidden(row, hidden, animate)
        const target = hidden ? null : targetFor(node)
        const covered = target !== null || slotCoversRow(node)
        const deletable = !hidden && covered && rowDeletable(node, seqs, view)
        if (deletable && target !== null) injectRowAction(row, node, target, controller, t)
        else removeRowAction(row)
        if (!hidden && covered && !rowDeletable(node, seqs, view)) row.dataset.dshdtNoTarget = '1'
        else delete row.dataset.dshdtNoTarget
      }
      for (const think of document.querySelectorAll('[data-variant="think"]')) {
        const row = think.closest('[data-chat-flow-key]')
        const node = row ? snapshot.nodes.get(row.getAttribute('data-chat-flow-key')) : undefined
        const final = node && node.kind === 'assistant-step' ? node.data.finalNode : undefined
        const seq = final && typeof final.seq === 'number' ? final.seq : undefined
        if (typeof seq === 'number' && seq > maxSeq) maxSeq = seq
        const beyondSnapshot = typeof seq === 'number' && view.surfaceReady && seq > view.surfaceThrough
        const allowed = seq !== undefined && !view.hidden.has(seq) && (!view.surfaceReady || view.surface.has(seq) || beyondSnapshot)
        if (!allowed) removeThinkAction(think)
        else injectThinkAction(think, { mode: 'step', seq, label: 'step' }, controller, t)
      }
      // The state snapshot only covers events up to `surfaceThrough`; once the
      // transcript shows newer ones (a message just sent/streamed in this
      // session), refresh it so the ledger and the gates stay current.
      if (view.surfaceReady && maxSeq > view.surfaceThrough) controller.requestRefresh()
    }

    // --- react entries --------------------------------------------------------

    function AssistantAction({ messageId, useDeletion, controller, t }) {
      const view = useDeletion((state) => state)
      const label = t('action.tooltip.reply')
      return jsx('button', {
        type: 'button',
        className: 'dshdt-action',
        'aria-label': label,
        title: label,
        disabled: view.pending,
        onClick: () => controller.open({ mode: 'reply', messageId }),
        children: jsx(TrashIcon, {}),
      })
    }

    function ConfirmDialog({ view, controller, t }) {
      const target = view.dialog
      const mode = target && typeof target.mode === 'string' ? target.mode : 'message'
      const failure = view.failure
      return jsx(primitives.Modal, {
        open: target !== null,
        title: t(`dialog.title.${mode}`),
        closeLabel: t('dialog.cancel'),
        onClose: () => controller.close(),
        footer: jsxs(Fragment, {
          children: [
            jsx(primitives.Button, {
              variant: 'ghost',
              size: 'md',
              disabled: view.pending,
              onClick: () => controller.close(),
              children: t('dialog.cancel'),
            }),
            jsx(primitives.Button, {
              variant: 'primary',
              size: 'md',
              className: 'dshdt-danger',
              disabled: view.pending,
              onClick: () => controller.confirm(),
              children: view.pending ? t('dialog.pending') : failure ? t('dialog.retry') : t('dialog.confirm'),
            }),
          ],
        }),
        children: jsxs(Fragment, {
          children: [
            jsx('p', { className: 'dshdt-dialog-text', children: t(`dialog.desc.${mode}`) }),
            jsx('p', { className: 'dshdt-dialog-note', children: t('dialog.note') }),
            failure === null
              ? null
              : jsx('p', { className: 'dshdt-dialog-error', role: 'status', children: t(`error.${failure}`) }),
          ],
        }),
      })
    }

    function OverlayEntry({ useChat, useDeletion, controller, t }) {
      const snapshot = typeof useChat === 'function' ? useChat((state) => state) : undefined
      const view = useDeletion((state) => state)

      react.useEffect(() => {
        controller.load()
      }, [controller])

      react.useEffect(() => {
        if (snapshot === undefined) return undefined
        let scheduled = false
        const run = () => {
          scheduled = false
          applyDom(snapshot, view, controller, t)
        }
        run()
        const observer = new MutationObserver(() => {
          if (scheduled) return
          scheduled = true
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
          else window.setTimeout(run, 16)
        })
        observer.observe(document.body, { childList: true, subtree: true })
        return () => {
          observer.disconnect()
        }
      }, [snapshot, view, controller, t])

      return jsxs(Fragment, {
        children: [jsx('span', { hidden: true }), jsx(ConfirmDialog, { view, controller, t })],
      })
    }

    // --- plugin ---------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-delete-turn: dictionaries')

      const controllers = new Map()
      const controllerFor = (sessionId) => {
        let controller = controllers.get(sessionId)
        if (controller === undefined) {
          controller = new DeletionController(sessionId)
          controllers.set(sessionId, controller)
        }
        return controller
      }
      ctx.effect(
        () => () => {
          for (const controller of controllers.values()) controller.dispose()
          controllers.clear()
        },
        'dsh-delete-turn: per-session controllers',
      )

      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'delete-turn',
            order: 40,
            locale: NS,
            inject: (sessionId) => ({ hooks: { deletion: controllerFor(sessionId) }, controller: controllerFor(sessionId) }),
          },
          AssistantAction,
        ),
      )

      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: 'delete-turn',
            order: 8,
            locale: NS,
            inject: (sessionId) => ({ hooks: { deletion: controllerFor(sessionId) }, controller: controllerFor(sessionId) }),
          },
          OverlayEntry,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
