import type { ChildProcess, StdioOptions } from "node:child_process";
import type { SandboxConfig, Step } from "../schema/types.js";

/**
 * Options passed to `SandboxHandle.spawn`. A minimal subset of Node's
 * `child_process.spawn` options, plus a `shell` flag. Backends translate
 * these to whatever their underlying spawn mechanism needs.
 */
export interface SandboxSpawnOptions {
  command: string;
  args?: string[];
  /**
   * Working directory. For non-local sandboxes this must be a path inside
   * the sandbox — typically "/workspace" (where the worktree is mounted).
   */
  cwd?: string;
  env?: Record<string, string>;
  stdio?: StdioOptions;
  /** When true, run the command through `sh -c` so shell features work. */
  shell?: boolean;
}

/**
 * The stdio transport claude should use to reach the sparkflow MCP server.
 * Written into the `--mcp-config` JSON that claude reads at startup.
 */
export interface McpStdioCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * A live sandbox (for DockerBackend, a running container). Created once
 * per step and disposed after the step completes.
 */
export interface SandboxHandle {
  /** Identifier, e.g. a container id. Used for logging. */
  readonly id: string;
  /** Kind of backend, matches SandboxConfig.type. */
  readonly kind: SandboxConfig["type"];
  /**
   * Spawn a command inside the sandbox and return a Node ChildProcess.
   * Adapters can attach listeners to stdout/stderr/close/error just like
   * a regular `child_process.spawn` call.
   */
  spawn(opts: SandboxSpawnOptions): ChildProcess;
  /**
   * Command that claude should use as its MCP stdio transport. For local,
   * this is `node <dist>/src/mcp/server.js`; for docker, `docker exec -i
   * <id> node /opt/sparkflow/src/mcp/server.js`.
   */
  mcpStdioCommand(extraEnv?: Record<string, string>): McpStdioCommand;
  /** Shut down the sandbox. Safe to call multiple times. */
  dispose(): Promise<void>;
}

/**
 * Spec passed to `SandboxBackend.create`. Engine-level inputs that apply
 * to every backend; backend-specific config lives in `spec.config`.
 */
export interface SandboxSpec {
  stepId: string;
  step: Step;
  /** Host path to the step's worktree. Mounted at /workspace inside the sandbox. */
  workspaceHostPath: string;
  /** Step env (from workflow config, not host env). */
  env: Record<string, string>;
  /** Host path to the IPC unix socket for ask_user, if the step is interactive. */
  ipcSocketHostPath?: string;
  /** Resolved sandbox config for this step. */
  config: SandboxConfig;
}

export interface SandboxBackend {
  /** Type tag (e.g. "local", "docker"). */
  readonly type: SandboxConfig["type"];
  create(spec: SandboxSpec): Promise<SandboxHandle>;
}
