export interface JobInfo {
  id: string;
  workflowPath: string;
  workflowName: string;
  slug?: string;
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
}

export type DashboardRequest =
  | { type: "start_workflow"; id: string; payload: { workflowPath: string; cwd?: string; plan?: string; planText?: string; slug?: string } }
  | { type: "list_jobs"; id: string; payload: Record<string, never> }
  | { type: "get_job_detail"; id: string; payload: { jobId: string } }
  | { type: "answer_question"; id: string; payload: { jobId: string; answer: string } }
  | { type: "answer_recovery"; id: string; payload: { jobId: string; action: "retry" | "skip" | "abort"; message?: string } }
  | { type: "kill_job"; id: string; payload: { jobId: string } }
  | { type: "restart_job"; id: string; payload: { jobId: string; mode?: "fresh" | "resume" } };

export type DashboardResponse = {
  type: string;
  id: string;
  payload: Record<string, unknown>;
};
