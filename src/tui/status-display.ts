#!/usr/bin/env node

/**
 * Status display process — runs in the bottom tmux pane.
 * Hosts the IPC server and job manager, renders status to stdout.
 */

import { unlinkSync } from "node:fs";
import { IpcServer, type IpcMessage } from "../mcp/ipc.js";
import { JobManager } from "./job-manager.js";
import type { JobInfo } from "./types.js";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const STATE_COLORS: Record<string, string> = {
  running: COLORS.yellow,
  succeeded: COLORS.green,
  failed: COLORS.red,
  failed_waiting: COLORS.red,
  blocked: COLORS.magenta,
};

function elapsed(startTime: number, endTime?: number): string {
  const ms = (endTime ?? Date.now()) - startTime;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

function renderJobs(jobs: JobInfo[]): void {
  const cols = process.stdout.columns || 80;

  // Move cursor to top-left of our pane and clear
  let out = "\x1b[H\x1b[2J";

  // Header
  const headerText = "─── sparkflow jobs ───";
  const padding = "─".repeat(Math.max(0, cols - headerText.length));
  out += `${COLORS.dim}${headerText}${padding}${COLORS.reset}\n`;

  if (jobs.length === 0) {
    out += `${COLORS.dim}No jobs running. Use /sf-dispatch in the chat pane to start a workflow.${COLORS.reset}\n`;
  } else {
    for (const job of jobs) {
      const color = STATE_COLORS[job.state] ?? COLORS.reset;
      const step = job.currentStep ? `/${job.currentStep}` : "";
      const baseName = job.workflowName || job.workflowPath;
      const name = job.slug ? `${baseName}: ${job.slug}` : baseName;
      const stateLabel = job.state.toUpperCase();
      const time = elapsed(job.startTime, job.endTime);
      const question = job.pendingQuestion ? ` ? ${job.pendingQuestion}` : "";
      out += `${COLORS.dim}${job.id.slice(0, 8)}${COLORS.reset} ${COLORS.cyan}[${name}${step}]${COLORS.reset} ${color}${stateLabel}${COLORS.reset} ${job.summary}${question} ${COLORS.dim}(${time})${COLORS.reset}\n`;
    }
  }

  process.stdout.write(out);
}

async function handleIpcRequest(msg: IpcMessage, jobManager: JobManager, cwd: string): Promise<IpcMessage> {
  const response = (payload: Record<string, unknown>): IpcMessage => ({
    type: "response",
    id: msg.id,
    payload,
  });
  const errorResponse = (error: string): IpcMessage => ({
    type: "error",
    id: msg.id,
    payload: { error },
  });

  switch (msg.type) {
    case "start_workflow": {
      const { workflowPath, cwd: jobCwd, plan, planText, slug } = msg.payload as {
        workflowPath: string;
        cwd?: string;
        plan?: string;
        planText?: string;
        slug?: string;
      };
      const jobId = jobManager.startJob(workflowPath, {
        cwd: jobCwd ?? cwd,
        plan,
        planText,
        slug,
      });
      return response({ jobId });
    }
    case "list_jobs":
      return response({ jobs: jobManager.getJobs() });
    case "get_job_detail": {
      const { jobId } = msg.payload as { jobId: string };
      const detail = jobManager.getJobDetail(jobId);
      if (!detail) return errorResponse(`Job not found: ${jobId}`);
      return response(detail as unknown as Record<string, unknown>);
    }
    case "answer_question": {
      const { jobId, answer } = msg.payload as { jobId: string; answer: string };
      const ok = jobManager.answerQuestion(jobId, answer);
      if (!ok) return errorResponse(`No pending question for job: ${jobId}`);
      return response({});
    }
    case "answer_recovery": {
      const { jobId, action, message } = msg.payload as {
        jobId: string;
        action: "retry" | "skip" | "abort";
        message?: string;
      };
      const ok = jobManager.answerRecovery(jobId, action, message);
      if (!ok) return errorResponse(`Job ${jobId} is not waiting for recovery`);
      return response({});
    }
    case "kill_job": {
      const { jobId } = msg.payload as { jobId: string };
      const result = jobManager.killJob(jobId);
      if (!result.ok) return errorResponse(result.error ?? "kill failed");
      return response({ jobId });
    }
    case "restart_job": {
      const { jobId, mode } = msg.payload as { jobId: string; mode?: "fresh" | "resume" };
      const result = await jobManager.restartJob(jobId, mode ?? "fresh");
      if (!result.ok) return errorResponse(result.error ?? "restart failed");
      return response({ oldJobId: jobId, newJobId: result.newJobId });
    }
    case "remove_job": {
      const { jobId } = msg.payload as { jobId: string };
      const result = jobManager.removeJob(jobId);
      if (!result.ok) return errorResponse(result.error ?? "remove failed");
      return response({ jobId });
    }
    case "clear_terminal_jobs": {
      const removed = jobManager.clearTerminalJobs();
      return response({ removed });
    }
    default:
      return errorResponse(`Unknown message type: ${msg.type}`);
  }
}

async function main(): Promise<void> {
  const socketPath = process.argv[2];
  const cwd = process.argv[3] || process.cwd();
  const tmuxSession = process.argv[4];

  if (!socketPath) {
    console.error("Usage: status-display <socket-path> [cwd] [tmux-session]");
    process.exit(1);
  }

  const jobManager = new JobManager(cwd);
  if (tmuxSession) {
    jobManager.setTmuxSession(tmuxSession);
  }

  // Rehydrate any jobs that were running before a reload.
  jobManager.rehydrate();

  // The previous daemon's socket file may still exist — remove it so listen() succeeds.
  try { unlinkSync(socketPath); } catch { /* not present */ }

  const ipcServer = new IpcServer(socketPath);

  ipcServer.onRequest(async (msg) => {
    return handleIpcRequest(msg, jobManager, cwd);
  });

  await ipcServer.listen();

  // Render on job updates
  jobManager.onUpdate(() => renderJobs(jobManager.getJobs()));

  // Periodic re-render for elapsed time
  setInterval(() => {
    renderJobs(jobManager.getJobs());
  }, 1000);

  // Initial render (shows rehydrated jobs immediately)
  renderJobs(jobManager.getJobs());

  // SIGTERM = supervisor requesting reload: detach from jobs, let them keep running.
  // SIGINT = user quitting: kill everything and clear state.
  let exiting = false;
  const onReload = () => {
    if (exiting) return;
    exiting = true;
    jobManager.release();
    ipcServer.close().finally(() => process.exit(0));
  };
  const onQuit = () => {
    if (exiting) return;
    exiting = true;
    jobManager.killAll();
    ipcServer.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", onReload);
  process.on("SIGHUP", onReload);
  process.on("SIGINT", onQuit);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
