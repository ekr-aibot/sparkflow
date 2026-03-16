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
