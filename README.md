# dsh-resume-all

A browser-style restore bar for DeepSeek Harness: after a reboot or crash, one
click resumes the goals and continues every session that was mid-flight.

![restore bar](docs/restore-bar.png)

## Why

After a restart the harness closes each cut-off turn as `interrupted` and
disarms every goal, then waits. Nothing tells you which of dozens of sessions
were working, and the logs alone cannot: the `interrupted` closer is written
whenever a session is next opened, so last night's crash looks the same as a
session abandoned weeks ago.

## How it works

While dsh runs, the host half keeps `$DSH_HOME/storages/dsh-resume-all.json`
(default `~/.dsh/storages/`) listing every session with a turn in progress or
a goal armed, rewritten atomically on each `turn/start`, `turn/end`, and goal
activation change. A turn aborted as `disposed` (a shutdown) stays listed, so a
clean reboot counts the same as a crash; a turn you stopped yourself does not.

At the next start the listed sessions become pending. A boot scan adds every
session a hard crash cut off, including crashes from before the plugin was
installed: a log whose last turn no process closed (an open `turn/start`, or the
`interrupted` closer the harness writes when such a session is reopened). It
stats `$DSH_HOME/sessions` and opens only logs changed in the last 3 days, and
remembers how far it has offered, so a dismissed crash stays dismissed.

The bar then appears at the top of the app. **Show** lists the sessions by
title, marked goal or turn (click one to open it). **Restore** opens each
through the session controller and:

- resumes its goal when the goal is still `active` (the goal round driver then
  queues the round, exactly like `/goal resume`);
- otherwise sends `continue` as a user message;
- skips a session that is already running.

A session whose writer lock is held by another process, or that hit a gateway
error, stays in the bar for another Restore. Deleted sessions and subagent
children drop out; a parent's resume reaches its children. Paused, blocked, and
completed goals are never touched. **Dismiss** forgets the whole set.

The browser half talks to the host over `GET`/`POST /resume-all`, behind the
web server's connection fence; a POST must carry a JSON body.

## Install

`dsh plugin add dsh-resume-all` (bundle install, like the other dsh plugins).
Needs the Web/desktop bundle (`webServer`, `sessionController`); headless
profiles do not mount them.

## Limits

- The boot scan reads only the default store root, `$DSH_HOME/sessions`. A
  profile that moves `session-persistence-jsonl.root` gets the live record only.
- Crashes older than 3 days are treated as history and not offered.
- One state file per `$DSH_HOME`: two harness processes on the same home
  overwrite each other's record.
- The bar reads the pending set once per page load; a second open tab does not
  see the other tab's Restore until reloaded.
