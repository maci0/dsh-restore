# dsh-restore

A browser-style restore bar for DeepSeek Harness: after a reboot or crash, one
click resumes the goals and continues every session that was mid-flight. After
a restart the harness closes each cut-off turn and disarms every goal, then
waits; nothing tells you which of dozens of sessions were working.

![restore bar](docs/restore-bar.png)

## What you get

- A bar at the top of the app, shown once after a restart that cut sessions
  off: "DeepSeek Harness stopped while N sessions were still working."
- **Show** lists them by title, marked goal or turn; click one to open it.
- **Restore** resumes every goal that is still `active` and sends `continue`
  to every other session. **Dismiss** forgets the set.

## Install

> **Install it as a bundle.** `dsh plugin add …` mounts the row from the
> package's own patch layer, which is what the settings editor can write to. A
> row added with `--patch` is an overlay: it disappears at the next start.

```sh
dsh plugin --profile web add github:maci0/dsh-restore#v0.8.2
```

Pin a release tag: a bare `github:` spec floats on `main`. To upgrade, run the same command with the newer tag, then restart `dsh web` (bundle layers compose at boot).

Needs the Web/desktop bundle (`webServer`, `sessionController`); headless
profiles do not mount them.

## How it works

Two sources feed the pending set. State lives in
`$DSH_HOME/storages/dsh-restore/` (default `~/.dsh/storages/`): a shared
`pending.json`, and one `live-<pid>.json` per running harness process. Shared
edits hold the native SQLite writer lock in `pending.lock.sqlite`, which is
released automatically if a process dies. A dead live record is retired only
after its recovery entries have been saved; failed saves leave the bar intact.

- **The live record.** While dsh runs, the plugin lists every session with a
  turn in progress or a goal armed, rewritten atomically on each `turn/start`,
  `turn/end`, and goal activation change. A turn aborted as `disposed` (a
  shutdown) stays listed, so a clean reboot counts the same as a crash; a turn
  you stopped yourself does not. Each process writes only its own record, so
  two harness processes on one home never overwrite each other. At the next
  start, records whose process is gone (another boot id, a pid no longer
  running, or a pid whose process started at another time) move to pending; a
  running process keeps its own.
- **The boot scan.** For hard crashes, including ones from before the plugin
  was installed, it finds logs whose last turn no process closed: an open
  `turn/start`, or the `interrupted` closer the harness writes when such a
  session is reopened. It stats the JSONL store (the `root` of the
  `session-persistence-jsonl` row, so a moved store is found) and opens only logs
  changed in the last 3 days, and remembers how far it has offered, so a
  dismissed crash stays dismissed. Titles and goal state come from the same
  read.

**Restore** opens each pending session through the session controller and:

- resumes its goal when the goal is still `active` (the goal round driver then
  queues the round, exactly like `/goal resume`);
- otherwise sends `continue` as a user message;
- skips a session that is already running.

A session whose writer lock is held by another process, or that hit a gateway
error, stays in the bar for another Restore. Deleted sessions and subagent
children drop out; a parent's resume reaches its children. Paused, blocked, and
completed goals are never touched. Two Restore clicks at once (two tabs) run
one restore.

The browser half talks to the host over `GET`/`POST /restore`, behind the
web server's connection fence; a POST must carry a JSON body. The bar
re-reads the set when its tab comes back into view, so a Restore or Dismiss
in another tab is reflected.

## Limits

- A profile that persists sessions without the JSONL store gets no boot scan,
  only the live record, and the plugin logs that.
- Crashes older than 3 days are treated as history and not offered.
- Off Linux (no procfs start times or boot id), a pid reused by another
  process reads as a running owner, so that record is offered once the pid's
  new holder exits.

## Development

```sh
bun test   # unit suite, the restore bar, and a real Cordis composition mount
```

For local development, install the checkout into a profile with
`dsh plugin --profile <name> add <path-to-checkout>`.

dsh loads plugins on Node `^22.19.0 || >=24.0.0`; development and tests run on bun.

## Licence

MIT. See [LICENSE](LICENSE).
