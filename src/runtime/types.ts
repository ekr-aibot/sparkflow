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
  /** Outputs from previously completed steps — for adapters that resolve templates themselves. */
  stepOutputs?: Map<string, Record<string, unknown>>;
  /** Directory containing the calling workflow file — used to resolve relative paths. */
  workflowDir?: string;
}

export interface RuntimeResult {
  success: boolean;
  outputs: Record<string, unknown>;
  exitCode?: number;
  error?: string;
}

export interface RuntimeAdapter {
  run(ctx: RuntimeContext): Promise<RuntimeResult>;
}
