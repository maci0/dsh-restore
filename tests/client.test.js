/**
 * Browser half: the restore bar.
 *
 * The file is loaded the way the client module system loads it (a script that
 * registers a lazy-CJS factory on `window.__ModuleLoader__`), imported as a
 * real module over a stubbed `window`, then rendered over a minimal React
 * (element trees, `useState`, a run-once `useEffect`) and a stubbed `fetch`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Element trees plus the hooks the bar uses; state persists across renders. */
function createReact() {
  const hooks = { cells: [], index: 0, effects: [] }
  return {
    hooks,
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat(Infinity) } }),
    useState(initial) {
      const cell = hooks.index++
      if (!Object.hasOwn(hooks.cells, cell)) hooks.cells[cell] = initial
      return [hooks.cells[cell], (next) => { hooks.cells[cell] = next }]
    },
    useEffect(effect) {
      const cell = hooks.index++
      if (!Object.hasOwn(hooks.cells, cell)) {
        hooks.cells[cell] = true
        hooks.effects.push(effect)
      }
    },
  }
}

let loads = 0

/** Import `lib/client.js` fresh and return its registration and slot entry. */
async function loadClient() {
  let registration
  globalThis.window = { __ModuleLoader__: { load: (spec) => { registration = spec } } }
  await import(`../lib/client.js?load=${String(++loads)}`)
  const React = createReact()
  const exports = registration.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  const slots = []
  const opened = []
  exports.apply({
    uiWorkspace: { openSession: (id) => opened.push(id) },
    slots: {
      inject: (_name, register) => register(),
      register: (options, component) => { slots.push({ options, component }); return () => {} },
    },
  })
  return { registration, React, slots, opened }
}

/** Stub `fetch`: GET answers `pending`, each POST answers the next queued body. */
function stubFetch(pending, posts = []) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, ...init })
    const body = (init.method ?? 'GET') === 'GET' ? { pending } : posts.shift()
    return { ok: true, status: 200, json: async () => body }
  }
  return calls
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** Text of every string under a rendered tree. */
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ')
  return text(node.props?.children)
}

/** Every element of one type under a tree. */
function all(node, type, out = []) {
  if (Array.isArray(node)) node.forEach((child) => all(child, type, out))
  else if (node && typeof node === 'object') {
    if (node.type === type) out.push(node)
    all(node.props?.children, type, out)
  }
  return out
}

/** Mount the bar: render, run the load effect, let the fetch land, render again. */
async function mount(pending, posts, byId = {}) {
  const calls = stubFetch(pending, posts)
  const client = await loadClient()
  const { component, options } = client.slots[0]
  const props = { useSessions: (select) => select({ byId }), ...options.inject() }
  const render = () => { client.React.hooks.index = 0; return component(props) }
  render()
  for (const effect of client.React.hooks.effects.splice(0)) effect()
  await settle()
  return { ...client, calls, render }
}

const ENTRY = { id: 's1', cwd: '/work/demo', since: 0, turn: true, goal: false }

test('registers one app-level overlay entry', async () => {
  const { registration, slots } = await loadClient()
  assert.equal(registration.id, 'dsh-resume-all')
  assert.equal(slots.length, 1)
  assert.equal(slots[0].options.name, 'shell.overlay')
  assert.equal(slots[0].options.id, 'resume-all')
})

test('renders nothing when nothing is pending', async () => {
  const { render } = await mount([])
  assert.equal(render(), null)
})

test('shows the count, lists sessions by title, and opens one on click', async () => {
  const pending = [ENTRY, { ...ENTRY, id: 's2', title: 'port the renderer', goal: true }]
  const { render, opened } = await mount(pending, [], { s1: { title: 'from the catalog' }, s2: { title: 'stale catalog title' } })
  assert.match(text(render()), /stopped while 2 sessions were still working/)

  all(render(), 'button').find((b) => text(b) === 'Show').props.onClick()
  const items = all(render(), 'li')
  assert.deepEqual(items.map(text), ['from the catalog · turn', 'port the renderer · goal'],
    'a scanned title wins over the catalog; a session with neither shows its folder')
  all(items[1], 'button')[0].props.onClick()
  assert.deepEqual(opened, ['s2'])
})

test('Restore posts JSON and keeps what the host could not settle', async () => {
  const { render, calls } = await mount([ENTRY, { ...ENTRY, id: 's2' }], [{ results: [], pending: [{ ...ENTRY, id: 's2' }] }])
  await all(render(), 'button').find((b) => text(b) === 'Restore').props.onClick()
  const post = calls.at(-1)
  assert.equal(post.method, 'POST')
  assert.equal(post.headers['content-type'], 'application/json', 'a JSON body forces a CORS preflight')
  assert.deepEqual(JSON.parse(post.body), { action: 'restore' })
  assert.match(text(render()), /1 session could not be resumed yet/)
})

test('Dismiss clears the bar', async () => {
  const { render } = await mount([ENTRY], [{ results: [], pending: [] }])
  await all(render(), 'button').find((b) => text(b) === 'Dismiss').props.onClick()
  assert.equal(render(), null)
})
