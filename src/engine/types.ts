export type StepState = "pending" | "waiting" | "running" | "succeeded" | "failed";

export interface StepStatus {
  state: StepState;
  retryCount: number;
  outputs: Record<string, unknown>;
  completedJoins: Set<string>;
  pendingMessages: string[];
  /** Claude conversation session id captured from first run; used by recovery-retry to resume. */
  sessionId?: string;
  /** Last error message, preserved for recovery prompts. */
  lastError?: string;
}

export interface EngineOptions {
  cwd?: string;
  workflowDir?: string;
  dryRun?: boolean;
  logger?: Logger;
  /** Project plan prepended to every step's prompt. */
  plan?: string;
  /** Stream sub-agent stdout/stderr to the console in real time. */
  verbose?: boolean;
  /** Emit structured JSON status events on stderr for dashboard integration. */
  statusJson?: boolean;
}

export interface RunResult {
  success: boolean;
  stepResults: Map<string, StepStatus>;
  error?: string;
}

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export class ConsoleLogger implements Logger {
  info(message: string): void {
    console.log(message);
  }
  error(message: string): void {
    console.error(message);
  }
}
