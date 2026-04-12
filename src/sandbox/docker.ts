import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type {
  McpStdioCommand,
  SandboxBackend,
  SandboxHandle,
  SandboxSpawnOptions,
  SandboxSpec,
} from "./types.js";
import type { DockerSandboxConfig } from "../schema/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Host path to the compiled sparkflow dist directory. Mounted into containers read-only. */
const SPARKFLOW_DIST_HOST = resolve(__dirname, "../..");
/** Container-side mount point for the sparkflow dist. */
const SPARKFLOW_DIST_CONTAINER = "/opt/sparkflow";
/** MCP server entrypoint inside the container. */
const CONTAINER_MCP_SERVER_PATH = `${SPARKFLOW_DIST_CONTAINER}/src/mcp/server.js`;
/** Where the worktree is mounted inside the container. */
const WORKSPACE_CONTAINER = "/workspace";
/** Where the IPC socket is mounted inside the container. */
const IPC_SOCKET_CONTAINER = "/tmp/sparkflow.sock";

function envToFlags(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    out.push("-e", `${k}=${v}`);
  }
  return out;
}

class DockerSandbox implements SandboxHandle {
  readonly kind = "docker" as const;

  constructor(
    readonly id: string,
    private readonly spec: SandboxSpec,
    private readonly containerEnv: Record<string, string>,
  ) {}

  spawn(opts: SandboxSpawnOptions) {
    // Merge step-level env (from spec.env) with per-call env overrides.
    // Host env is NOT forwarded — only what was explicitly passed through
    // env_passthrough at container creation.
    const env: Record<string, string> = {
      ...this.spec.env,
      ...(opts.env ?? {}),
    };

    const args: string[] = ["exec"];
    const stdio = opts.stdio;
    const wantsStdin =
      stdio === "inherit" ||
      stdio === "pipe" ||
      (Array.isArray(stdio) && stdio[0] !== "ignore");
    if (wantsStdin) args.push("-i");

    const cwd = opts.cwd ?? WORKSPACE_CONTAINER;
    args.push("-w", cwd);
    args.push(...envToFlags(env));
    args.push(this.id);

    if (opts.shell) {
      // Reconstruct a shell command line. ShellAdapter passes command as a
      // single string with shell:true; we forward it to sh -c verbatim.
      const line = [opts.command, ...(opts.args ?? [])].join(" ");
      args.push("sh", "-c", line);
    } else {
      args.push(opts.command, ...(opts.args ?? []));
    }

    // The spawned process itself is `docker exec`, which runs on the host.
    // Host env for docker CLI doesn't need ctx env — that was encoded as -e.
    return nodeSpawn("docker", args, {
      stdio: opts.stdio ?? "pipe",
    });
  }

  mcpStdioCommand(extraEnv?: Record<string, string>): McpStdioCommand {
    const env: Record<string, string> = { ...this.containerEnv };
    if (this.spec.ipcSocketHostPath) {
      env.SPARKFLOW_SOCKET = IPC_SOCKET_CONTAINER;
    }
    if (extraEnv) Object.assign(env, extraEnv);

    const args = [
      "exec",
      "-i",
      ...envToFlags(env),
      this.id,
      "node",
      CONTAINER_MCP_SERVER_PATH,
    ];

    return { command: "docker", args };
  }

  async dispose(): Promise<void> {
    try {
      // `rm -f` kills + removes synchronously. `--rm` on `docker run` would
      // also clean up, but asynchronously, which races with callers that
      // want to assert the container is gone.
      execFileSync("docker", ["rm", "-f", this.id], { stdio: "pipe" });
    } catch {
      // Container may already be gone; ignore.
    }
  }
}

export class DockerBackend implements SandboxBackend {
  readonly type = "docker" as const;

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (spec.config.type !== "docker") {
      throw new Error(`DockerBackend received non-docker config: ${spec.config.type}`);
    }
    const config = spec.config;

    const { runArgs, containerEnv } = this.buildRunArgs(spec, config);

    let id: string;
    try {
      const stdout = execFileSync("docker", runArgs, { stdio: ["ignore", "pipe", "pipe"] });
      id = stdout.toString().trim();
      if (!id) throw new Error("docker run returned empty container id");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to start sandbox container: ${msg}`);
    }

    return new DockerSandbox(id, spec, containerEnv);
  }

  private buildRunArgs(
    spec: SandboxSpec,
    config: DockerSandboxConfig,
  ): { runArgs: string[]; containerEnv: Record<string, string> } {
    const args: string[] = ["run", "-d", "--rm"];

    // Worktree mount.
    args.push("-v", `${spec.workspaceHostPath}:${WORKSPACE_CONTAINER}`);
    args.push("-w", WORKSPACE_CONTAINER);

    // Sparkflow dist — read-only so the agent can't tamper with the MCP server.
    args.push("-v", `${SPARKFLOW_DIST_HOST}:${SPARKFLOW_DIST_CONTAINER}:ro`);

    // IPC socket, if interactive.
    if (spec.ipcSocketHostPath) {
      args.push("-v", `${spec.ipcSocketHostPath}:${IPC_SOCKET_CONTAINER}`);
    }

    // User-declared extra mounts.
    if (config.mounts) {
      for (const m of config.mounts) {
        const suffix = m.mode ? `:${m.mode}` : "";
        args.push("-v", `${m.host}:${m.container}${suffix}`);
      }
    }

    if (config.user) args.push("--user", config.user);
    if (config.network) args.push("--network", config.network);

    // Step env goes into the container as default env so MCP-launched
    // subprocesses inherit it. Per-spawn env still also comes through -e.
    const containerEnv: Record<string, string> = { ...spec.env };

    // Host env passthrough.
    if (config.env_passthrough) {
      for (const name of config.env_passthrough) {
        const v = process.env[name];
        if (v !== undefined) containerEnv[name] = v;
      }
    }

    args.push(...envToFlags(containerEnv));
    args.push(config.image);
    // Universal keep-alive; works on any image with `tail` (present in all
    // standard base images we care about).
    args.push("tail", "-f", "/dev/null");

    return { runArgs: args, containerEnv };
  }
}
