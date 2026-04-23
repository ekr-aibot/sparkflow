export interface JobInfo {
  id: string;
  workflowPath: string;
  workflowName: string;
  slug?: string;
  /** Longer description shown in the dashboard tooltip (e.g. a GitHub issue title). */
  description?: string;
  /** Set to "monitor" for jobs auto-started from the monitors config array. */
  kind?: "monitor";
  state: "running" | "succeeded" | "failed" | "blocked" | "failed_waiting";
  currentStep?: string;
  stepState?: string;
  summary: string;
  startTime: number;
  endTime?: number;
  pendingQuestion?: string;
  /** The step that failed and is awaiting user recovery. */
  failedStep?: string;
  /** The error message from the failure, if available. */
  failedError?: string;
  /** Step IDs that are currently running, derived from step_status events. */
  activeSteps?: string[];
  /** Step IDs with runtime type "claude-code", populated from workflow_steps event. */
  claudeCodeSteps?: string[];
  /** True when the job is running and its stdin pipe is live (nudges available). */
  canNudge?: boolean;
  /** True when the job was explicitly killed by the user via killJob(). */
  killedByUser?: boolean;
}

export type DashboardRequest =
  | { type: "start_workflow"; id: string; payload: { workflowPath: string; cwd?: string; plan?: string; planText?: string; slug?: string; description?: string } }
  | { type: "list_jobs"; id: string; payload: Record<string, never> }
  | { type: "get_job_detail"; id: string; payload: { jobId: string } }
  | { type: "answer_question"; id: string; payload: { jobId: string; answer: string } }
  | { type: "answer_recovery"; id: string; payload: { jobId: string; action: "retry" | "skip" | "abort"; message?: string } }
  | { type: "kill_job"; id: string; payload: { jobId: string } }
  | { type: "restart_job"; id: string; payload: { jobId: string; mode?: "fresh" | "resume" } }
  | { type: "remove_job"; id: string; payload: { jobId: string } }
  | { type: "clear_terminal_jobs"; id: string; payload: Record<string, never> }
  | { type: "nudge_job"; id: string; payload: { jobId: string; stepId: string; message: string } };

export type DashboardResponse = {
  type: string;
  id: string;
  payload: Record<string, unknown>;
};
