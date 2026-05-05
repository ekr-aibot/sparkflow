import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";
import { resolveTemplate } from "../engine/template.js";

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

    const stepOutputs = ctx.stepOutputs ?? new Map<string, Record<string, unknown>>();

    let command = resolveTemplate(runtime.command, stepOutputs, undefined, ctx.projectConfig);
    const commandMissingMatch = /<sparkflow:missing-config path="([^"]+)">/.exec(command);
    if (commandMissingMatch) {
      return {
        success: false,
        outputs: {},
        error: `Shell command requires config.${commandMissingMatch[1]} — set it in .sparkflow/config.json`,
      };
    }
    if (command.startsWith("./")) {
      command = pathResolve(ctx.workflowDir ?? ctx.cwd, command);
      if (command.includes(" ") && !command.startsWith("\"")) {
        command = `"${command}"`;
      }
    }

    const resolvedArgs: string[] = [];
    for (const arg of runtime.args ?? []) {
      const interpolated = resolveTemplate(arg, stepOutputs, undefined, ctx.projectConfig);
      const missingMatch = /<sparkflow:missing-config path="([^"]+)">/.exec(interpolated);
      if (missingMatch) {
        return {
          success: false,
          outputs: {},
          error: `Shell arg requires config.${missingMatch[1]} — set it in .sparkflow/config.json`,
        };
      }
      let resolved = interpolated;
      if (resolved.startsWith("./")) {
        resolved = pathResolve(ctx.workflowDir ?? ctx.cwd, resolved);
      }
      if (resolved.includes(" ") && !resolved.startsWith("\"") && !resolved.startsWith("'")) {
        resolved = `"${resolved}"`;
      }
      resolvedArgs.push(resolved);
    }

    return new Promise<RuntimeResult>((resolve) => {
      const child = spawn(command, resolvedArgs, {
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
        if (ctx.step.outputs && !ctx.interactive) {
          // Combine stdout and stderr so callers see the full output on failure
          // (e.g. test runners write diagnostics to both streams).
          const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
          for (const [name, decl] of Object.entries(ctx.step.outputs)) {
            if (decl.type === "json") {
              try {
                outputs[name] = JSON.parse(combined);
              } catch {
                outputs[name] = combined;
              }
            } else {
              outputs[name] = combined;
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
