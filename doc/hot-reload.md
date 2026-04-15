# Hot-reload (dev mode)

Iterating on sparkflow normally means killing the tmux session, losing every in-flight job, and reattaching Claude to a new MCP socket. Dev mode replaces that cycle with an automatic one-second reload that leaves jobs running.

## Running

```
sparkflow --dev --cwd <project>
```

That's it — one command. The **supervisor** in the bottom tmux pane does two things:

1. Starts `tsc --watch` in a dedicated tmux window named `tsc` (`Ctrl-b w` to switch to it if you need to see type errors).
2. Watches `dist/` itself; when `tsc` writes a new `.js`, it SIGTERMs the status daemon, waits for it to flush state, and respawns it. The new daemon rehydrates persisted jobs from disk and re-tails their log files.

If tmux or tsc aren't available (e.g. sparkflow installed from a published tarball, not from source), the supervisor logs that and skips the tsc step — run `tsc --watch` manually in that case.

## How it works

Three pieces make reloads transparent:

1. **Detached jobs.** `JobManager` spawns `sparkflow-run` children with `detached: true` and their stdout/stderr routed directly to a log file fd. The daemon dying doesn't kill the child or break its output.

2. **Persisted state.** Every job is written to `<cwd>/.sparkflow/state/jobs/<id>.json` (atomic write) on each update — pid, log path, byte offset into the log, and the current `JobInfo`. On startup, `JobManager.rehydrate()` reloads these, pings each pid with `kill -0`, and starts tailing the log from the saved offset (no replay of old output).

3. **Reconnecting IPC clients.** `IpcClient` in `src/mcp/ipc.ts` retries on close/error with exponential backoff (100ms → 2s) and re-sends any in-flight requests on reconnect. The MCP server Claude spawned stays connected across reloads without the caller noticing.

The supervisor distinguishes SIGTERM (reload → `JobManager.release()`, children survive) from SIGINT (user quit → `JobManager.killAll()`, state files removed).

## Limitations

- **`ask_user` across reload.** If a job is blocked on a question when the daemon reloads, the `stdin` pipe is gone. The job keeps waiting but `answer_question` will fail; the UI shows `orphaned question (reload)`. You'll have to kill that job. (Fix would require routing answers through IPC instead of stdin.)

- **`tsc --watch` runs separately.** The supervisor only watches `dist/`; source changes don't reload until TypeScript rebuilds.

- **Socket reconnect, not socket hand-off.** The Unix socket is unlinked and rebound on each reload. Clients get a brief ECONNRESET and reconnect — cheap, but not zero.

- **Production unchanged.** Without `--dev`, `sparkflow` spawns `status-display` directly, no supervisor, no file watcher. State files are still written (harmless) but `killAll` clears them on normal exit.
