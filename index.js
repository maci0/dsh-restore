/**
 * dsh-resume-all: offer to resume every session that was mid-flight when the
 * harness last went down (reboot, crash, kill), the way a browser offers to
 * restore its tabs.
 *
 * While running, the host half keeps a state file listing each session with a
 * turn in progress or a goal armed. The file is rewritten on every change, so
 * whatever is on disk when the process dies is the in-flight set. At the next
 * start that set moves to `pending`, and the browser half shows a restore bar.
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
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

export const name = 'resume-all'
export const inject = ['webServer', 'sessionController', 'goals', 'sessions']

/** The route the browser half reads and posts to. */
export const ROUTE = '/resume-all'
const CONTINUE_MESSAGE = 'continue'
const STATE_VERSION = 1
/** Largest POST body accepted; the real ones are a few dozen bytes. */
const MAX_BODY_BYTES = 1024

/** `$DSH_HOME/storages/dsh-resume-all.json`, resolved like the harness resolves its home. */
export function statePath(env = process.env) {
  const home = env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(resolve(home), 'storages', 'dsh-resume-all.json')
}

/**
 * Read the state file. A missing file is an empty state; a malformed one is
 * reported and replaced, since it only ever holds this plugin's own record.
 * @returns {{ live: Record<string, Entry>, pending: Record<string, Entry> }}
 */
export function readState(path, warn = () => {}) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { live: {}, pending: {} }
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.version !== STATE_VERSION) throw new Error(`unsupported version ${parsed?.version}`)
    return { live: parsed.live ?? {}, pending: parsed.pending ?? {} }
  } catch (error) {
    warn(`dsh-resume-all: ignoring unreadable ${path}: ${error.message}`)
    return { live: {}, pending: {} }
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
  return { live: {}, pending: { ...state.pending, ...state.live } }
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

  const pendingList = () => Object.entries(state.pending).map(([id, entry]) => ({ id, ...entry }))

  const handler = async (req, res) => {
    const rejection = ctx.get('connection')?.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
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
      const results = await restore()
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
