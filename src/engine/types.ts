export type StepState = "pending" | "waiting" | "running" | "succeeded" | "failed";

import type { NudgeQueue } from "../runtime/types.js";

export interface StepStatus {
  state: StepState;
  retryCount: number;
  /** In-place retry attempts used in the current execution (resets on success or upstream re-entry). */
  inPlaceAttempt: number;
  /** Number of times the step has been auto-resumed after hitting a token/context limit. */
  tokenLimitResumes: number;
  outputs: Record<string, unknown>;
  completedJoins: Set<string>;
  pendingMessages: string[];
  /** Claude conversation session id captured from first run; used by recovery-retry to resume. */
  sessionId?: string;
  /** Last error message, preserved for recovery prompts. */
  lastError?: string;
  /**
   * Active nudge queue for a running claude-code step.
   * Set by executeStep before calling adapter.run(); cleared in the finally block.
   * Allows triggerStep to route mid-run messages directly to the running adapter
   * instead of queuing them for a post-completion re-run.
   */
  nudgeQueue?: NudgeQueue;
}

import type { ProjectConfig } from "../config/project-config.js";

export interface EngineOptions {
  cwd?: string;
  workflowDir?: string;
  dryRun?: boolean;
  logger?: Logger;
  /** Project config loaded from .sparkflow/config.json. */
  config?: ProjectConfig;
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
