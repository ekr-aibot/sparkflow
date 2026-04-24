import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedJob } from "../tui/state-store.js";

export interface KillAllOptions {
  cwd: string;
  force: boolean;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kill all non-terminal Sparkflow jobs recorded in `<cwd>/.sparkflow/state/jobs/`.
 *
 * Always sends SIGTERM to every running job, then polls isAlive up to
 * `timeoutMs` so the returned summary reflects what exited gracefully. With
 * `force: true`, any jobs still alive after the grace period are SIGKILLed.
 *
 * The daemon's own child-close listeners (for live children) and rehydrated
 * liveness ping (for detached children) will reconcile in-memory state to
 * "failed" when the pids die, so the TUI reflects the termination without
 * any IPC round-trip from this command.
 */
export async function runKillAll(opts: KillAllOptions): Promise<KillAllSummary> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const jobs = loadRunningJobs(opts.cwd);

  const summary: KillAllSummary = {
    total: jobs.length,
    signalled: 0,
    terminated: 0,
    forceKilled: 0,
    stillAlive: 0,
    errors: [],
  };

  if (jobs.length === 0) return summary;

  for (const job of jobs) {
    try {
      process.kill(job.pid, "SIGTERM");
      summary.signalled++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // process already exited between our isAlive check and signal — count as terminated.
        continue;
      }
      summary.errors.push({
        jobId: job.id,
        pid: job.pid,
        error: (err as Error).message,
      });
    }
  }

  const deadline = Date.now() + timeoutMs;
  const pollMs = 100;
  let remaining = jobs.slice();
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(pollMs);
    remaining = remaining.filter((j) => isAlive(j.pid));
  }

  summary.terminated = jobs.length - remaining.length;

  if (opts.force && remaining.length > 0) {
    for (const job of remaining) {
      try {
        process.kill(job.pid, "SIGKILL");
        summary.forceKilled++;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          summary.forceKilled++;
          continue;
        }
        summary.errors.push({
          jobId: job.id,
          pid: job.pid,
          error: (err as Error).message,
        });
      }
    }
    await sleep(200);
    remaining = remaining.filter((j) => isAlive(j.pid));
  }

  summary.stillAlive = remaining.length;
  return summary;
}

export function formatSummary(s: KillAllSummary, force: boolean): string {
  if (s.total === 0) return "No running Sparkflow jobs found.";
  const parts: string[] = [];
  parts.push(`Found ${s.total} running job${s.total === 1 ? "" : "s"}.`);
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
