import type { SandboxConfig } from "../schema/types.js";

export type { SandboxConfig };

export interface SandboxOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  repoRoot?: string;
  sandbox?: SandboxConfig;
  sockets?: string[];
}

export interface SandboxApplied {
  command: string;
  args: string[];
  env: Record<string, string>;
}
