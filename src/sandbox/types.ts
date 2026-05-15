import type { SandboxConfig } from "../schema/types.js";

export type { SandboxConfig };

export interface SandboxApplied {
  command: string;
  args: string[];
  env: Record<string, string>;
}
