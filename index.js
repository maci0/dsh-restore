/**
 * dsh-restore: offer to resume every session that was mid-flight when the
 * harness last went down (reboot, crash, kill), the way a browser offers to
 * restore its tabs.
 *
 * While running, each harness process keeps its own live record listing every
 * session with a turn in progress or a goal armed, rewritten on every change,
 * so whatever is on disk when the process dies is its in-flight set. At the
 * next start, records of processes that are gone move to the shared `pending`
 * set. A boot scan of the stored logs adds every session whose last turn no
 * process closed (a hard crash, including one from before this plugin was
 * installed), and the browser half shows a restore bar.
 * Restore resumes a session's goal when it is still `active` (the harness
 * disarms every goal on restart) and sends `continue` to any other session.
 *
 * Route `/restore`:
 *   GET                             → { pending: [{ id, cwd, since, turn, goal }] }
 *   POST { "action": "restore" }    → { results: [{ id, outcome }], pending }
 *   POST { "action": "dismiss" }    → { results: [], pending: [] }
 * `pending` after a POST is what the host could not settle (a writer lock
 * held by another process, a gateway fault), kept for the next restore.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

export const name = 'restore'
export const inject = ['webServer', 'sessionController', 'goals', 'sessions', 'sessionPersistence']

/** The route the browser half reads and posts to. */
export const ROUTE = '/restore'
const CONTINUE_MESSAGE = 'continue'
const STATE_VERSION = 2
/** Cut-off turns older than this are history, not a crash to recover from. */
const MAX_CRASH_AGE_MS = 3 * 24 * 60 * 60 * 1000
/** Largest POST body accepted; the real ones are a few dozen bytes. */
const MAX_BODY_BYTES = 1024

/** The harness home: `$DSH_HOME`, else `~/.dsh`, resolved like the harness resolves it. */
function dshHome(env = process.env) {
  return resolve(env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh'))
}

/**
 * `$DSH_HOME/storages/dsh-restore/`: `pending.json`, shared by every
 * harness process on this home, and one `live-<pid>.json` per process, which
 * only that process writes, so two processes never overwrite each other.
 */
export function stateDir(env = process.env) {
  return join(dshHome(env), 'storages', 'dsh-restore')
}

/**
 * Read one state file. Missing is `undefined`; a malformed file is reported
 * and treated as missing, since it only ever holds this plugin's own record.
 */
function readRecord(path, warn) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.version !== STATE_VERSION) throw new Error(`unsupported version ${parsed?.version}`)
    return parsed
  } catch (error) {
    warn(`dsh-restore: ignoring unreadable ${path}: ${error.message}`)
    return undefined
  }
}

/** Atomic write: a crash mid-write leaves the previous file, never a torn one. */
function writeRecord(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, ...value }, null, 2))
  renameSync(tmp, path)
}

/**
 * The shared pending set. `scannedThrough` is the newest log time already
 * offered, so a dismissed crash is not offered again.
 * @returns {{ pending: Record<string, Entry>, scannedThrough: number }}
 */
export function readPending(dir, warn = () => {}) {
  const record = readRecord(join(dir, 'pending.json'), warn)
  return { pending: record?.pending ?? {}, scannedThrough: record?.scannedThrough ?? 0 }
}

/** This machine boot, so a record written before a reboot is known dead; undefined off Linux. */
function currentBootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return undefined
  }
}

/** Whether a process exists (EPERM means it does, owned by someone else). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Whether the process that wrote a live record is still running: never when it
 * carries this process's own pid or another boot's id, else when its pid
 * exists. A pid reused within the same boot reads as alive, so that record is
 * offered once its new holder exits.
 * @param {{ pid: number, bootId?: string }} owner - the record's writer.
 * @param here - this process's identity and liveness probe.
 */
export function ownerAlive(owner, here = { pid: process.pid, bootId: currentBootId(), alive: pidAlive }) {
  if (owner.pid === here.pid) return false
  if (owner.bootId !== undefined && here.bootId !== undefined && owner.bootId !== here.bootId) return false
  return here.alive(owner.pid)
}

/**
 * Boot step: fold every live record whose process is gone into the shared
 * pending set (a newer live entry wins) and delete that record. Records of
 * processes still running are left to them.
 */
export function adoptDeadRecords(dir, warn = () => {}, here = undefined) {
  const state = readPending(dir, warn)
  let files = []
  try {
    files = readdirSync(dir)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  for (const file of files) {
    if (!/^live-\d+\.json$/u.test(file)) continue
    const record = readRecord(join(dir, file), warn)
    if (record !== undefined && ownerAlive(record, here)) continue
    state.pending = { ...state.pending, ...(record?.live ?? {}) }
    rmSync(join(dir, file), { force: true })
  }
  writeRecord(join(dir, 'pending.json'), state)
  return state
}

/**
 * The JSONL store root, read from its loader row so a moved store is scanned
 * where it lives. Undefined when the profile persists sessions another way.
 */
function jsonlRoot(ctx) {
  const loader = ctx.get('loader')
  const row = loader === undefined ? undefined : [...loader.entries()].find(entry => entry.options?.id === 'session-persistence-jsonl')
  const root = row?.fiber?.config?.root
  return typeof root === 'string' ? root : undefined
}

/**
 * True when a log tail ends in a turn no process closed: the last turn edge is
 * an open `turn/start`, or the `interrupted` closer the harness writes when a
 * crashed session is next opened. A clean shutdown closes turns as
 * `aborted/disposed` instead; the live record covers those.
 */
export function endsCutOff(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const { type, data } = events[i]
    if (type === 'turn/start') return true
    if (type === 'turn/end') return data?.reason?.kind === 'interrupted'
  }
  return false
}

/** A directory name that is a session id verbatim (the store's path encoding leaves these characters alone). */
const PLAIN_ID = /^[A-Za-z0-9._-]+$/

/**
 * Ids of sessions whose stored files changed after `floor`, from file mtimes
 * under the JSONL store (`<root>/<project>/<session id>/…`). A stat walk costs
 * milliseconds; opening a log costs a full decode, and an old-format log is
 * migrated on open, so only these are opened. A missing root lists nothing.
 */
export function changedSessionIds(root, floor) {
  const ids = []
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return ids
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const session of readdirSync(join(root, project.name), { withFileTypes: true })) {
      if (!session.isDirectory() || !PLAIN_ID.test(session.name)) continue
      const dir = join(root, project.name, session.name)
      const newest = Math.max(0, ...readdirSync(dir).map((file) => statSync(join(dir, file)).mtimeMs))
      if (newest > floor) ids.push(session.name)
    }
  }
  return ids
}

/**
 * What the bar shows about a scanned session: its latest title, and whether
 * its latest goal is still `active` (a clear leaves no goal).
 */
export function logFacts(events) {
  let title
  let goal = false
  for (const { type, data } of events) {
    if (type === 'session/title' && typeof data?.title === 'string') title = data.title
    if (type === 'goal/change') goal = data?.operation !== 'clear' && data?.goal?.phase === 'active'
  }
  return { title, goal }
}

/** Oldest log time still worth offering: newer than both the last scan and `MAX_CRASH_AGE_MS`. */
export function crashFloor(after, now = Date.now()) {
  return Math.max(after, now - MAX_CRASH_AGE_MS)
}

/**
 * Pick the cut-off sessions worth offering: newer than what was already
 * offered (`after`) and than `MAX_CRASH_AGE_MS`. `found` is
 * `[{ id, cwd, time, title, goal }]` with `time` the log's last event.
 * @returns {{ entries: Record<string, Entry>, through: number }}
 */
export function crashedEntries(found, after, now = Date.now()) {
  const floor = crashFloor(after, now)
  const entries = {}
  let through = after
  for (const { id, cwd, time, title, goal } of found) {
    if (time <= floor) continue
    entries[id] = { cwd, since: time, turn: true, goal, ...(title === undefined ? {} : { title }) }
    through = Math.max(through, time)
  }
  return { entries, through }
}

/**
 * Resume one session. Returns the outcome for the bar and whether the entry is
 * settled (resumed, or gone for good) and can leave the pending set.
 */
async function resumeOne(ctx, id) {
  const resolved = await ctx.sessionController.resolveAgent(id)
  if ('error' in resolved) {
    const code = resolved.error?.code ?? 'unknown'
    // A deleted session or one owned by a subagent runtime never resumes here;
    // anything else (writer lock held elsewhere, gateway fault) can retry.
    const settled = code === 'session/not-found' || code === 'session/agent-busy'
    return { settled, outcome: `skipped: ${code}` }
  }
  const { agent } = resolved
  if (agent.status === 'running') return { settled: true, outcome: 'already running' }
  const goal = ctx.goals.get(agent)
  if (goal?.phase === 'active') {
    try {
      ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
      return { settled: true, outcome: 'goal resumed' }
    } catch (error) {
      // Round budget spent, or already armed: fall through to a plain continue.
      ctx.logger.warn(`dsh-restore: goal resume failed for ${id}: ${error.message}`)
    }
  }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: CONTINUE_MESSAGE }],
    source: { kind: 'restore', form: 'relay' },
  }))
  return { settled: true, outcome: 'continued' }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

/** Read a small JSON body; `undefined` for anything oversized or unparsable. */
async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > MAX_BODY_BYTES) return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const dir = stateDir()
  const warn = (text) => ctx.logger.warn(text)
  adoptDeadRecords(dir, warn)

  // This process's own record: only it writes the file, so another harness on
  // the same home cannot overwrite it.
  const livePath = join(dir, `live-${process.pid}.json`)
  const live = {}
  const bootId = currentBootId()
  const saveLive = () => {
    try {
      writeRecord(livePath, { pid: process.pid, ...(bootId === undefined ? {} : { bootId }), live })
    } catch (error) {
      warn(`dsh-restore: cannot write ${livePath}: ${error.message}`)
    }
  }
  saveLive()

  /** Read the shared pending set fresh, apply `change`, write it back. */
  const updatePending = (change) => {
    const state = readPending(dir, warn)
    change(state)
    try {
      writeRecord(join(dir, 'pending.json'), state)
    } catch (error) {
      warn(`dsh-restore: cannot write ${join(dir, 'pending.json')}: ${error.message}`)
    }
    return state
  }

  /**
   * Find sessions a hard crash cut off, including crashes from before this
   * plugin was loaded, by reading the tail of every stored log. Recorded
   * entries win over scanned ones: they know about goals.
   */
  const scanLogs = async () => {
    const found = []
    let unreadable = 0
    const root = jsonlRoot(ctx)
    if (root === undefined) {
      warn('dsh-restore: no session-persistence-jsonl row, so no boot scan; only the live record is offered')
      return
    }
    const { scannedThrough } = readPending(dir, warn)
    for (const id of changedSessionIds(root, crashFloor(scannedThrough))) {
      try {
        const handle = await ctx.sessionPersistence.open(id, 'read')
        try {
          if (handle.header.origin === 'subagent') continue
          const { events } = await handle.read()
          if (endsCutOff(events)) found.push({ id, cwd: handle.header.cwd, time: events.at(-1).time, ...logFacts(events) })
        } finally {
          await handle.close()
        }
      } catch {
        unreadable += 1
      }
    }
    if (unreadable > 0) warn(`dsh-restore: skipped ${unreadable} session log(s) that could not be read`)
    const { entries, through } = crashedEntries(found, scannedThrough)
    updatePending((state) => {
      state.pending = { ...entries, ...state.pending }
      state.scannedThrough = Math.max(state.scannedThrough, through)
    })
  }
  const scanned = scanLogs().catch((error) => warn(`dsh-restore: log scan failed: ${error.message}`))

  /** Set one flag on a session's live entry; drop the entry once nothing is in flight. */
  const mark = (session, flag, on) => {
    if (session.header?.origin === 'subagent') return // the parent resumes its children
    const entry = live[session.id]
    if (!on) {
      if (!entry?.[flag]) return
      entry[flag] = false
      if (!entry.turn && !entry.goal) delete live[session.id]
    } else {
      if (entry?.[flag]) return
      live[session.id] = { ...(entry ?? { cwd: session.header?.cwd, since: Date.now() }), [flag]: true }
    }
    saveLive()
  }

  const restore = async () => {
    const results = []
    const settled = []
    for (const id of Object.keys(readPending(dir, warn).pending)) {
      let result
      try {
        result = await resumeOne(ctx, id)
      } catch (error) {
        result = { settled: false, outcome: `failed: ${error.message}` }
      }
      if (result.settled) settled.push(id)
      results.push({ id, outcome: result.outcome })
    }
    updatePending((state) => { for (const id of settled) delete state.pending[id] })
    return results
  }

  let restoring
  const pendingList = () => Object.entries(readPending(dir, warn).pending).map(([id, entry]) => ({ id, ...entry }))

  const handler = async (req, res) => {
    const rejection = ctx.get('connection')?.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    // The bar asks once per page load, often before the boot scan finishes.
    await scanned
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET') {
      sendJson(res, 200, { pending: pendingList() })
      return
    }
    if (method !== 'POST') {
      res.setHeader('allow', 'GET, POST')
      sendJson(res, 405, { message: 'this route answers GET and POST only' })
      return
    }
    // A JSON content type forces a CORS preflight, so another origin cannot
    // fire a restore with a plain form post.
    if (!String(req.headers?.['content-type'] ?? '').startsWith('application/json')) {
      sendJson(res, 415, { message: 'POST a JSON body' })
      return
    }
    const body = await readJson(req)
    if (body?.action === 'dismiss') {
      updatePending((state) => { state.pending = {} })
      sendJson(res, 200, { results: [], pending: [] })
      return
    }
    if (body?.action === 'restore') {
      // One restore at a time: a second tab's click joins the running one
      // instead of sending every session a second `continue`.
      restoring ??= restore().finally(() => { restoring = undefined })
      const results = await restoring
      sendJson(res, 200, { results, pending: pendingList() })
      return
    }
    sendJson(res, 400, { message: 'action must be "restore" or "dismiss"' })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler }), `restore: ${ROUTE}`)

  ctx.effect(() => {
    const offEvent = ctx.on('session/event', (session, event) => {
      if (event?.type === 'turn/start') mark(session, 'turn', true)
      if (event?.type !== 'turn/end') return
      // A shutdown disposes running turns; that is exactly the state to keep.
      const reason = event.data?.reason
      if (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') return
      mark(session, 'turn', false)
    })
    const offGoal = ctx.on('goal/activation-changed', ({ sessionId, goal }) => {
      const session = ctx.sessions.get(sessionId) ?? { id: sessionId }
      mark(session, 'goal', goal?.activation === 'armed')
    })
    return () => {
      offEvent?.()
      offGoal?.()
    }
  })
}
