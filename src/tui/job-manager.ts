import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { JobInfo } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve sparkflow-run CLI entry point relative to this file
const SPARKFLOW_RUN_PATH = resolve(__dirname, "../cli/index.js");

interface ManagedJob {
  info: JobInfo;
  process: ChildProcess;
  stdinWriter: (data: string) => void;
  outputBuffer: string[];
  pendingRequestId?: string;
  logPath?: string;
  logStream?: WriteStream;
}

export class JobManager {
  private jobs = new Map<string, ManagedJob>();
  private updateCallbacks: Array<() => void> = [];
  private tmuxSession: string | null = null;

  /**
   * Set the tmux session name so job windows can be created.
   */
  setTmuxSession(session: string): void {
    this.tmuxSession = session;
  }

  startJob(workflowPath: string, opts?: { cwd?: string; plan?: string; planText?: string }): string {
    const id = randomBytes(6).toString("hex");

    const args = ["run", workflowPath, "--verbose", "--status-json"];
    if (opts?.cwd) args.push("--cwd", opts.cwd);

    // Resolve plan path: explicit file path wins, otherwise write planText to logs dir
    let planPath = opts?.plan;
    if (!planPath && opts?.planText) {
      const workflowName = basename(workflowPath, ".json");
      const logDir = join(opts?.cwd ?? process.cwd(), ".sparkflow", "logs", workflowName);
      mkdirSync(logDir, { recursive: true });
      planPath = join(logDir, `plan-${id}.md`);
      writeFileSync(planPath, opts.planText);
    }
    if (planPath) args.push("--plan", planPath);

    const child = spawn(process.execPath, [SPARKFLOW_RUN_PATH, ...args], {
      cwd: opts?.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env as Record<string, string>,
    });

    const info: JobInfo = {
      id,
      workflowPath,
      workflowName: workflowPath,
      state: "running",
      summary: "starting…",
      startTime: Date.now(),
    };

    // Create log file for this job
    const logPath = join(tmpdir(), `sparkflow-job-${id}.log`);
    const logStream = createWriteStream(logPath, { flags: "a" });

    const managed: ManagedJob = {
      info,
      process: child,
      stdinWriter: (data: string) => {
        child.stdin?.write(data + "\n");
      },
      outputBuffer: [],
      logPath,
      logStream,
    };

    this.jobs.set(id, managed);

    // Open a tmux window with tail -f on the log
    this.openTmuxWindow(id, workflowPath, logPath);

    const safeLogWrite = (stream: WriteStream | undefined, msg: string) => {
      if (stream && !stream.closed && stream.writable) stream.write(msg);
    };

    // Parse stderr for status-json events, and capture for output buffer
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on("line", (line) => {
        managed.outputBuffer.push(`[stderr] ${line}`);
        safeLogWrite(managed.logStream, `${line}\n`);
        this.handleStatusLine(id, line);
      });
    }

    // Collect stdout for output buffer (verbose log)
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        managed.outputBuffer.push(line);
        safeLogWrite(managed.logStream, `${line}\n`);
        // Also try to parse verbose output for step info
        this.handleVerboseLine(id, line);
      });
    }

    const endLogStream = (job: ManagedJob, msg: string) => {
      if (!job.logStream || job.logStream.closed || !job.logStream.writable) return;
      job.logStream.write(msg);
      job.logStream.end();
      job.logStream = undefined;
    };

    child.on("close", (code) => {
      const job = this.jobs.get(id);
      if (job) {
        job.info.endTime = Date.now();
        if (job.info.state === "running" || job.info.state === "blocked") {
          job.info.state = code === 0 ? "succeeded" : "failed";
          job.info.summary = code === 0 ? "completed" : `exit code ${code}`;
        }
        endLogStream(job, `\n--- job ${id} ${job.info.state} ---\n`);
        this.fireUpdate();
      }
    });

    child.on("error", (err) => {
      const job = this.jobs.get(id);
      if (job) {
        job.info.state = "failed";
        job.info.summary = err.message;
        job.info.endTime = Date.now();
        endLogStream(job, `\n--- job ${id} error: ${err.message} ---\n`);
        this.fireUpdate();
      }
    });

    this.fireUpdate();
    return id;
  }

  private handleStatusLine(jobId: string, line: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return; // Not JSON, ignore
    }

    const type = event.type as string;

    if (type === "step_status") {
      job.info.currentStep = event.step as string;
      job.info.stepState = event.state as string;
      job.info.summary = `${event.step}: ${event.state}`;
      if (event.state === "succeeded" || event.state === "failed") {
        // Step completed, keep last known step
      }
      this.fireUpdate();
    } else if (type === "ask_user") {
      job.info.state = "blocked";
      job.info.pendingQuestion = event.question as string;
      job.info.summary = `waiting for answer: ${event.question}`;
      // Store request_id for later answer
      job.pendingRequestId = event.request_id as string;
      this.fireUpdate();
    } else if (type === "workflow_start") {
      job.info.workflowName = event.name as string;
      job.info.summary = "running";
      this.fireUpdate();
    } else if (type === "workflow_complete") {
      // A workflow_complete with success:false can arrive either because the
      // workflow really aborted, or because the process is wrapping up after a
      // recovery. Don't overwrite a failed_waiting state — we're intentionally
      // pausing to collect user input.
      if (job.info.state === "failed_waiting") return;
      job.info.state = event.success ? "succeeded" : "failed";
      job.info.summary = event.success ? "completed" : "failed";
      job.info.endTime = Date.now();
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

    // Parse verbose output like: [stepId] running (claude-code)
    const stepMatch = line.match(/^\[(\S+)\] (running|succeeded|failed)/);
    if (stepMatch) {
      const [, step, state] = stepMatch;
      job.info.currentStep = step;
      job.info.stepState = state;
      if (job.info.state !== "blocked") {
        job.info.summary = `${step}: ${state}`;
      }
      this.fireUpdate();
    }

    // Parse workflow start: [sparkflow] Starting workflow "name"
    const startMatch = line.match(/^\[sparkflow\] Starting workflow "(.+)"/);
    if (startMatch) {
      job.info.workflowName = startMatch[1];
      this.fireUpdate();
    }

    // Parse workflow complete
    if (line.match(/^\[sparkflow\] Workflow .+ completed successfully/)) {
      job.info.state = "succeeded";
      job.info.summary = "completed";
      job.info.endTime = Date.now();
      this.fireUpdate();
    }
    if (line.match(/^\[sparkflow\] Workflow .+ (failed|aborted)/)) {
      job.info.state = "failed";
      job.info.summary = "failed";
      job.info.endTime = Date.now();
      this.fireUpdate();
    }
  }

  answerQuestion(jobId: string, answer: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !job.info.pendingQuestion) return false;

    if (job.pendingRequestId) {
      job.stdinWriter(JSON.stringify({ type: "answer", request_id: job.pendingRequestId, response: answer }));
    }

    job.info.state = "running";
    job.info.pendingQuestion = undefined;
    job.pendingRequestId = undefined;
    job.info.summary = job.info.currentStep ? `${job.info.currentStep}: running` : "running";
    this.fireUpdate();
    return true;
  }

  answerRecovery(jobId: string, action: "retry" | "skip" | "abort", message?: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.info.state !== "failed_waiting" || !job.pendingRequestId) return false;

    const payload = JSON.stringify({ action, message });
    job.stdinWriter(JSON.stringify({ type: "answer", request_id: job.pendingRequestId, response: payload }));

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

  getJobs(): JobInfo[] {
    return Array.from(this.jobs.values()).map((m) => ({ ...m.info }));
  }

  getJobDetail(jobId: string): { info: JobInfo; output: string[] } | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return { info: { ...job.info }, output: [...job.outputBuffer] };
  }

  onUpdate(cb: () => void): void {
    this.updateCallbacks.push(cb);
  }

  private fireUpdate(): void {
    for (const cb of this.updateCallbacks) cb();
  }

  private openTmuxWindow(jobId: string, workflowPath: string, logPath: string): void {
    if (!this.tmuxSession) return;
    const name = basename(workflowPath, ".json").slice(0, 20);
    const windowName = `${name}:${jobId.slice(0, 6)}`;
    try {
      execFileSync("tmux", [
        "new-window", "-d",
        "-t", this.tmuxSession,
        "-n", windowName,
        "tail", "-f", logPath,
      ], { stdio: "pipe" });
    } catch {
      // tmux not available or session gone — non-fatal
    }
  }

  killAll(): void {
    for (const [, job] of this.jobs) {
      try {
        job.process.kill("SIGTERM");
      } catch {
        // ignore
      }
      try {
        job.logStream?.end();
      } catch {
        // ignore
      }
    }
  }
}
