import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

/**
 * Format a stream-json event for verbose logging.
 * Returns a human-readable string, or null to skip logging.
 */
function formatStreamEvent(event: Record<string, unknown>): string | null {
  const type = event.type as string;

  if (type === "assistant") {
    const msg = event.message as Record<string, unknown> | undefined;
    if (!msg) return null;
    const content = msg.content as Array<Record<string, unknown>> | undefined;
    if (!content) return null;

    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        parts.push(String(block.text));
      } else if (block.type === "tool_use") {
        const input = block.input ? JSON.stringify(block.input) : "";
        parts.push(`[tool: ${block.name}] ${input}`);
      } else if (block.type === "tool_result") {
        // Usually not in assistant messages, but just in case
        parts.push(`[tool_result]`);
      }
    }
    return parts.length > 0 ? parts.join(" ") : null;
  }

  if (type === "result") {
    const result = event.result;
    if (result) return `result: ${String(result).slice(0, 200)}`;
    return null;
  }

  // Skip init, rate_limit_event, etc.
  return null;
}

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
    // All steps run in --print mode (no TTY), so permissions must be auto-accepted.
    // The auto_accept field in the workflow is now informational/documentation only.
    args.push("--dangerously-skip-permissions");
    // MCP servers listed in runtime.mcp_servers are resolved from the user's
    // claude MCP configuration automatically (we don't pass --strict-mcp-config).
    if (runtime.args) {
      args.push(...runtime.args);
    }

    // Use stream-json for verbose mode (real-time output), plain json otherwise
    if (ctx.verbose) {
      args.push("--print", "--output-format", "stream-json", "--verbose");
    } else {
      args.push("--print", "--output-format", "json");
    }

    // Session handling: on a fresh run, always mint a new uuid and pass
    // --session-id so we can --resume it later. On recovery-retry (ctx.resume
    // with ctx.sessionId), --resume <id> and skip the original prompt. We
    // deliberately ignore ctx.sessionId when ctx.resume is false — reusing a
    // prior id with --session-id would make claude-code reject the spawn as
    // "already in use".
    let sessionId: string;
    const resuming = Boolean(ctx.resume && ctx.sessionId);
    if (resuming) {
      sessionId = ctx.sessionId!;
      args.push("--resume", sessionId);
    } else {
      sessionId = randomUUID();
      args.push("--session-id", sessionId);
    }

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

    // Build prompt: step prompt + transition message.
    // When resuming, skip the original prompt — the conversation already has it.
    const parts: string[] = [];
    if (!resuming && ctx.prompt) parts.push(ctx.prompt);
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
      // For stream-json mode, we collect the final result event
      let resultEvent: Record<string, unknown> | null = null;
      let stdoutLineBuffer = "";

      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;

        if (ctx.verbose && ctx.logger) {
          // Parse newline-delimited JSON events
          stdoutLineBuffer += chunk;
          let newlineIdx: number;
          while ((newlineIdx = stdoutLineBuffer.indexOf("\n")) !== -1) {
            const line = stdoutLineBuffer.slice(0, newlineIdx).trim();
            stdoutLineBuffer = stdoutLineBuffer.slice(newlineIdx + 1);
            if (!line) continue;
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              if (event.type === "result") {
                resultEvent = event;
              }
              const formatted = formatStreamEvent(event);
              if (formatted) {
                ctx.logger.info(`[${ctx.stepId}] ${formatted}`);
              }
            } catch {
              // Not JSON, log raw
              ctx.logger.info(`[${ctx.stepId}] ${line}`);
            }
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

        // In stream-json (verbose) mode, use the collected result event.
        // In json mode, parse the single JSON blob from stdout.
        const parsed = ctx.verbose
          ? resultEvent
          : this.tryParseJson(stdout.trim());

        if (success && parsed) {
          if (ctx.step.outputs) {
            for (const name of Object.keys(ctx.step.outputs)) {
              if ((parsed as Record<string, unknown>)[name] !== undefined) {
                outputs[name] = (parsed as Record<string, unknown>)[name];
              }
            }
          }
          outputs._response = parsed;
        } else if (success && stdout.trim() && ctx.step.outputs) {
          // Fallback: store raw output for text outputs
          for (const [name, decl] of Object.entries(ctx.step.outputs)) {
            if (decl.type === "text") {
              outputs[name] = stdout.trim();
            }
          }
        }

        resolve({
          success,
          outputs,
          exitCode,
          error: success ? undefined : stderr.trim() || `Exit code ${exitCode}`,
          sessionId,
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
          sessionId,
        });
      });
    });
  }

  private tryParseJson(text: string): Record<string, unknown> | null {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
