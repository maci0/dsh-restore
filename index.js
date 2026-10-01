/**
 * dsh-resume-all: offer to resume every session that was mid-flight when the
 * harness last went down (reboot, crash, kill), the way a browser offers to
 * restore its tabs.
 *
 * While running, the host half keeps a state file listing each session with a
 * turn in progress or a goal armed. The file is rewritten on every change, so
 * whatever is on disk when the process dies is the in-flight set. At the next
 * start that set moves to `pending`. A boot scan of the stored logs adds every
 * session whose last turn no process closed (a hard crash, including one from
 * before this plugin was installed), and the browser half shows a restore bar.
 * Restore resumes a session's goal when it is still `active` (the harness
 * disarms every goal on restart) and sends `continue` to any other session.
 *
 * Route `/resume-all`:
 *   GET                             → { pending: [{ id, cwd, since, turn, goal }] }
 *   POST { "action": "restore" }    → { results: [{ id, outcome }], pending }
 *   POST { "action": "dismiss" }    → { results: [], pending: [] }
 * `pending` after a POST is what the host could not settle (a writer lock
 * held by another process, a gateway fault), kept for the next restore.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

export const name = 'resume-all'
export const inject = ['webServer', 'sessionController', 'goals', 'sessions', 'sessionPersistence']

/** The route the browser half reads and posts to. */
export const ROUTE = '/resume-all'
const CONTINUE_MESSAGE = 'continue'
const STATE_VERSION = 1
/** Cut-off turns older than this are history, not a crash to recover from. */
const MAX_CRASH_AGE_MS = 3 * 24 * 60 * 60 * 1000
/** Largest POST body accepted; the real ones are a few dozen bytes. */
const MAX_BODY_BYTES = 1024

/** The harness home: `$DSH_HOME`, else `~/.dsh`, resolved like the harness resolves it. */
function dshHome(env = process.env) {
  return resolve(env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh'))
}

/** `$DSH_HOME/storages/dsh-resume-all.json`. */
export function statePath(env = process.env) {
  return join(dshHome(env), 'storages', 'dsh-resume-all.json')
}

/** The JSONL session store's default root, `$DSH_HOME/sessions`. */
export function sessionsRoot(env = process.env) {
  return join(dshHome(env), 'sessions')
}

/**
 * Read the state file. A missing file is an empty state; a malformed one is
 * reported and replaced, since it only ever holds this plugin's own record.
 * @returns {{ live: Record<string, Entry>, pending: Record<string, Entry>, scannedThrough: number }}
 *   `scannedThrough` is the newest log time already offered, so a dismissed
 *   crash is not offered again.
 */
export function readState(path, warn = () => {}) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { live: {}, pending: {}, scannedThrough: 0 }
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.version !== STATE_VERSION) throw new Error(`unsupported version ${parsed?.version}`)
    return { live: parsed.live ?? {}, pending: parsed.pending ?? {}, scannedThrough: parsed.scannedThrough ?? 0 }
  } catch (error) {
    warn(`dsh-resume-all: ignoring unreadable ${path}: ${error.message}`)
    return { live: {}, pending: {}, scannedThrough: 0 }
  }
}

/** Atomic write: a crash mid-write leaves the previous file, never a torn one. */
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, ...state }, null, 2))
  renameSync(tmp, path)
}

/**
 * Boot step: everything live in the previous process becomes pending. Earlier
 * pending entries the user never acted on stay; a newer live entry wins.
 */
export function promoteLive(state) {
  return { ...state, live: {}, pending: { ...state.pending, ...state.live } }
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
      ctx.logger.warn(`dsh-resume-all: goal resume failed for ${id}: ${error.message}`)
    }
  }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: CONTINUE_MESSAGE }],
    source: { kind: 'resume-all', form: 'relay' },
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
  const path = statePath()
  const warn = (text) => ctx.logger.warn(text)
  // ponytail: one file per DSH_HOME, last writer wins. Two harness processes on
  // the same home overwrite each other's live set; key the file by profile if
  // that ever matters.
  const state = promoteLive(readState(path, warn))
  writeState(path, state)

  const save = () => {
    try {
      writeState(path, state)
    } catch (error) {
      warn(`dsh-resume-all: cannot write ${path}: ${error.message}`)
    }
  }

  /**
   * Find sessions a hard crash cut off, including crashes from before this
   * plugin was loaded, by reading the tail of every stored log. Recorded
   * entries win over scanned ones: they know about goals.
   */
  const scanLogs = async () => {
    const found = []
    let unreadable = 0
    // ponytail: the stat walk assumes the default JSONL root (`$DSH_HOME/sessions`).
    // A profile that moves `session-persistence-jsonl.root` gets no scan, only
    // the live record; read the root from the row if that ever matters.
    for (const id of changedSessionIds(sessionsRoot(), crashFloor(state.scannedThrough))) {
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
    if (unreadable > 0) warn(`dsh-resume-all: skipped ${unreadable} session log(s) that could not be read`)
    const { entries, through } = crashedEntries(found, state.scannedThrough)
    state.pending = { ...entries, ...state.pending }
    state.scannedThrough = through
    save()
  }
  const scanned = scanLogs().catch((error) => warn(`dsh-resume-all: log scan failed: ${error.message}`))

  /** Set one flag on a session's live entry; drop the entry once nothing is in flight. */
  const mark = (session, flag, on) => {
    if (session.header?.origin === 'subagent') return // the parent resumes its children
    const entry = state.live[session.id]
    if (!on) {
      if (!entry?.[flag]) return
      entry[flag] = false
      if (!entry.turn && !entry.goal) delete state.live[session.id]
    } else {
      if (entry?.[flag]) return
      state.live[session.id] = { ...(entry ?? { cwd: session.header?.cwd, since: Date.now() }), [flag]: true }
    }
    save()
  }

  const restore = async () => {
    const results = []
    for (const id of Object.keys(state.pending)) {
      let result
      try {
        result = await resumeOne(ctx, id)
      } catch (error) {
        result = { settled: false, outcome: `failed: ${error.message}` }
      }
      if (result.settled) delete state.pending[id]
      results.push({ id, outcome: result.outcome })
    }
    save()
    return results
  }

  let restoring
  const pendingList = () => Object.entries(state.pending).map(([id, entry]) => ({ id, ...entry }))

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
      state.pending = {}
      save()
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

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler }), `resume-all: ${ROUTE}`)

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
