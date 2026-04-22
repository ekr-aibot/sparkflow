import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, basename, isAbsolute } from "node:path";
import type { JobInfo } from "./types.js";
import { LogTailer } from "./log-tailer.js";
import { StateStore, type PersistedJob } from "./state-store.js";
import { loadProjectConfig, resolveWorkflowPath } from "../config/project-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve sparkflow-run CLI entry point relative to this file
const SPARKFLOW_RUN_PATH = resolve(__dirname, "../cli/index.js");

interface ManagedJob {
  info: JobInfo;
  pid: number;
  // child is null for rehydrated jobs — we only have the pid, no pipes.
  child: ChildProcess | null;
  logPath: string;
  tailer: LogTailer;
  outputBuffer: string[];
  pendingRequestId?: string;
  originalPlan?: string;
  originalPlanText?: string;
  originalCwd?: string;
  killedByUser?: boolean;
  /** Tracks per-step running state for the nudge dropdown. */
  stepStates: Map<string, string>;
}

const OUTPUT_BUFFER_MAX = 2000;
const REHYDRATE_PING_MS = 2000;

function logDirFor(cwd: string): string {
  const dir = join(cwd, ".sparkflow", "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class JobManager {
  private jobs = new Map<string, ManagedJob>();
  private updateCallbacks: Array<() => void> = [];
  private tmuxSession: string | null = null;
  private store: StateStore;
  private cwd: string;
  private persistTimers = new Map<string, NodeJS.Timeout>();
  private rehydratedPingTimer: NodeJS.Timeout | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.store = new StateStore(cwd);
  }

  setTmuxSession(session: string): void {
    this.tmuxSession = session;
  }

  /**
   * Load persisted jobs from disk and reattach log tailers.
   * Dead pids are marked terminal; live pids continue streaming from their log offset.
   */
  rehydrate(): void {
    const persisted = this.store.loadJobs();
    for (const p of persisted) {
      const alive = isAlive(p.pid);
      // Monitor jobs are ephemeral to a daemon lifetime: if the process is gone
      // or already terminal, drop the persisted state entirely rather than
      // leaving a ghost in the dashboard. autoStartMonitors() runs right after
      // and will spin up a fresh replacement from config. A pid can look alive
      // after recycling, so state check matters independently of the pid probe.
      if (p.info.kind === "monitor") {
        const terminal = p.info.state === "failed" || p.info.state === "succeeded";
        if (!alive || terminal) {
          this.store.removeJob(p.info.id);
          continue;
        }
      }
      const info: JobInfo = { ...p.info };
      if (!alive && (info.state === "running" || info.state === "blocked")) {
        info.state = "failed";
        info.summary = info.summary || "process ended during reload";
        info.endTime = info.endTime ?? Date.now();
      }

      const tailer = new LogTailer(p.logPath, p.logOffset, (line) => {
        this.handleStatusLine(p.info.id, line);
        this.handleVerboseLine(p.info.id, line);
        this.appendOutput(p.info.id, line);
      });

      const managed: ManagedJob = {
        info,
        pid: p.pid,
        child: null,
        logPath: p.logPath,
        tailer,
        outputBuffer: [],
        pendingRequestId: p.pendingRequestId,
        originalPlan: p.originalPlan,
        originalPlanText: p.originalPlanText,
        originalCwd: p.originalCwd,
        stepStates: new Map(),
      };
      this.jobs.set(info.id, managed);
      tailer.start();
      this.openTmuxWindow(info.id, info.workflowPath, p.logPath, info.slug);
      this.schedulePersist(info.id);
    }

    if (this.jobs.size > 0 && !this.rehydratedPingTimer) {
      this.rehydratedPingTimer = setInterval(() => this.pingRehydrated(), REHYDRATE_PING_MS);
    }

    this.fireUpdate();
  }

  private pingRehydrated(): void {
    for (const [id, job] of this.jobs) {
      if (job.child) continue; // we get close events for owned children
      if (job.info.state === "succeeded" || job.info.state === "failed") continue;
      if (!isAlive(job.pid)) {
        job.info.state = "failed";
        job.info.summary = job.info.summary || "process exited";
        job.info.endTime = Date.now();
        this.schedulePersist(id);
        this.fireUpdate();
      }
    }
  }

  startJob(workflowPath: string, opts?: { cwd?: string; plan?: string; planText?: string; slug?: string; description?: string; kind?: "monitor" }): string {
    const id = randomBytes(6).toString("hex");
    const jobCwd = opts?.cwd ?? this.cwd;

    if (!isAbsolute(workflowPath)) {
      const projectConfig = loadProjectConfig(jobCwd);
      workflowPath = resolveWorkflowPath(workflowPath, jobCwd, projectConfig);
    }

    const args = ["run", workflowPath, "--verbose", "--status-json"];
    if (opts?.cwd) args.push("--cwd", opts.cwd);

    let planPath = opts?.plan;
    if (!planPath && opts?.planText) {
      const workflowName = basename(workflowPath, ".json");
      const logDir = join(jobCwd, ".sparkflow", "logs", workflowName);
      mkdirSync(logDir, { recursive: true });
      planPath = join(logDir, `plan-${id}.md`);
      writeFileSync(planPath, opts.planText);
    }
    if (planPath) args.push("--plan", planPath);

    // Log file lives under the job cwd so it's project-local and survives daemon restart.
    const logPath = join(logDirFor(jobCwd), `job-${id}.log`);
    // Open append fd; the child inherits it as stdout+stderr and writes directly
    // so the child survives the daemon process dying.
    const logFd = openSync(logPath, "a");

    const child = spawn(process.execPath, [SPARKFLOW_RUN_PATH, ...args], {
      cwd: jobCwd,
      stdio: ["pipe", logFd, logFd],
      env: process.env as Record<string, string>,
      detached: true,
    });

    // We no longer need the parent's copy of the log fd.
    try { closeSync(logFd); } catch { /* ignore */ }

    const info: JobInfo = {
      id,
      workflowPath,
      workflowName: workflowPath,
      slug: opts?.slug,
      description: opts?.description,
      kind: opts?.kind,
      state: "running",
      summary: "starting…",
      startTime: Date.now(),
    };

    const tailer = new LogTailer(logPath, 0, (line) => {
      this.handleStatusLine(id, line);
      this.handleVerboseLine(id, line);
      this.appendOutput(id, line);
    });

    const managed: ManagedJob = {
      info,
      pid: child.pid ?? -1,
      child,
      logPath,
      tailer,
      outputBuffer: [],
      originalPlan: opts?.plan,
      originalPlanText: opts?.planText,
      originalCwd: opts?.cwd,
      stepStates: new Map(),
    };

    this.jobs.set(id, managed);
    tailer.start();
    this.openTmuxWindow(id, workflowPath, logPath, opts?.slug);

    child.on("close", (code) => {
      const job = this.jobs.get(id);
      if (!job) return;
      job.info.endTime = Date.now();
      if (job.info.state === "running" || job.info.state === "blocked") {
        job.info.state = code === 0 ? "succeeded" : "failed";
        job.info.summary = job.killedByUser
          ? "killed by user"
          : code === 0 ? "completed" : `exit code ${code}`;
      }
      this.schedulePersist(id);
      this.fireUpdate();
    });

    child.on("error", (err) => {
      const job = this.jobs.get(id);
      if (!job) return;
      job.info.state = "failed";
      job.info.summary = err.message;
      job.info.endTime = Date.now();
      this.schedulePersist(id);
      this.fireUpdate();
    });

    this.schedulePersist(id);
    this.fireUpdate();
    return id;
  }

  private appendOutput(jobId: string, line: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.outputBuffer.push(line);
    if (job.outputBuffer.length > OUTPUT_BUFFER_MAX) {
      job.outputBuffer.splice(0, job.outputBuffer.length - OUTPUT_BUFFER_MAX);
    }
  }

  private handleStatusLine(jobId: string, line: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    const type = event.type as string;
    let changed = false;

    if (type === "step_status") {
      job.info.currentStep = event.step as string;
      job.info.stepState = event.state as string;
      job.info.summary = `${event.step}: ${event.state}`;
      if (event.state === "running") {
        job.stepStates.set(event.step as string, "running");
      } else {
        job.stepStates.delete(event.step as string);
      }
      job.info.activeSteps = Array.from(job.stepStates.keys());
      changed = true;
    } else if (type === "workflow_steps") {
      const steps = (event.steps as Array<{ id: string; runtime: string }>) ?? [];
      job.info.claudeCodeSteps = steps
        .filter((s) => s.runtime === "claude-code")
        .map((s) => s.id);
      changed = true;
    } else if (type === "ask_user") {
      job.info.state = "blocked";
      job.info.pendingQuestion = event.question as string;
      job.info.summary = `waiting for answer: ${event.question}`;
      job.pendingRequestId = event.request_id as string;
      if (!job.child) {
        job.info.summary = `orphaned question (reload): ${event.question}`;
      }
      changed = true;
    } else if (type === "workflow_start") {
      job.info.workflowName = event.name as string;
      job.info.summary = "running";
      job.stepStates.clear();
      job.info.activeSteps = [];
      changed = true;
    } else if (type === "workflow_complete") {
      // A workflow_complete with success:false can arrive either because the
      // workflow really aborted, or because the process is wrapping up after a
      // recovery. Don't overwrite a failed_waiting state — we're intentionally
      // pausing to collect user input.
      if (job.info.state === "failed_waiting") return;
      job.info.state = event.success ? "succeeded" : "failed";
      job.info.summary = event.success ? "completed" : "failed";
      job.info.endTime = Date.now();
      changed = true;
    }

    if (changed) {
      this.schedulePersist(jobId);
      this.fireUpdate();
    } else if (type === "job_failed") {
      const step = event.step as string;
      const error = (event.error as string) ?? "step failed";
      job.info.state = "failed_waiting";
      job.info.failedStep = step;
      job.info.failedError = error;
      job.info.currentStep = step;
      job.info.stepState = "failed";
      job.info.summary = `${step} failed — awaiting recovery: ${error.slice(0, 80)}`;
      job.info.pendingQuestion = `recover: ${step}`;
      job.pendingRequestId = event.request_id as string;
      this.fireUpdate();
    }
  }

  private handleVerboseLine(jobId: string, line: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    let changed = false;

    const stepMatch = line.match(/^\[(\S+)\] (running|succeeded|failed)/);
    if (stepMatch) {
      const [, step, state] = stepMatch;
      job.info.currentStep = step;
      job.info.stepState = state;
      if (job.info.state !== "blocked") {
        job.info.summary = `${step}: ${state}`;
      }
      changed = true;
    }

    const startMatch = line.match(/^\[sparkflow\] Starting workflow "(.+)"/);
    if (startMatch) {
      job.info.workflowName = startMatch[1];
      changed = true;
    }

    if (line.match(/^\[sparkflow\] Workflow .+ completed successfully/)) {
      job.info.state = "succeeded";
      job.info.summary = "completed";
      job.info.endTime = Date.now();
      changed = true;
    }
    if (line.match(/^\[sparkflow\] Workflow .+ (failed|aborted)/)) {
      job.info.state = "failed";
      job.info.summary = "failed";
      job.info.endTime = Date.now();
      changed = true;
    }

    if (changed) {
      this.schedulePersist(jobId);
      this.fireUpdate();
    }
  }

  answerQuestion(jobId: string, answer: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !job.info.pendingQuestion) return false;
    if (!job.child || !job.child.stdin) {
      // Rehydrated job — we lost the stdin pipe across reload.
      return false;
    }

    if (job.pendingRequestId) {
      job.child.stdin.write(
        JSON.stringify({ type: "answer", request_id: job.pendingRequestId, response: answer }) + "\n",
      );
    }

    job.info.state = "running";
    job.info.pendingQuestion = undefined;
    job.pendingRequestId = undefined;
    job.info.summary = job.info.currentStep ? `${job.info.currentStep}: running` : "running";
    this.schedulePersist(jobId);
    this.fireUpdate();
    return true;
  }

  answerRecovery(jobId: string, action: "retry" | "skip" | "abort", message?: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.info.state !== "failed_waiting" || !job.pendingRequestId) return false;

    if (!job.child || !job.child.stdin) {
      // Rehydrated job — stdin pipe was lost across reload.
      return false;
    }
    const payload = JSON.stringify({ action, message });
    job.child.stdin.write(
      JSON.stringify({ type: "answer", request_id: job.pendingRequestId, response: payload }) + "\n",
    );

    if (action === "abort") {
      job.info.state = "failed";
      job.info.summary = `aborted by user after ${job.info.failedStep ?? "failure"}`;
    } else {
      job.info.state = "running";
      job.info.summary = action === "retry"
        ? `retrying ${job.info.failedStep ?? "step"}…`
        : `skipped ${job.info.failedStep ?? "step"}`;
    }
    job.info.pendingQuestion = undefined;
    job.pendingRequestId = undefined;
    job.info.failedStep = undefined;
    job.info.failedError = undefined;
    this.fireUpdate();
    return true;
  }

  nudgeJob(jobId: string, stepId: string, message: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: `Job not found: ${jobId}` };
    if (job.info.state !== "running") return { ok: false, error: `Job ${jobId} is not running` };
    if (!job.child || !job.child.stdin) {
      return { ok: false, error: "nudges unavailable after reload" };
    }
    job.child.stdin.write(
      JSON.stringify({ type: "nudge", step_id: stepId, message }) + "\n",
    );
    return { ok: true };
  }

  getJobs(): JobInfo[] {
    return Array.from(this.jobs.values()).map((m) => ({
      ...m.info,
      canNudge: m.info.state === "running" && !!m.child?.stdin,
    }));
  }

  /**
   * Start any monitors from config that are not already running or blocked.
   * Called once after rehydrate() so existing live monitors aren't duplicated.
   */
  autoStartMonitors(): void {
    let config;
    try {
      config = loadProjectConfig(this.cwd);
    } catch {
      return;
    }
    const monitors = config.monitors;
    if (!monitors || monitors.length === 0) return;

    const activeWorkflowPaths = new Set(
      Array.from(this.jobs.values())
        .filter((j) => j.info.state === "running" || j.info.state === "blocked")
        .map((j) => j.info.workflowPath),
    );

    for (const monitor of monitors) {
      let resolvedPath: string;
      try {
        resolvedPath = resolveWorkflowPath(monitor, this.cwd, config);
      } catch (err) {
        console.error(`[sparkflow] auto-start monitor "${monitor}": ${(err as Error).message}`);
        continue;
      }
      if (activeWorkflowPaths.has(resolvedPath)) continue;
      this.startJob(resolvedPath, { kind: "monitor" });
    }
  }

  getJobDetail(jobId: string): { info: JobInfo; output: string[] } | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    let output: string[] = [];
    try {
      const raw = readFileSync(job.logPath, "utf-8");
      output = raw.length === 0 ? [] : raw.split("\n");
      if (output.length > 0 && output[output.length - 1] === "") output.pop();
    } catch {
      output = [...job.outputBuffer];
    }
    return { info: { ...job.info }, output };
  }

  onUpdate(cb: () => void): void {
    this.updateCallbacks.push(cb);
  }

  private fireUpdate(): void {
    for (const cb of this.updateCallbacks) cb();
  }

  private schedulePersist(jobId: string): void {
    const existing = this.persistTimers.get(jobId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.persistNow(jobId);
      this.persistTimers.delete(jobId);
    }, 250);
    // Allow node to exit even with pending persist timers.
    t.unref?.();
    this.persistTimers.set(jobId, t);
  }

  private persistNow(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const persisted: PersistedJob = {
      info: { ...job.info },
      pid: job.pid,
      logPath: job.logPath,
      logOffset: job.tailer.bytesRead,
      pendingRequestId: job.pendingRequestId,
      originalPlan: job.originalPlan,
      originalPlanText: job.originalPlanText,
      originalCwd: job.originalCwd,
    };
    try {
      this.store.saveJob(persisted);
    } catch {
      // non-fatal
    }
  }

  private openTmuxWindow(jobId: string, workflowPath: string, logPath: string, slug?: string): void {
    if (!this.tmuxSession) return;
    const workflowLabel = basename(workflowPath, ".json").slice(0, 20);
    const slugLabel = slug ? slug.replace(/\s+/g, "-").slice(0, 20) : "";
    const name = slugLabel ? `${workflowLabel}-${slugLabel}` : workflowLabel;
    const windowName = `${name}:${jobId.slice(0, 6)}`;
    try {
      execFileSync("tmux", [
        "new-window", "-d",
        "-t", this.tmuxSession,
        "-n", windowName,
        "tail", "-f", logPath,
      ], { stdio: "pipe" });
    } catch {
      // tmux unavailable, session gone, or window already exists — non-fatal
    }
  }

  /**
   * Flush all pending persists synchronously. Called before daemon exit.
   */
  flush(): void {
    for (const [id, timer] of this.persistTimers) {
      clearTimeout(timer);
      this.persistNow(id);
    }
    this.persistTimers.clear();
  }

  /**
   * Detach from all jobs without killing them. Used on reload (SIGTERM).
   */
  release(): void {
    this.flush();
    for (const job of this.jobs.values()) {
      job.tailer.stop();
    }
    if (this.rehydratedPingTimer) {
      clearInterval(this.rehydratedPingTimer);
      this.rehydratedPingTimer = null;
    }
  }

  killJob(jobId: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: `Job not found: ${jobId}` };

    if (job.info.state === "succeeded" || job.info.state === "failed") {
      return { ok: true };
    }

    job.killedByUser = true;
    job.info.summary = "killed by user";
    this.fireUpdate();
    try {
      if (job.child) {
        job.child.kill("SIGTERM");
      } else if (job.pid > 0) {
        process.kill(job.pid, "SIGTERM");
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    return { ok: true };
  }

  private killJobAndWait(jobId: string, timeoutMs = 5000): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || !job.child) return Promise.resolve();
    if (job.info.state === "succeeded" || job.info.state === "failed") {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      job.child!.once("close", onClose);

      job.killedByUser = true;
      job.info.summary = "killed by user";
      this.fireUpdate();
      try {
        job.child!.kill("SIGTERM");
      } catch {
        // ignore
      }

      setTimeout(() => {
        if (settled) return;
        try {
          job.child?.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs);
    });
  }

  async restartJob(
    jobId: string,
    mode: "fresh" | "resume" = "fresh",
  ): Promise<{ ok: boolean; newJobId?: string; error?: string }> {
    if (mode === "resume") {
      return { ok: false, error: "resume mode not yet implemented — use mode=fresh" };
    }

    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: `Job not found: ${jobId}` };

    // Rehydrated jobs (no live child) are restartable as long as their
    // original launch args were persisted. Pre-persistence jobs won't have
    // `originalPlan`/`originalPlanText`/`originalCwd` and can't be restarted.
    const isRehydrated = !job.child;
    if (
      isRehydrated &&
      !job.originalPlan &&
      !job.originalPlanText &&
      !job.originalCwd
    ) {
      return {
        ok: false,
        error: "cannot restart a rehydrated job — original launch args were not persisted; re-dispatch manually",
      };
    }

    if (job.info.state !== "succeeded" && job.info.state !== "failed") {
      if (job.child) {
        await this.killJobAndWait(jobId);
      } else if (job.pid > 0 && isAlive(job.pid)) {
        // Rehydrated job with a live pid — signal it; don't block.
        try { process.kill(job.pid, "SIGTERM"); } catch { /* already gone */ }
      }
    }

    const newJobId = this.startJob(job.info.workflowPath, {
      cwd: job.originalCwd,
      plan: job.originalPlan,
      planText: job.originalPlanText,
      slug: job.info.slug,
      description: job.info.description,
    });

    // Remove the old entry from the dashboard so the restarted job replaces it.
    // Log and persisted state remain on disk for history.
    job.tailer.stop();
    const timer = this.persistTimers.get(jobId);
    if (timer) { clearTimeout(timer); this.persistTimers.delete(jobId); }
    this.jobs.delete(jobId);
    this.fireUpdate();

    return { ok: true, newJobId };
  }

  /**
   * Drop a terminal (succeeded/failed) job from the dashboard and persisted store.
   * Stops its log tailer and clears any pending persist timer.
   */
  removeJob(jobId: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: `Job not found: ${jobId}` };
    if (job.info.state !== "succeeded" && job.info.state !== "failed") {
      return { ok: false, error: `Cannot remove job in state ${job.info.state} — kill it first` };
    }

    job.tailer.stop();
    const timer = this.persistTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(jobId);
    }
    try { this.store.removeJob(jobId); } catch { /* non-fatal */ }
    this.jobs.delete(jobId);
    this.fireUpdate();
    return { ok: true };
  }

  /**
   * Drop all terminal jobs from the dashboard. Leaves running / blocked /
   * failed_waiting jobs alone. Returns how many were removed.
   */
  clearTerminalJobs(): number {
    const ids: string[] = [];
    for (const [id, job] of this.jobs) {
      if (job.info.state === "succeeded" || job.info.state === "failed") {
        ids.push(id);
      }
    }
    for (const id of ids) this.removeJob(id);
    return ids.length;
  }

  /**
   * Kill all jobs and remove their persisted state. Used on true quit (SIGINT).
   */
  killAll(): void {
    this.flush();
    for (const [id, job] of this.jobs) {
      try {
        if (job.child) {
          job.child.kill("SIGTERM");
        } else if (job.pid > 0 && isAlive(job.pid)) {
          process.kill(job.pid, "SIGTERM");
        }
      } catch { /* ignore */ }
      job.tailer.stop();
      this.store.removeJob(id);
    }
    if (this.rehydratedPingTimer) {
      clearInterval(this.rehydratedPingTimer);
      this.rehydratedPingTimer = null;
    }
  }
}

function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we can't signal (still alive)
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
