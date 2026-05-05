import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { PersistedJob } from "../tui/state-store.js";
import { readDashboardInfo, releaseFrontendLock } from "../dashboard/discovery.js";

export interface KillAllOptions {
  cwd: string;
  force: boolean;
  /** Also kill the user-global frontend daemon (~/.sparkflow/dashboard.json). */
  all?: boolean;
  /** Grace period between initial SIGTERM and SIGKILL escalation. Default 5000 ms. */
  timeoutMs?: number;
}

export interface KillAllSummary {
  total: number;
  signalled: number;
  terminated: number;
  forceKilled: number;
  stillAlive: number;
  errors: Array<{ jobId: string; pid: number; error: string }>;

  /** Counts broken out by kind for the summary string. */
  jobsKilled: number;
  /** true if a repo engine daemon was SIGTERM'd (found alive and signalled). */
  engineDaemonKilled: boolean;
  /** true only if --all and one was found+killed. */
  frontendDaemonKilled: boolean;
}

function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface RunningJob {
  id: string;
  pid: number;
}

function loadRunningJobs(cwd: string): RunningJob[] {
  const dir = join(cwd, ".sparkflow", "state", "jobs");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const running: RunningJob[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(dir, name), "utf-8");
      const job = JSON.parse(raw) as PersistedJob;
      if (job.info.state === "succeeded" || job.info.state === "failed") continue;
      if (job.pid > 0 && isAlive(job.pid)) {
        running.push({ id: job.info.id, pid: job.pid });
      }
    } catch {
      // skip unparseable/corrupt entries
    }
  }
  return running;
}

type TargetKind = "job" | "engine" | "frontend";

interface Target {
  kind: TargetKind;
  id: string;
  pid: number;
}

function readEngineDaemonTarget(cwd: string): Target | null {
  const pidFile = join(cwd, ".sparkflow", "state", "engine-daemon.pid");
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (pid > 0 && isAlive(pid)) {
      return { kind: "engine", id: "engine-daemon", pid };
    }
  } catch {
    /* not present or unreadable */
  }
  return null;
}

function readFrontendTarget(): Target | null {
  const info = readDashboardInfo();
  if (!info) return null;
  if (info.pid > 0 && isAlive(info.pid)) {
    return { kind: "frontend", id: "frontend-daemon", pid: info.pid };
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kill all non-terminal Sparkflow jobs, the per-repo engine daemon, and
 * optionally the user-global frontend daemon.
 *
 * Always sends SIGTERM to every target, then polls isAlive up to `timeoutMs`
 * so the returned summary reflects what exited gracefully. With `force: true`,
 * any targets still alive after the grace period are SIGKILLed.
 */
export async function runKillAll(opts: KillAllOptions): Promise<KillAllSummary> {
  const timeoutMs = opts.timeoutMs ?? 5000;

  const jobs = loadRunningJobs(opts.cwd);
  const engineTarget = readEngineDaemonTarget(opts.cwd);
  const frontendTarget = opts.all ? readFrontendTarget() : null;

  const targets: Target[] = [
    ...jobs.map((j) => ({ kind: "job" as const, id: j.id, pid: j.pid })),
    ...(engineTarget ? [engineTarget] : []),
    ...(frontendTarget ? [frontendTarget] : []),
  ];

  const summary: KillAllSummary = {
    total: targets.length,
    signalled: 0,
    terminated: 0,
    forceKilled: 0,
    stillAlive: 0,
    errors: [],
    jobsKilled: 0,
    engineDaemonKilled: false,
    frontendDaemonKilled: false,
  };

  if (targets.length === 0) return summary;

  for (const target of targets) {
    try {
      process.kill(target.pid, "SIGTERM");
      summary.signalled++;
      if (target.kind === "engine") summary.engineDaemonKilled = true;
      if (target.kind === "frontend") summary.frontendDaemonKilled = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // process already exited between isAlive check and signal — count as terminated.
        continue;
      }
      summary.errors.push({
        jobId: target.id,
        pid: target.pid,
        error: (err as Error).message,
      });
    }
  }

  const deadline = Date.now() + timeoutMs;
  const pollMs = 100;
  let remaining = targets.slice();
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(pollMs);
    remaining = remaining.filter((t) => isAlive(t.pid));
  }

  summary.terminated = targets.length - remaining.length;

  if (opts.force && remaining.length > 0) {
    for (const target of remaining) {
      try {
        process.kill(target.pid, "SIGKILL");
        summary.forceKilled++;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          summary.forceKilled++;
          continue;
        }
        summary.errors.push({
          jobId: target.id,
          pid: target.pid,
          error: (err as Error).message,
        });
      }
    }
    await sleep(200);
    remaining = remaining.filter((t) => isAlive(t.pid));
  }

  summary.stillAlive = remaining.length;

  const alivePids = new Set(remaining.map((t) => t.pid));
  summary.jobsKilled = jobs.filter((j) => !alivePids.has(j.pid)).length;

  // Clean up per-repo engine daemon PID file after it exits.
  // Only remove if we targeted it (it was alive when we started), not if it was already dead.
  if (summary.engineDaemonKilled && engineTarget && !alivePids.has(engineTarget.pid)) {
    try {
      unlinkSync(join(opts.cwd, ".sparkflow", "state", "engine-daemon.pid"));
    } catch { /* ignore */ }
  }

  // Release the frontend lock only if we successfully killed the frontend daemon.
  if (summary.frontendDaemonKilled && frontendTarget && !alivePids.has(frontendTarget.pid)) {
    releaseFrontendLock();
  }

  return summary;
}

export function formatSummary(s: KillAllSummary, force: boolean): string {
  if (s.total === 0) return "No running Sparkflow jobs or daemons found.";

  const jobCount = s.total - (s.engineDaemonKilled ? 1 : 0) - (s.frontendDaemonKilled ? 1 : 0);

  const found: string[] = [];
  if (jobCount > 0) found.push(`${jobCount} running job${jobCount === 1 ? "" : "s"}`);
  if (s.engineDaemonKilled) found.push("engine daemon");
  if (s.frontendDaemonKilled) found.push("frontend daemon");

  const foundDesc = found.length === 1
    ? found[0]
    : found.slice(0, -1).join(", ") + " and " + found[found.length - 1];

  const parts: string[] = [`Found ${foundDesc}.`];

  if (force) {
    parts.push(
      `Terminated gracefully: ${s.terminated - s.forceKilled}. Force-killed: ${s.forceKilled}.`,
    );
  } else {
    parts.push(`Terminated gracefully: ${s.terminated}.`);
    if (s.stillAlive > 0) {
      parts.push(`Still alive: ${s.stillAlive}. Rerun with --force to SIGKILL.`);
    }
  }
  if (s.errors.length > 0) {
    parts.push(`Errors: ${s.errors.length} (see stderr).`);
  }
  return parts.join(" ");
}
