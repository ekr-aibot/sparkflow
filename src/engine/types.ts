export type StepState = "pending" | "waiting" | "running" | "succeeded" | "failed";

export interface StepStatus {
  state: StepState;
  retryCount: number;
  outputs: Record<string, unknown>;
  completedJoins: Set<string>;
  pendingMessages: string[];
}

export interface EngineOptions {
  cwd?: string;
  workflowDir?: string;
  dryRun?: boolean;
  logger?: Logger;
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
