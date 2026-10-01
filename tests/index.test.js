import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ROUTE, adoptDeadRecords, apply, changedSessionIds, crashedEntries, endsCutOff, logFacts, ownerAlive, readPending, stateDir, updatePending } from '../index.js'

const HOME = join(import.meta.dirname, '..', '.scratch', 'home')
process.env.DSH_HOME = HOME
const DIR = stateDir()
const SESSIONS = join(HOME, 'sessions')

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
})

/** This process's live record and the shared pending set, as written. */
const liveOnDisk = () => JSON.parse(readFileSync(join(DIR, `live-${process.pid}.json`), 'utf8')).live
const pendingOnDisk = () => readPending(DIR).pending

/**
 * Lay each log out as the JSONL store does, `sessions/<project>/<id>/`, with
 * the file mtime at `log.mtime` (default now): the boot scan stats these.
 */
function storeLogs(logs, root = SESSIONS) {
  for (const [id, log] of Object.entries(logs)) {
    const dir = join(root, '--work--', id)
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
function mount({ agents = {}, goals = {}, resumeGoal, rejection, logs = {}, sessionsRoot = SESSIONS } = {}) {
  storeLogs(logs)
  const listeners = {}
  const routes = []
  const warnings = []
  const resumedGoals = []
  const opened = []
  const ctx = {
    logger: { warn: (text) => warnings.push(text) },
    get: (name) => {
      if (name === 'connection') return { requestRejection: () => rejection }
      // The loader row the boot scan reads its store root from; `null` drops it.
      if (name === 'loader' && sessionsRoot !== null) {
        return { entries: () => [{ options: { id: 'session-persistence-jsonl' }, fiber: { config: { root: sessionsRoot } } }] }
      }
      return undefined
    },
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

test('ownerAlive: never this pid or another boot, else the pid decides', () => {
  const here = { pid: 100, bootId: 'boot-b', alive: (pid) => pid === 200, startOf: () => undefined }
  assert.equal(ownerAlive({ pid: 100, bootId: 'boot-b' }, here), false, 'a record with our own pid is a predecessor')
  assert.equal(ownerAlive({ pid: 200, bootId: 'boot-a' }, here), false, 'written before a reboot')
  assert.equal(ownerAlive({ pid: 200, bootId: 'boot-b' }, here), true, 'still running')
  assert.equal(ownerAlive({ pid: 300, bootId: 'boot-b' }, here), false, 'exited')
  assert.equal(ownerAlive({ pid: 200 }, { ...here, bootId: undefined }), true, 'no boot id off Linux: the pid alone decides')
})

test("boot adopts dead processes' records and leaves a running one's alone", () => {
  mkdirSync(DIR, { recursive: true })
  const record = (pid, bootId, live) => writeFileSync(join(DIR, `live-${pid}.json`), JSON.stringify({ version: 2, pid, bootId, live }))
  writeFileSync(join(DIR, 'pending.json'), JSON.stringify({ version: 2, pending: { a: { turn: true, since: 1 }, b: { goal: true } }, scannedThrough: 5 }))
  record(200, 'boot-b', { running: { turn: true } })
  record(201, 'boot-a', { a: { turn: true, since: 2 }, rebooted: { turn: true } })
  record(202, 'boot-b', { exited: { goal: true } })
  const state = adoptDeadRecords(DIR, () => {}, { pid: 100, bootId: 'boot-b', alive: (pid) => pid === 200, startOf: () => undefined })
  assert.deepEqual(Object.keys(state.pending).sort(), ['a', 'b', 'exited', 'rebooted'])
  assert.equal(state.pending.a.since, 2, 'the newer live entry wins over an older pending one')
  assert.equal(state.scannedThrough, 5)
  assert.deepEqual(readdirSync(DIR).sort(), ['live-200.json', 'pending.json', 'pending.lock.sqlite'], 'a running process keeps its record')
  assert.deepEqual(pendingOnDisk(), state.pending)
})

test('adoption preserves live records when publication fails, and newer pending entries win', () => {
  mkdirSync(DIR, { recursive: true })
  const path = join(DIR, 'live-201.json')
  writeFileSync(path, JSON.stringify({ version: 2, pid: 201, live: { s: { since: 1, turn: true } } }))
  updatePending(DIR, (state) => { state.pending.s = { since: 2, goal: true } })
  const tmp = join(DIR, `pending.json.${process.pid}.tmp`)
  mkdirSync(tmp)
  const here = { pid: 100, alive: () => false, startOf: () => undefined }
  assert.throws(() => adoptDeadRecords(DIR, () => {}, here))
  assert.equal(existsSync(path), true, 'the only live record must survive a failed write')
  assert.deepEqual(readPending(DIR).pending.s, { since: 2, goal: true })
  rmSync(tmp, { recursive: true })
  assert.deepEqual(adoptDeadRecords(DIR, () => {}, here).pending.s, { since: 2, goal: true })
  assert.equal(existsSync(path), false, 'only the successful publication retires the live record')
})

test('parallel processes retain every pending edit and a killed writer releases its lock', async () => {
  const moduleUrl = new URL('../index.js', import.meta.url).href
  const launch = (code) => spawn(process.execPath, ['--eval', code], { env: { ...process.env, RESTORE_TEST_DIR: DIR }, stdio: ['ignore', 'pipe', 'pipe'] })
  const completion = (child) => new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 || signal === 'SIGKILL' ? resolve() : reject(new Error(stderr)))
  })
  await Promise.all(Array.from({ length: 6 }, (_, worker) => {
    const child = launch(`import {updatePending} from ${JSON.stringify(moduleUrl)};
      for (let n=0;n<10;n++) updatePending(process.env.RESTORE_TEST_DIR, state => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
        state.pending[${JSON.stringify(worker)}+'-'+n]={since:n,turn:true};
      });`)
    return completion(child)
  }))
  assert.equal(Object.keys(readPending(DIR).pending).length, 60, 'no read-modify-write update may be lost')

  const child = launch(`import {updatePending} from ${JSON.stringify(moduleUrl)};
    updatePending(process.env.RESTORE_TEST_DIR, state => {
      state.pending.unpublished={turn:true};
      process.stdout.write('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
    });`)
  const done = completion(child)
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve)
      child.once('error', reject)
      child.once('exit', () => reject(new Error('writer exited before taking the lock')))
    })
  } finally {
    child.kill('SIGKILL')
    await done
  }
  updatePending(DIR, state => { state.pending.afterCrash = { turn: true } })
  assert.equal(readPending(DIR).pending.unpublished, undefined)
  assert.equal(readPending(DIR).pending.afterCrash.turn, true)
})

test('the boot scan reads the store root from the loader row, and skips without one', async () => {
  const moved = join(HOME, 'elsewhere')
  const now = Date.now()
  const logs = { crashed: { events: [{ type: 'turn/start', time: now - 60_000 }] } }
  storeLogs(logs, moved)
  const found = mount({ logs, sessionsRoot: moved })
  assert.deepEqual((await found.request('GET')).body.pending.map((p) => p.id), ['crashed'])

  rmSync(DIR, { recursive: true, force: true })
  const none = mount({ logs, sessionsRoot: null })
  assert.deepEqual((await none.request('GET')).body.pending, [])
  assert.match(none.warnings.join('\n'), /no session-persistence-jsonl row/)
})

test('a running turn is on disk until it ends, and survives a shutdown dispose', () => {
  const { emit } = mount()
  emit(session('s1'), 'turn/start')
  assert.equal(liveOnDisk().s1.turn, true)
  assert.equal(liveOnDisk().s1.cwd, '/work/s1')

  emit(session('s1'), 'turn/end', { reason: { kind: 'completed' } })
  assert.deepEqual(liveOnDisk(), {})

  emit(session('s1'), 'turn/start')
  emit(session('s1'), 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  assert.equal(liveOnDisk().s1.turn, true, 'a disposed turn is what a reboot looks like')

  emit(session('s1'), 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.deepEqual(liveOnDisk(), {}, 'a user stop is deliberate')
})

test('an armed goal is tracked through activation changes', () => {
  const { listeners } = mount()
  listeners['goal/activation-changed']({ sessionId: 'g1', goal: { id: 'x', revision: 1, activation: 'armed' } })
  assert.equal(liveOnDisk().g1.goal, true)
  listeners['goal/activation-changed']({ sessionId: 'g1', goal: { id: 'x', revision: 1, activation: 'disarmed' } })
  assert.deepEqual(liveOnDisk(), {})
})

test('subagent sessions are not tracked', () => {
  const { emit } = mount()
  emit(session('child', { origin: 'subagent' }), 'turn/start')
  assert.deepEqual(liveOnDisk(), {})
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
  assert.deepEqual(liveOnDisk(), {})

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
  assert.deepEqual(Object.keys(pendingOnDisk()), ['held'])
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
  assert.deepEqual(pendingOnDisk(), {})
})

test('restore and dismiss report a failed save and keep recovery entries on disk', async () => {
  mount().emit(session('s'), 'turn/start')
  const { request } = mount()
  await request('GET') // finish the boot scan before refusing subsequent writes
  mkdirSync(join(DIR, `pending.json.${process.pid}.tmp`))
  for (const action of ['dismiss', 'restore']) {
    const result = await request('POST', { action })
    assert.equal(result.status, 500, action)
    assert.match(result.body.message, /cannot save recovery state/)
    assert.deepEqual(Object.keys(pendingOnDisk()), ['s'])
  }
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
  assert.deepEqual(Object.keys(pendingOnDisk()), ['s'], 'nothing above touched the pending set')

  const fenced = mount({ rejection: 403 })
  assert.equal((await fenced.request('GET')).status, 403, 'the connection fence wins')
})

test('an unreadable state file is reported and replaced', () => {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, 'pending.json'), '{not json')
  const { warnings } = mount()
  assert.match(warnings[0], /ignoring unreadable/)
  assert.deepEqual(readPending(DIR), { pending: {}, scannedThrough: 0 })
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
  assert.deepEqual(changedSessionIds(SESSIONS, now - 60_000), ['fresh'],
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

test('two restores at once resume each session once', async () => {
  mount().emit(session('s'), 'turn/start')
  const agent = fakeAgent('s')
  const { request } = mount({ agents: { s: agent } })
  const [a, b] = await Promise.all([request('POST', { action: 'restore' }), request('POST', { action: 'restore' })])
  assert.equal(agent.sent.length, 1, 'a second tab clicking Restore must not send continue twice')
  assert.deepEqual(a.body, b.body, 'both callers get the one outcome')
})

test('ownerAlive: a pid reused within the same boot is told apart by its start time', () => {
  const here = { pid: 100, bootId: 'boot-b', alive: () => true, startOf: (pid) => (pid === 200 ? '5000' : undefined) }
  assert.equal(ownerAlive({ pid: 200, bootId: 'boot-b', start: '5000' }, here), true, 'the writer itself')
  assert.equal(ownerAlive({ pid: 200, bootId: 'boot-b', start: '4000' }, here), false, 'another process now holds the pid')
  assert.equal(ownerAlive({ pid: 200, bootId: 'boot-b' }, here), true, 'a record without a start time falls back to the pid')
})

test('ownerAlive reads real start times from procfs', { skip: !existsSync('/proc/self/stat') }, async () => {
  const child = spawn('sleep', ['30'])
  try {
    await new Promise((resolve) => child.once('spawn', resolve))
    // Field 22, counted independently: fields 3.. follow the last ')'.
    const stat = readFileSync(`/proc/${String(child.pid)}/stat`, 'utf8')
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[22 - 3]
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    assert.equal(ownerAlive({ pid: child.pid, bootId, start }), true, 'the running writer')
    assert.equal(ownerAlive({ pid: child.pid, bootId, start: `${start}1` }), false, 'same pid, another process')
  } finally {
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
  }
  assert.equal(ownerAlive({ pid: child.pid }), false, 'gone once it exits')
})
