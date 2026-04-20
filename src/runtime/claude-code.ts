import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";
import type { ClaudeCodeRuntime } from "../schema/types.js";
import { suffixFor, formatClaudeEvent } from "./log-block.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the compiled MCP server entry point
const MCP_SERVER_PATH = resolve(__dirname, "../mcp/server.js");

function streamJsonUserMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

export class ClaudeCodeAdapter implements RuntimeAdapter {
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const runtime = ctx.runtime as ClaudeCodeRuntime;
    if (runtime.type !== "claude-code") {
      throw new Error(`ClaudeCodeAdapter received non-claude-code runtime: ${runtime.type}`);
    }

    const cwdStat = (() => { try { return statSync(ctx.cwd); } catch { return null; } })();
    if (!cwdStat || !cwdStat.isDirectory()) {
      return { success: false, outputs: {}, error: `cwd does not exist or is not a directory: ${ctx.cwd}` };
    }
    ctx.logger?.info(`[${ctx.stepId}] cwd=${ctx.cwd}`);

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

    // Always use stream-json input/output: the process stays alive across turns,
    // enabling mid-run nudge injection. --verbose is required to get assistant/tool
    // events alongside the result event used for turn-boundary detection.
    args.push(
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
    );

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

    return new Promise<RuntimeResult>((resolve) => {
      const child = spawn("claude", args, {
        cwd: ctx.cwd,
        env: { ...process.env as Record<string, string>, ...ctx.env },
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";
      // The result event from the most recently completed turn
      let resultEvent: Record<string, unknown> | null = null;
      let stdoutLineBuffer = "";

      // Resolved by the turn loop when it needs to wait for the next result event.
      // Also resolved (with null) by the close handler to unblock a pending wait.
      let onResultEvent: (() => void) | null = null;

      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;

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
              const cb = onResultEvent;
              onResultEvent = null;
              cb?.();
            }
            if (ctx.verbose && ctx.logger) {
              for (const block of formatClaudeEvent(event)) {
                ctx.logger.info(`[${ctx.stepId}${suffixFor(block.kind)}] ${block.text}`);
              }
            }
          } catch {
            if (ctx.verbose && ctx.logger) {
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

        // Unblock the turn loop if it's still waiting for a result event
        const cb = onResultEvent;
        onResultEvent = null;
        cb?.();

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
        const parsed = resultEvent;
        const tokenLimitHit = !success && this.isTokenLimitError(parsed, stderr);

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
          tokenLimitHit,
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

      // Multi-turn loop: write the initial prompt, then after each result event
      // check the nudge queue. If there's a pending nudge, send it as the next
      // turn. When the queue is empty, close stdin to let the process exit.
      const runTurns = async (): Promise<void> => {
        if (!fullPrompt) {
          // Nothing to send — let the process exit on its own (e.g. --resume with
          // no continuation message would be unusual, but handle it gracefully).
          child.stdin?.end();
          return;
        }

        child.stdin?.write(streamJsonUserMessage(fullPrompt));

        while (true) {
          // Wait for the current turn's result event (or process close)
          await new Promise<void>((r) => { onResultEvent = r; });

          const nudge = ctx.nudgeQueue?.shift();
          if (nudge) {
            ctx.logger?.info(`[${ctx.stepId}:nudge] sending: ${nudge.slice(0, 120)}`);
            child.stdin?.write(streamJsonUserMessage(nudge));
            // Continue loop to wait for the next turn's result
          } else {
            // No queued nudge — we're done; close stdin so the process exits
            child.stdin?.end();
            break;
          }
        }
      };

      runTurns().catch((err) => {
        ctx.logger?.info(`[${ctx.stepId}] turn loop error: ${err instanceof Error ? err.message : String(err)}`);
        child.stdin?.end();
      });
    });
  }

  /**
   * Returns true when the failure is caused by hitting the context/token window limit.
   * Detects both the CLI's error_max_turns subtype and API-level context-length errors.
   */
  isTokenLimitError(
    parsed: Record<string, unknown> | null,
    stderr: string
  ): boolean {
    if (parsed?.is_error === true) {
      if (parsed.subtype === "error_max_turns") return true;
      const resultText = String(parsed.result ?? "").toLowerCase();
      if (/context.{0,20}(length|window)|context_length_exceeded|too many tokens/.test(resultText)) {
        return true;
      }
    }
    const stderrLower = stderr.toLowerCase();
    if (/context.{0,20}(length|window) exceeded|context_length_exceeded|too many tokens/.test(stderrLower)) {
      return true;
    }
    return false;
  }
}
