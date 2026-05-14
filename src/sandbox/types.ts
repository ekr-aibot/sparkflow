export interface SandboxConfig {
  enabled?: boolean;
  required?: boolean;
  network?: "allow" | "deny";
  extra_ro_binds?: string[];
  extra_rw_binds?: string[];
}

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
