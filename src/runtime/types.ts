import type { Runtime, Step } from "../schema/types.js";
import type { GitConfig, ProjectConfig } from "../config/project-config.js";

export interface NudgeItem {
  id: string;
  message: string;
}

/**
 * A lightweight FIFO queue for injecting user messages into a running ClaudeCodeAdapter turn loop.
 * The engine pushes messages; the adapter drains them after each completed turn.
 */
export class NudgeQueue {
  private readonly items: NudgeItem[] = [];

  push(message: string, id: string): void {
    this.items.push({ id, message });
  }

  shift(): NudgeItem | undefined {
    return this.items.shift();
  }

  drain(): NudgeItem[] {
    return this.items.splice(0);
  }
}

export interface RuntimeContext {
  stepId: string;
  step: Step;
  runtime: Runtime;
  /** Project-level git/GitHub config (from .sparkflow/config.json). Used by pr-creator and pr-watcher. */
  git?: GitConfig;
  /** Full merged project config — available to adapters for template interpolation. */
  projectConfig?: ProjectConfig;
  prompt?: string;
  transitionMessage?: string;
  cwd: string;
  env: Record<string, string>;
  interactive: boolean;
  timeout?: number;
  /** Path to the IPC Unix socket for interactive steps (MCP-based user communication). */
  ipcSocketPath?: string;
  /** When true, stream sub-agent stdout/stderr to the logger in real time. */
  verbose?: boolean;
  /** Logger for verbose output, prefixed with step ID. */
  logger?: import("../engine/types.js").Logger;
  /** Conversation session id — set it on a fresh run, or resume an existing one. */
  sessionId?: string;
  /** When true and sessionId is set, resume that session instead of starting fresh. */
  resume?: boolean;
  /** Outputs from previously completed steps — for adapters that resolve templates themselves. */
  stepOutputs?: Map<string, Record<string, unknown>>;
  /** Directory containing the calling workflow file — used to resolve relative paths. */
  workflowDir?: string;
  /**
   * Queue for receiving nudge messages mid-run (claude-code only).
   * The engine pushes messages here when the step is running; the adapter drains
   * them after each completed turn instead of closing stdin.
   */
  nudgeQueue?: NudgeQueue;
}

export interface RuntimeResult {
  success: boolean;
  outputs: Record<string, unknown>;
  exitCode?: number;
  error?: string;
  /** For claude-code: the session id actually used (so engine can persist it for retries). */
  sessionId?: string;
  /** True when the run failed due to hitting the context/token limit, signalling the engine to auto-resume. */
  tokenLimitHit?: boolean;
  /** True when the run failed due to hitting a quota/rate limit, signalling the engine to wait and retry. */
  quotaHit?: boolean;
}

export interface RuntimeAdapter {
  run(ctx: RuntimeContext): Promise<RuntimeResult>;
}
