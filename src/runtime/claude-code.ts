import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";
import type { ClaudeCodeRuntime } from "../schema/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the compiled MCP server entry point
const MCP_SERVER_PATH = resolve(__dirname, "../mcp/server.js");

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

    // All steps use --print mode
    args.push("--print", "--output-format", "json");

    // Use a temp dir for any files we need to pass to claude
    const tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-mcp-"));
    const tempFiles: string[] = [];

    // For interactive steps, set up MCP config so the agent can call ask_user
    if (ctx.interactive && ctx.ipcSocketPath) {
      const mcpConfigPath = join(tmpDir, "mcp-config.json");
      tempFiles.push(mcpConfigPath);
      const mcpConfig = {
        mcpServers: {
          sparkflow: {
            command: "node",
            args: [MCP_SERVER_PATH],
            env: {
              SPARKFLOW_SOCKET: ctx.ipcSocketPath,
            },
          },
        },
      };
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
      args.push("--mcp-config", mcpConfigPath);
    }

    // Build prompt: step prompt + transition message
    const parts: string[] = [];
    if (ctx.prompt) parts.push(ctx.prompt);
    if (ctx.transitionMessage) parts.push(ctx.transitionMessage);
    const fullPrompt = parts.join("\n\n");

    // Prompt is piped via stdin in --print mode to avoid ENAMETOOLONG

    return new Promise<RuntimeResult>((resolve) => {
      const child = spawn("claude", args, {
        cwd: ctx.cwd,
        env: { ...process.env as Record<string, string>, ...ctx.env },
        stdio: "pipe",
      });

      // Pipe prompt via stdin
      if (fullPrompt) {
        child.stdin?.write(fullPrompt);
        child.stdin?.end();
      } else {
        child.stdin?.end();
      }

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
        // Cleanup temp files
        for (const f of tempFiles) {
          try { unlinkSync(f); } catch { /* ignore */ }
        }

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
        for (const f of tempFiles) {
          try { unlinkSync(f); } catch { /* ignore */ }
        }
        resolve({
          success: false,
          outputs: {},
          error: err.message,
        });
      });
    });
  }
}
