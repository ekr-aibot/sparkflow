import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";

export class ShellAdapter implements RuntimeAdapter {
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const runtime = ctx.runtime;
    if (runtime.type !== "shell") {
      throw new Error(`ShellAdapter received non-shell runtime: ${runtime.type}`);
    }

    const cwdStat = (() => { try { return statSync(ctx.cwd); } catch { return null; } })();
    if (!cwdStat || !cwdStat.isDirectory()) {
      return { success: false, outputs: {}, error: `cwd does not exist or is not a directory: ${ctx.cwd}` };
    }
    ctx.logger?.info(`[${ctx.stepId}] cwd=${ctx.cwd}`);

    const env: Record<string, string> = { ...process.env as Record<string, string>, ...ctx.env };
    if (ctx.prompt) {
      env.SPARKFLOW_PROMPT = ctx.prompt;
    }

    const stdio = ctx.interactive ? "inherit" as const : "pipe" as const;

    let command = runtime.command;
    if (command.startsWith("./")) {
      command = pathResolve(ctx.workflowDir ?? ctx.cwd, command);
      if (command.includes(" ") && !command.startsWith("\"")) {
        command = `"${command}"`;
      }
    }

    const args = (runtime.args ?? []).map((arg) => {
      let resolved = arg;
      if (arg.startsWith("./")) {
        resolved = pathResolve(ctx.workflowDir ?? ctx.cwd, arg);
      }
      if (resolved.includes(" ") && !resolved.startsWith("\"") && !resolved.startsWith("'")) {
        return `"${resolved}"`;
      }
      return resolved;
    });

    return new Promise<RuntimeResult>((resolve) => {
      const child = spawn(command, args, {
        cwd: runtime.cwd ?? ctx.cwd,
        env,
        stdio,
        shell: true,
        detached: true,
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
          // Kill the entire process group so child processes (e.g. sleep spawned
          // by the shell) don't keep the stdio pipes open after the shell exits.
          if (child.pid != null) {
            try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
          } else {
            child.kill("SIGTERM");
          }
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
