import { spawn } from "node:child_process";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";
import type { ClaudeCodeRuntime } from "../schema/types.js";

export class ClaudeCodeAdapter implements RuntimeAdapter {
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const runtime = ctx.runtime as ClaudeCodeRuntime;
    if (runtime.type !== "claude-code") {
      throw new Error(`ClaudeCodeAdapter received non-claude-code runtime: ${runtime.type}`);
    }

    const args: string[] = [];

    if (runtime.model) {
      args.push("--model", runtime.model);
    }
    if (runtime.auto_accept) {
      args.push("--dangerously-skip-permissions");
    }
    if (runtime.mcp_servers) {
      for (const server of runtime.mcp_servers) {
        args.push("--mcp", server);
      }
    }
    if (runtime.args) {
      args.push(...runtime.args);
    }

    // Build prompt: step prompt + transition message
    const parts: string[] = [];
    if (ctx.prompt) parts.push(ctx.prompt);
    if (ctx.transitionMessage) parts.push(ctx.transitionMessage);
    const fullPrompt = parts.join("\n\n");

    if (ctx.interactive) {
      // Interactive: TTY passthrough
      if (fullPrompt) {
        args.push("--prompt", fullPrompt);
      }

      return new Promise<RuntimeResult>((resolve) => {
        const child = spawn("claude", args, {
          cwd: ctx.cwd,
          env: { ...process.env as Record<string, string>, ...ctx.env },
          stdio: "inherit",
        });

        child.on("close", (code) => {
          resolve({
            success: (code ?? 1) === 0,
            outputs: {},
            exitCode: code ?? 1,
          });
        });

        child.on("error", (err) => {
          resolve({
            success: false,
            outputs: {},
            error: err.message,
          });
        });
      });
    }

    // Non-interactive: capture JSON output
    args.push("--print", "--output-format", "json");
    if (fullPrompt) {
      args.push(fullPrompt);
    }

    return new Promise<RuntimeResult>((resolve) => {
      const child = spawn("claude", args, {
        cwd: ctx.cwd,
        env: { ...process.env as Record<string, string>, ...ctx.env },
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

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
        if (success && stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout.trim());
            // Map declared outputs from the parsed response
            if (ctx.step.outputs) {
              for (const name of Object.keys(ctx.step.outputs)) {
                if (parsed[name] !== undefined) {
                  outputs[name] = parsed[name];
                }
              }
            }
            // Also store the full response as _response
            outputs._response = parsed;
          } catch {
            // If JSON parse fails, store raw output
            if (ctx.step.outputs) {
              for (const [name, decl] of Object.entries(ctx.step.outputs)) {
                if (decl.type === "text") {
                  outputs[name] = stdout.trim();
                }
              }
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
