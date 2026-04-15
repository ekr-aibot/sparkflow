import type { Runtime, Step } from "../schema/types.js";

export interface RuntimeContext {
  stepId: string;
  step: Step;
  runtime: Runtime;
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
}

export interface RuntimeResult {
  success: boolean;
  outputs: Record<string, unknown>;
  exitCode?: number;
  error?: string;
  /** For claude-code: the session id actually used (so engine can persist it for retries). */
  sessionId?: string;
}

export interface RuntimeAdapter {
  run(ctx: RuntimeContext): Promise<RuntimeResult>;
}
