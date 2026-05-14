import { existsSync } from "node:fs";
import type { RuntimeContext } from "../runtime/types.js";
import type { SandboxConfig, SandboxApplied } from "./types.js";
import { isBwrapAvailable, buildBwrapArgv } from "./bwrap.js";

/** Env var key patterns that may hold Unix socket paths needing bind mounts. */
const SOCKET_ENV_PATTERNS: RegExp[] = [/_SOCKET$/, /_SOCK$/];

/** Collect socket paths the child process needs from the RuntimeContext. */
function collectSockets(ctx: RuntimeContext): string[] {
  const sockets: string[] = [];

  if (ctx.ipcSocketPath) {
    sockets.push(ctx.ipcSocketPath);
  }

  // Inspect ctx.env and process.env for socket path env vars
  const allEnv: Record<string, string | undefined> = {
    ...(process.env as Record<string, string | undefined>),
    ...ctx.env,
  };
  for (const [k, v] of Object.entries(allEnv)) {
    if (!v) continue;
    if (SOCKET_ENV_PATTERNS.some((re) => re.test(k)) && existsSync(v)) {
      sockets.push(v);
    }
  }

  return [...new Set(sockets)];
}

/**
 * Wraps a command in a bwrap sandbox if sandboxing is enabled and available.
 *
 * Reads the effective sandbox config from ctx.sandbox, respects the
 * SPARKFLOW_SANDBOX=off global override, and handles the graceful-fallback
 * semantics (warn when bwrap unavailable unless required=true → throw).
 *
 * Returns the original command unwrapped when sandboxing is disabled.
 */
export function applySandbox(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  ctx: RuntimeContext;
}): SandboxApplied {
  const { command, args, cwd, env, ctx } = opts;

  // Global override: SPARKFLOW_SANDBOX=off disables sandboxing entirely
  if (process.env.SPARKFLOW_SANDBOX === "off") {
    return { command, args, env };
  }

  const cfg: SandboxConfig = ctx.sandbox ?? {};
  const enabled = cfg.enabled !== false; // default: true

  if (!enabled) {
    return { command, args, env };
  }

  if (!isBwrapAvailable()) {
    if (cfg.required) {
      throw new Error(
        `[${ctx.stepId}] sandbox.required=true but bwrap is not available — install bwrap to run this step`
      );
    }
    ctx.logger?.info(
      `[${ctx.stepId}] sandbox: bwrap not available — running unsandboxed (set sandbox.required=true to fail closed)`
    );
    return { command, args, env };
  }

  const sockets = collectSockets(ctx);

  const bwrapArgs = buildBwrapArgv({
    command,
    args,
    cwd,
    env,
    repoRoot: ctx.repoRoot,
    sockets,
    extra_ro_binds: cfg.extra_ro_binds,
    extra_rw_binds: cfg.extra_rw_binds,
  });

  const roBinds = cfg.extra_ro_binds?.join(",") ?? "";
  ctx.logger?.info(
    `[${ctx.stepId}] sandbox: bwrap (rw=${cwd}, ro=${roBinds || "(none)"}, network=allow)`
  );

  return {
    command: "bwrap",
    args: bwrapArgs,
    // Bwrap itself inherits the host env (it needs it to find its own libs on
    // some systems). The child's env is embedded in the argv via --clearenv /
    // --setenv, so the host env is NOT propagated into the sandboxed child.
    env: process.env as Record<string, string>,
  };
}
