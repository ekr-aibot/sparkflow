import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";
import type { ClaudeCodeRuntime, SandboxToolPolicy } from "../schema/types.js";

/** Tools kept native even under `bash_only` — pure filesystem ops scoped to cwd. */
const NATIVE_FS_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
/** MCP tools always allowed. */
const SPARKFLOW_MCP_TOOLS = [
  "mcp__sparkflow__bash",
  "mcp__sparkflow__ask_user",
  "mcp__sparkflow__send_message",
];

function buildAllowedTools(policy: SandboxToolPolicy): string[] | null {
  switch (policy) {
    case "off":
      return null;
    case "strict":
      return [...SPARKFLOW_MCP_TOOLS];
    case "bash_only":
      return [...SPARKFLOW_MCP_TOOLS, ...NATIVE_FS_TOOLS];
  }
}

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

    // When the step runs in a non-local sandbox, restrict the built-in tool
    // surface so the agent must route subprocesses through the in-sandbox MCP
    // bash tool. For local sandboxes we leave the tool surface alone — no
    // isolation to enforce.
    if (ctx.sandbox.kind !== "local") {
      const policy: SandboxToolPolicy = runtime.sandbox_tool_policy ?? "bash_only";
      const allowed = buildAllowedTools(policy);
      if (allowed) {
        args.push("--allowedTools", allowed.join(","));
      }
    }

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

    // Use a temp dir for any files we need to pass to claude
    const tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-mcp-"));
    const tempFiles: string[] = [];

    // Always wire up sparkflow's MCP server: it hosts the in-sandbox `bash`
    // tool (for non-local sandboxes) and `ask_user`/`send_message` (for
    // interactive steps). The sandbox decides whether that's an in-container
    // node process (docker) or a local one (local backend).
    const shouldWireMcp = ctx.sandbox.kind !== "local" || (ctx.interactive && ctx.ipcSocketPath);
    if (shouldWireMcp) {
      const mcpConfigPath = join(tmpDir, "mcp-config.json");
      tempFiles.push(mcpConfigPath);
      const stdio = ctx.sandbox.mcpStdioCommand();
      const mcpConfig = {
        mcpServers: {
          sparkflow: {
            command: stdio.command,
            args: stdio.args,
            env: stdio.env ?? {},
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

  private tryParseJson(text: string): Record<string, unknown> | null {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
