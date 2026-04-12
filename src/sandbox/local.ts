import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type {
  McpStdioCommand,
  SandboxBackend,
  SandboxHandle,
  SandboxSpawnOptions,
  SandboxSpec,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute host path to the compiled MCP server entrypoint. */
export const LOCAL_MCP_SERVER_PATH = resolve(__dirname, "../mcp/server.js");

/**
 * No-op sandbox: commands run directly on the host via `child_process.spawn`.
 * Preserves today's behaviour exactly.
 */
class LocalSandbox implements SandboxHandle {
  readonly id = "local";
  readonly kind = "local" as const;

  constructor(private readonly spec: SandboxSpec) {}

  spawn(opts: SandboxSpawnOptions) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...this.spec.env,
      ...(opts.env ?? {}),
    };
    return nodeSpawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd ?? this.spec.workspaceHostPath,
      env,
      stdio: opts.stdio ?? "pipe",
      shell: opts.shell ?? false,
    });
  }

  mcpStdioCommand(extraEnv?: Record<string, string>): McpStdioCommand {
    const env: Record<string, string> = {};
    if (this.spec.ipcSocketHostPath) {
      env.SPARKFLOW_SOCKET = this.spec.ipcSocketHostPath;
    }
    if (extraEnv) Object.assign(env, extraEnv);
    return {
      command: "node",
      args: [LOCAL_MCP_SERVER_PATH],
      env,
    };
  }

  async dispose(): Promise<void> {
    // nothing to clean up
  }
}

export class LocalBackend implements SandboxBackend {
  readonly type = "local" as const;

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    return new LocalSandbox(spec);
  }
}
