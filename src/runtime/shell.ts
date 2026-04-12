import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";

export class ShellAdapter implements RuntimeAdapter {
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const runtime = ctx.runtime;
    if (runtime.type !== "shell") {
      throw new Error(`ShellAdapter received non-shell runtime: ${runtime.type}`);
    }

    // Per-call env — sandbox merges with ctx.env and (for local) host env.
    const env: Record<string, string> = {};
    if (ctx.prompt) {
      env.SPARKFLOW_PROMPT = ctx.prompt;
    }

    const stdio = ctx.interactive ? "inherit" as const : "pipe" as const;

    return new Promise<RuntimeResult>((resolve) => {
      const child = ctx.sandbox.spawn({
        command: runtime.command,
        args: runtime.args ?? [],
        cwd: runtime.cwd,
        env,
        stdio,
        shell: true,
      });

      let stdout = "";
      let stderr = "";

      if (!ctx.interactive) {
        child.stdout?.on("data", (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          if (ctx.verbose && ctx.logger) {
            for (const line of chunk.split("\n")) {
              if (line.trim()) ctx.logger.info(`[${ctx.stepId}:stdout] ${line}`);
            }
          }
        });
        child.stderr?.on("data", (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
          if (ctx.verbose && ctx.logger) {
            for (const line of chunk.split("\n")) {
              if (line.trim()) ctx.logger.info(`[${ctx.stepId}:stderr] ${line}`);
            }
          }
        });
      }

      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (ctx.timeout) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, ctx.timeout * 1000);
      }

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const exitCode = code ?? 1;
        const success = exitCode === 0;

        if (timedOut) {
          resolve({
            success: false,
            outputs: {},
            exitCode,
            error: `Timed out after ${ctx.timeout}s`,
          });
          return;
        }

        const outputs: Record<string, unknown> = {};
        if (success && ctx.step.outputs && !ctx.interactive) {
          const trimmed = stdout.trim();
          for (const [name, decl] of Object.entries(ctx.step.outputs)) {
            if (decl.type === "json") {
              try {
                outputs[name] = JSON.parse(trimmed);
              } catch {
                outputs[name] = trimmed;
              }
            } else {
              outputs[name] = trimmed;
            }
          }
        }

        resolve({
          success,
          outputs,
          exitCode,
          error: success ? undefined : stderr.trim() || `Exit code ${exitCode}`,
        });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          success: false,
          outputs: {},
          error: err.message,
        });
      });
    });
  }
}
