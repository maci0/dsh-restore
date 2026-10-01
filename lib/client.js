/**
 * dsh-restore: browser half.
 *
 * A restore bar at the top of the app, like a browser's "didn't shut down
 * correctly" prompt. It reads the host's pending set once on load from
 * `GET /restore`; Restore and Dismiss post to the same route. Each listed
 * session opens on click.
 *
 * Plain JavaScript on purpose: the client module system serves this file as a
 * lazy-CJS factory on `window.__ModuleLoader__`; `react` is provided.
 */

window.__ModuleLoader__.load({
  id: 'dsh-restore',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const ROUTE = '/restore'

    // The overlay layer covers the whole window with pointer-events off and
    // turns them back on for its direct children, so the bar itself is the
    // child and sizes to its content: a full-width wrapper would eat clicks.
    const CSS = [
      '.restore-bar{position:absolute;top:12px;left:50%;transform:translateX(-50%);box-sizing:border-box;max-width:min(640px,calc(100% - 32px));display:flex;flex-direction:column;gap:8px;padding:10px 12px 10px 14px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-specific-tip);box-shadow:0 4px 16px rgba(0,0,0,.12);font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.restore-row{display:flex;align-items:center;gap:10px}',
      '.restore-text{flex:1;min-width:0}',
      '.restore-btn{flex:none;appearance:none;font:inherit;font-size:12px;padding:3px 12px;cursor:pointer;color:var(--dsw-alias-label-primary);background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px}',
      '.restore-btn-primary{border-color:var(--dsw-alias-label-primary);font-weight:500}',
      '.restore-btn:disabled{cursor:default;opacity:.5}',
      '.restore-list{margin:0;padding:0;list-style:none;max-height:180px;overflow:auto}',
      '.restore-item{appearance:none;font:inherit;font-size:12px;background:none;border:0;padding:2px 0;cursor:pointer;color:var(--dsw-alias-label-secondary);text-align:left;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.restore-item:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
      '.restore-item:focus-visible,.restore-btn:focus-visible{outline:2px solid var(--dsw-alias-border-l2);outline-offset:2px}',
    ].join('')

    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
    }

    /** POST one action and return the parsed body; throws on a non-2xx answer. */
    const post = async (action) => {
      const res = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error(`${ROUTE} answered ${res.status}`)
      return res.json()
    }

    const basename = (path) => (path ? path.split(/[\\/]/).filter(Boolean).pop() ?? path : '')

    /** What a pending session is called in the list: its title, else its folder. */
    const labelOf = (entry, summary) => {
      const what = entry.goal ? 'goal' : 'turn'
      return `${entry.title || summary?.title || basename(entry.cwd) || entry.id} · ${what}`
    }

    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

    function RestoreBar({ useSessions, openSession }) {
      const byId = useSessions((s) => s.byId)
      const [pending, setPending] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const generation = React.useRef(0)

      React.useEffect(() => {
        const controller = new AbortController()
        const load = () => {
          const started = ++generation.current
          fetch(ROUTE, { headers: { accept: 'application/json' }, signal: controller.signal })
            .then((res) => { if (!res.ok) throw new Error(`${ROUTE} answered ${res.status}`); return res.json() })
            .then((body) => { if (started === generation.current) setPending(Array.isArray(body.pending) ? body.pending : []) })
            .catch(() => {})
        }
        // Re-read when the tab comes back into view: another tab may have
        // restored or dismissed the set meanwhile.
        const onVisible = () => { if (document.visibilityState === 'visible') load() }
        load()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          generation.current += 1
          controller.abort()
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      if (pending.length === 0) return null

      const act = async (action) => {
        if (busy) return
        generation.current += 1
        setBusy(true)
        setNote(null)
        try {
          // The host answers with whatever it could not settle (a lock held
          // elsewhere); that stays listed so Restore can be tried again.
          const { pending: left } = await post(action)
          generation.current += 1
          setPending(left)
          if (left.length > 0) setNote(`${plural(left.length, 'session')} could not be resumed yet.`)
        } catch (error) {
          setNote(String(error.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'restore-bar', role: 'status' },
        h('div', { className: 'restore-row' },
          h('span', { className: 'restore-text' },
            note ?? `DeepSeek Harness stopped while ${plural(pending.length, 'session')} ${pending.length === 1 ? 'was' : 'were'} still working.`),
          h('button', {
            className: 'restore-btn',
            onClick: () => setOpen(!open),
            'aria-expanded': open,
          }, open ? 'Hide' : 'Show'),
          h('button', { className: 'restore-btn restore-btn-primary', onClick: () => act('restore'), disabled: busy },
            busy ? '…' : 'Restore'),
          h('button', { className: 'restore-btn', onClick: () => act('dismiss'), disabled: busy }, 'Dismiss'),
        ),
        open && h('ul', { className: 'restore-list' },
          pending.map((entry) => h('li', { key: entry.id },
            h('button', { className: 'restore-item', title: entry.cwd, onClick: () => openSession(entry.id) },
              labelOf(entry, byId?.[entry.id])),
          )),
        ),
      )
    }

    exports.inject = ['slots', 'uiWorkspace']

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'restore',
        inject: () => ({ openSession: (id) => ctx.uiWorkspace.openSession(id) }),
      }, RestoreBar))
    }

    exports.apply = apply
    return module.exports
  },
})
