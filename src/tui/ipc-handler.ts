/**
 * Shared IPC dispatch for the dashboard daemon — used by both the tmux
 * status-display process and the web-mode server. Pure: no rendering, no I/O
 * beyond what the JobManager already does.
 */

import type { IpcMessage } from "../mcp/ipc.js";
import type { JobManager } from "./job-manager.js";

export async function handleIpcRequest(
  msg: IpcMessage,
  jobManager: JobManager,
  cwd: string,
): Promise<IpcMessage> {
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
      const { workflowPath, cwd: jobCwd, plan, planText, slug, description } = msg.payload as {
        workflowPath: string;
        cwd?: string;
        plan?: string;
        planText?: string;
        slug?: string;
        description?: string;
      };
      const jobId = jobManager.startJob(workflowPath, {
        cwd: jobCwd ?? cwd,
        plan,
        planText,
        slug,
        description,
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
