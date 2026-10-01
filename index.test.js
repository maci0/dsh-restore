import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { ROUTE, apply, changedSessionIds, crashedEntries, endsCutOff, logFacts, promoteLive, readState, sessionsRoot, statePath } from './index.js'

const HOME = join(import.meta.dirname, '.scratch', 'home')
process.env.DSH_HOME = HOME
const FILE = statePath()

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
})

const onDisk = () => JSON.parse(readFileSync(FILE, 'utf8'))

/**
 * Lay each log out as the JSONL store does, `sessions/<project>/<id>/`, with
 * the file mtime at `log.mtime` (default now): the boot scan stats these.
 */
function storeLogs(logs) {
  for (const [id, log] of Object.entries(logs)) {
    const dir = join(HOME, 'sessions', '--work--', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, '')
    const mtime = new Date(log.mtime ?? Date.now())
    utimesSync(file, mtime, mtime)
  }
}

/**
 * Mount the plugin against fakes. `agents` maps session id to a fake agent or
 * to an `{ error }` resolution; `goals` maps session id to a goal view.
 */
function mount({ agents = {}, goals = {}, resumeGoal, rejection, logs = {} } = {}) {
  storeLogs(logs)
  const listeners = {}
  const routes = []
  const warnings = []
  const resumedGoals = []
  const opened = []
  const ctx = {
    logger: { warn: (text) => warnings.push(text) },
    get: (name) => (name === 'connection' ? { requestRejection: () => rejection } : undefined),
    sessions: { get: (id) => ({ id, header: { cwd: `/work/${id}` } }) },
    sessionController: {
      resolveAgent: async (id) => {
        const a = agents[id]
        if (a === undefined) return { error: { code: 'session/not-found' } }
        return 'error' in a ? a : { agent: a }
      },
    },
    goals: {
      get: (agent) => goals[agent.id],
      resume: resumeGoal ?? ((agent, ref) => resumedGoals.push([agent.id, ref])),
    },
    // `logs` maps session id to { header, events } (or { throws: true }); see storeLogs.
    sessionPersistence: {
      open: async (id) => {
        opened.push(id)
        if (logs[id].throws) throw new Error('unknown event vocabulary')
        const header = { id, cwd: `/work/${id}`, ...logs[id].header }
        return { header, read: async () => ({ events: logs[id].events }), close: async () => {} }
      },
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    on: (event, fn) => { listeners[event] = fn; return () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  assert.equal(routes.length, 1)
  assert.deepEqual([routes[0].kind, routes[0].path], ['exact', ROUTE])

  /** Call the route the way the web server does; resolves to { status, body }. */
  const request = async (method, body, contentType = 'application/json') => {
    const chunks = body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]
    const req = {
      method,
      url: ROUTE,
      headers: { 'content-type': contentType },
      async *[Symbol.asyncIterator]() { yield* chunks },
    }
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(text) { this.text = text },
    }
    await routes[0].handler(req, res)
    return { status: res.statusCode, body: res.text ? JSON.parse(res.text) : undefined }
  }
  const emit = (session, type, data = {}) => listeners['session/event'](session, { type, data })
  return { listeners, request, emit, warnings, resumedGoals, opened }
}

const session = (id, header = { cwd: `/work/${id}` }) => ({ id, header })
const fakeAgent = (id, status = 'idle') => ({ id, status, sent: [], followup(m) { this.sent.push(m) } })

test('promoteLive keeps old pending and lets newer live entries win', () => {
  const state = { live: { a: { turn: true, since: 2 } }, pending: { a: { turn: true, since: 1 }, b: { goal: true } } }
  assert.deepEqual(promoteLive(state), { live: {}, pending: { a: { turn: true, since: 2 }, b: { goal: true } } })
})

test('a running turn is on disk until it ends, and survives a shutdown dispose', () => {
  const { emit } = mount()
  emit(session('s1'), 'turn/start')
  assert.equal(onDisk().live.s1.turn, true)
  assert.equal(onDisk().live.s1.cwd, '/work/s1')

  emit(session('s1'), 'turn/end', { reason: { kind: 'completed' } })
  assert.deepEqual(onDisk().live, {})

  emit(session('s1'), 'turn/start')
  emit(session('s1'), 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  assert.equal(onDisk().live.s1.turn, true, 'a disposed turn is what a reboot looks like')

  emit(session('s1'), 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.deepEqual(onDisk().live, {}, 'a user stop is deliberate')
})

test('an armed goal is tracked through activation changes', () => {
  const { listeners } = mount()
  listeners['goal/activation-changed']({ sessionId: 'g1', goal: { id: 'x', revision: 1, activation: 'armed' } })
  assert.equal(onDisk().live.g1.goal, true)
  listeners['goal/activation-changed']({ sessionId: 'g1', goal: { id: 'x', revision: 1, activation: 'disarmed' } })
  assert.deepEqual(onDisk().live, {})
})

test('subagent sessions are not tracked', () => {
  const { emit } = mount()
  emit(session('child', { origin: 'subagent' }), 'turn/start')
  assert.deepEqual(onDisk().live, {})
})

test('after a restart GET lists the in-flight set and restore resumes it', async () => {
  const first = mount()
  for (const id of ['goal', 'plain', 'busy', 'held', 'gone']) first.emit(session(id), 'turn/start')

  // Process dies here; a fresh mount reads what was left on disk.
  const goalAgent = fakeAgent('goal')
  const plainAgent = fakeAgent('plain')
  const busyAgent = fakeAgent('busy', 'running')
  const second = mount({
    agents: { goal: goalAgent, plain: plainAgent, busy: busyAgent, held: { error: { code: 'session/writer-held' } } },
    goals: { goal: { id: 'g-1', revision: 3, phase: 'active' }, plain: { id: 'g-2', revision: 1, phase: 'paused' } },
  })
  assert.deepEqual(onDisk().live, {})

  const listed = await second.request('GET')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.pending.map((p) => p.id).sort(), ['busy', 'goal', 'gone', 'held', 'plain'])
  assert.equal(listed.body.pending.find((p) => p.id === 'plain').cwd, '/work/plain')

  const restored = await second.request('POST', { action: 'restore' })
  assert.equal(restored.status, 200)
  const outcome = Object.fromEntries(restored.body.results.map((r) => [r.id, r.outcome]))
  assert.deepEqual(outcome, {
    goal: 'goal resumed',
    plain: 'continued',
    busy: 'already running',
    held: 'skipped: session/writer-held',
    gone: 'skipped: session/not-found',
  })
  assert.deepEqual(second.resumedGoals, [['goal', { id: 'g-1', revision: 3 }]])
  assert.equal(goalAgent.sent.length, 0, 'the goal driver queues the round, not us')
  assert.equal(plainAgent.sent[0].content[0].text, 'continue', 'a paused goal is left alone; the turn gets a continue')
  assert.equal(busyAgent.sent.length, 0)
  assert.deepEqual(restored.body.pending.map((p) => p.id), ['held'], 'only a retryable session stays pending')
  assert.deepEqual(Object.keys(onDisk().pending), ['held'])
})

test('a failing goal resume falls back to continue', async () => {
  mount().emit(session('s'), 'turn/start')
  const agent = fakeAgent('s')
  // The goal service refuses a resume once the round budget is spent.
  const { request, warnings } = mount({
    agents: { s: agent },
    goals: { s: { id: 'g', revision: 1, phase: 'active' } },
    resumeGoal: () => { throw new Error('round budget spent') },
  })
  const { body } = await request('POST', { action: 'restore' })
  assert.deepEqual(body.results, [{ id: 's', outcome: 'continued' }])
  assert.equal(agent.sent[0].content[0].text, 'continue')
  assert.match(warnings[0], /round budget spent/)
})

test('dismiss forgets the pending set', async () => {
  mount().emit(session('s'), 'turn/start')
  const { request } = mount()
  assert.deepEqual((await request('POST', { action: 'dismiss' })).body, { results: [], pending: [] })
  assert.deepEqual((await request('GET')).body, { pending: [] })
  assert.deepEqual(onDisk().pending, {})
})

test('the route refuses what it should', async () => {
  mount().emit(session('s'), 'turn/start')
  const { request } = mount()
  assert.equal((await request('POST', 'action=restore', 'application/x-www-form-urlencoded')).status, 415,
    'a plain form post from another origin cannot restore')
  assert.equal((await request('POST', { action: 'nuke' })).status, 400)
  assert.equal((await request('POST', '{not json')).status, 400)
  assert.equal((await request('POST', 'x'.repeat(4096))).status, 400, 'oversized body')
  assert.equal((await request('DELETE')).status, 405)
  assert.deepEqual(Object.keys(onDisk().pending), ['s'], 'nothing above touched the pending set')

  const fenced = mount({ rejection: 403 })
  assert.equal((await fenced.request('GET')).status, 403, 'the connection fence wins')
})

test('an unreadable state file is reported and replaced', () => {
  mkdirSync(join(HOME, 'storages'), { recursive: true })
  writeFileSync(FILE, '{not json')
  const { warnings } = mount()
  assert.match(warnings[0], /ignoring unreadable/)
  assert.deepEqual(readState(FILE), { live: {}, pending: {}, scannedThrough: 0 })
})

test('endsCutOff reads the last turn edge', () => {
  const start = { type: 'turn/start', time: 1 }
  const end = (kind, reason) => ({ type: 'turn/end', time: 2, data: { reason: { kind, ...(reason && { reason }) } } })
  const tail = { type: 'assistant/message', time: 3 }
  assert.equal(endsCutOff([start, tail]), true, 'open turn')
  assert.equal(endsCutOff([start, end('interrupted'), tail]), true, 'closer written when a crashed session reopened')
  assert.equal(endsCutOff([start, end('completed')]), false)
  assert.equal(endsCutOff([start, end('aborted', { kind: 'disposed' })]), false, 'clean shutdown: the live record covers it')
  assert.equal(endsCutOff([start, end('error'), start]), true, 'only the last edge counts')
  assert.equal(endsCutOff([tail]), false, 'no turn in the tail')
  assert.equal(endsCutOff([]), false)
})

test('crashedEntries skips what was already offered and old history', () => {
  const now = 10 * 24 * 3600_000
  const day = 24 * 3600_000
  const found = [
    { id: 'fresh', cwd: '/a', time: now - day, title: 'port the renderer', goal: true },
    { id: 'offered', cwd: '/b', time: now - 2 * day },
    { id: 'ancient', cwd: '/c', time: now - 5 * day },
  ]
  const { entries, through } = crashedEntries(found, now - 2 * day, now)
  assert.deepEqual(Object.keys(entries), ['fresh'])
  assert.deepEqual(entries.fresh, { cwd: '/a', since: now - day, turn: true, goal: true, title: 'port the renderer' })
  assert.equal(through, now - day)
  assert.deepEqual(crashedEntries([], 7, now), { entries: {}, through: 7 })
})

test('the boot scan offers sessions a crash cut off before the plugin knew them', async () => {
  const now = Date.now()
  const open = [{ type: 'turn/start', time: now - 60_000 }, { type: 'tool/call', time: now - 50_000 }]
  const closed = [{ type: 'turn/start', time: now - 60_000 }, { type: 'turn/end', time: now - 50_000, data: { reason: { kind: 'completed' } } }]
  const logs = {
    crashed: { events: open },
    reopened: { events: [...open, { type: 'turn/end', time: now - 50_000, data: { reason: { kind: 'interrupted' } } }] },
    done: { events: closed },
    child: { header: { origin: 'subagent' }, events: open },
    stale: { mtime: now - 30 * 24 * 3600_000, events: open },
    broken: { throws: true },
  }
  const plain = fakeAgent('crashed')
  const { request, warnings, opened } = mount({ logs, agents: { crashed: plain } })
  const listed = await request('GET')
  assert.deepEqual(listed.body.pending.map((p) => p.id).sort(), ['crashed', 'reopened'])
  assert.equal(listed.body.pending.find((p) => p.id === 'crashed').cwd, '/work/crashed')
  assert.match(warnings[0], /skipped 1 session log/)
  assert.deepEqual(opened.sort(), ['broken', 'child', 'crashed', 'done', 'reopened'], 'a file untouched in the window is never opened')

  await request('POST', { action: 'dismiss' })
  const again = mount({ logs })
  assert.deepEqual((await again.request('GET')).body.pending, [], 'a dismissed crash stays dismissed across restarts')
})

test('a recorded entry wins over the scan of the same session', async () => {
  mount().listeners['goal/activation-changed']({ sessionId: 's', goal: { id: 'g', revision: 1, activation: 'armed' } })
  const { request } = mount({ logs: { s: { events: [{ type: 'turn/start', time: Date.now() }] } } })
  const [entry] = (await request('GET')).body.pending
  assert.equal(entry.goal, true)
})

test('changedSessionIds walks the store by mtime', () => {
  assert.deepEqual(changedSessionIds(join(HOME, 'nowhere'), 0), [], 'no store yet')
  const now = Date.now()
  storeLogs({ fresh: {}, old: { mtime: now - 3600_000 }, '~0041encoded': {} })
  assert.deepEqual(changedSessionIds(sessionsRoot(), now - 60_000), ['fresh'],
    'old files and encoded directory names are skipped')
})

test('logFacts takes the latest title and goal state', () => {
  const title = (t) => ({ type: 'session/title', data: { title: t } })
  const goal = (operation, phase) => ({ type: 'goal/change', data: { operation, ...(phase && { goal: { phase } }) } })
  assert.deepEqual(logFacts([]), { title: undefined, goal: false })
  assert.deepEqual(logFacts([title('a'), goal('create', 'active'), title('b')]), { title: 'b', goal: true })
  assert.equal(logFacts([goal('create', 'active'), goal('pause', 'paused')]).goal, false)
  assert.equal(logFacts([goal('create', 'active'), goal('clear')]).goal, false)
  assert.equal(logFacts([goal('pause', 'paused'), goal('resume', 'active')]).goal, true)
})
