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

/**
 * Returns a system reminder instructing the agent to stay inside its worktree.
 * Returns empty string when the step is not running in an isolated worktree
 * (i.e., cwd equals the repo root or repoRoot is not set).
 */
export function buildWorktreeReminder(ctx: RuntimeContext): string {
  if (!ctx.repoRoot || ctx.cwd === ctx.repoRoot) return "";
  return [
    `Your working directory is \`${ctx.cwd}\`. Treat it as the repo root for all file operations.`,
    `- Do not use absolute paths to \`${ctx.repoRoot}\` or any path outside this directory.`,
    `- Do not \`cd\` out of this directory in Bash tool calls.`,
    `- All \`git\` operations must run inside the worktree (do not use \`git -C\` to target the parent repo).`,
  ].join("\n");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the compiled MCP server entry point
const MCP_SERVER_PATH = resolve(__dirname, "../mcp/server.js");

function streamJsonUserMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/**
 * Given a string and the index of an opening `{`, return the index of the
 * matching closing `}`, honoring JSON string literals (`"..."` with `\"` and
 * `\\` escapes) so braces inside strings don't change depth. Returns -1 if
 * unmatched.
 */
function findMatchingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === "\"") {
        inString = false;
      }
      continue;
    }
    if (c === "\"") {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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

    // Build prompt: worktree confinement reminder + step prompt + transition message.
    // When resuming, skip the original prompt — the conversation already has it.
    const worktreeReminder = buildWorktreeReminder(ctx);
    if (worktreeReminder) {
      ctx.logger?.info(`[${ctx.stepId}] injected worktree confinement reminder (cwd=${ctx.cwd})`);
    }
    const parts: string[] = [];
    if (worktreeReminder) parts.push(worktreeReminder);
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

      // Nudge lifecycle tracking
      let deliveredNudge: { id: string; deliveredAt: number } | null = null;
      let postNudgeTurnCount = 0;

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
            } else if (event.type === "assistant" && deliveredNudge) {
              postNudgeTurnCount++;
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

      let selfNudgeUsed = false;
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

        // If a nudge was delivered but the child died before acking, emit abandoned
        if (deliveredNudge) {
          const dn = deliveredNudge;
          deliveredNudge = null;
          process.stderr.write(
            JSON.stringify({
              type: "nudge_event", nudge_id: dn.id, phase: "abandoned",
              step: ctx.stepId, at: Date.now(), reason: `child exited (code=${code ?? -1})`,
            }) + "\n"
          );
        }

        // Unblock the turn loop if it's still waiting for a result event
        const cb = onResultEvent;
        onResultEvent = null;
        cb?.();

        const exitCode = code ?? 1;
        let success = exitCode === 0;

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
        const quotaHit = !success && !tokenLimitHit && this.isQuotaError(parsed, stderr, stdout);

        // Extract declared outputs from the result event regardless of whether
        // the step succeeded or failed. success_output gating is a routing
        // signal only — on_failure templates must be able to reference these
        // outputs (e.g. ${steps.pick-next.output.task}).
        if (parsed) {
          const resultText = (parsed as Record<string, unknown>).result;
          const parsedResultJson = typeof resultText === "string"
            ? this.extractJsonFromResult(resultText)
            : null;

          if (ctx.step.outputs) {
            for (const [name] of Object.entries(ctx.step.outputs)) {
              // Prefer the result-text JSON (handles both "json" and "text"
              // declared types — the LLM embeds all structured output there).
              if (parsedResultJson !== null && parsedResultJson[name] !== undefined) {
                outputs[name] = parsedResultJson[name];
              } else if ((parsed as Record<string, unknown>)[name] !== undefined) {
                // Fallback: top-level field on the result event (legacy path).
                outputs[name] = (parsed as Record<string, unknown>)[name];
              }
            }
          }
          if (success) {
            outputs._response = parsed;
          }
        } else if (success && stdout.trim() && ctx.step.outputs) {
          // Fallback: no result event was captured, but stdout is available.
          for (const [name, decl] of Object.entries(ctx.step.outputs)) {
            if (decl.type === "text") {
              outputs[name] = stdout.trim();
            }
          }
        }

        // Apply success_output gate: the named output must be strictly true.
        // Outputs are preserved so on_failure templates can still reference them.
        let gateError: string | undefined;
        if (success && ctx.step.success_output) {
          const gate = this.applySuccessGate(outputs, ctx.step.success_output);
          if (!gate.success) {
            success = false;
            gateError = gate.error;
          }
        }

        resolve({
          success,
          outputs,
          exitCode,
          error: success ? undefined : (gateError ?? (stderr.trim() || `Exit code ${exitCode}`)),
          sessionId,
          tokenLimitHit,
          quotaHit,
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

          // Self-nudge: if the gate output is absent from this turn's result, inject one retry.
          // Fires only when success_output is set, the turn succeeded (not is_error), and we
          // haven't already self-nudged. Skips when value is defined-but-not-true (e.g. false)
          // so the agent's deliberate decision is respected and falls through to normal failure.
          const currentResult = resultEvent;
          if (
            currentResult &&
            ctx.step.success_output &&
            !selfNudgeUsed &&
            currentResult.is_error !== true
          ) {
            const resultText = currentResult.result;
            const parsedJson = typeof resultText === "string"
              ? this.extractJsonFromResult(resultText)
              : null;
            const gatePresent = parsedJson !== null && ctx.step.success_output in parsedJson;

            if (!gatePresent) {
              const declaredNames = ctx.step.outputs
                ? Object.keys(ctx.step.outputs)
                : [ctx.step.success_output];
              const nudgeText =
                `Your previous response did not include the required \`${ctx.step.success_output}\`` +
                ` field (and possibly other declared outputs). Please respond now with a valid JSON` +
                ` object containing all of: ${declaredNames.join(", ")}. Do not include any other prose.`;
              ctx.logger?.info(`[${ctx.stepId}:self-nudge] gate output \`${ctx.step.success_output}\` was absent, requesting re-emit`);
              child.stdin?.write(streamJsonUserMessage(nudgeText));
              selfNudgeUsed = true;
              continue;
            }
          }

          // Emit ack if a nudge was in flight and we just completed a turn
          if (deliveredNudge) {
            const now = Date.now();
            const dn = deliveredNudge;
            const tc = postNudgeTurnCount;
            deliveredNudge = null;
            const durS = ((now - dn.deliveredAt) / 1000).toFixed(1);
            process.stderr.write(
              JSON.stringify({
                type: "nudge_event", nudge_id: dn.id, phase: "acked",
                step: ctx.stepId, at: now, duration_ms: now - dn.deliveredAt, turn_count: tc,
              }) + "\n"
            );
            ctx.logger?.info(`[${ctx.stepId}:nudge:acked ${durS}s / ${tc} turns]`);
          }

          const nudgeItem = ctx.nudgeQueue?.shift();
          if (nudgeItem) {
            const { id: nudgeId, message: nudgeMsg } = nudgeItem;
            process.stderr.write(
              JSON.stringify({
                type: "nudge_event", nudge_id: nudgeId, phase: "delivered",
                step: ctx.stepId, at: Date.now(),
              }) + "\n"
            );
            ctx.logger?.info(`[${ctx.stepId}:nudge:delivered] ${nudgeId}`);
            deliveredNudge = { id: nudgeId, deliveredAt: Date.now() };
            postNudgeTurnCount = 0;
            child.stdin?.write(streamJsonUserMessage(nudgeMsg));
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
   * Parses a result text string as a flat JSON object.
   * Returns the parsed object, or null if no JSON object can be found.
   *
   * Fast path: the whole trimmed text parses as a JSON object.
   * Fallback: scan for `{...}` blocks embedded in prose and parse the first
   * one that yields a plain object. This tolerates preambles ("Here's my
   * decision: {...}") and trailing prose ("{...}\n\nLet me know if..."),
   * which models emit despite instructions to the contrary.
   */
  extractJsonFromResult(resultText: string): Record<string, unknown> | null {
    const trimmed = resultText.trim();
    try {
      const val = JSON.parse(trimmed);
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        return val as Record<string, unknown>;
      }
    } catch { /* fall through */ }

    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] !== "{") continue;
      const end = findMatchingBrace(trimmed, i);
      if (end === -1) continue;
      const slice = trimmed.slice(i, end + 1);
      try {
        const val = JSON.parse(slice);
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          return val as Record<string, unknown>;
        }
      } catch { /* try next candidate */ }
    }
    return null;
  }

  /**
   * Checks whether the named gate output is strictly true.
   * Returns success: true when it passes, or success: false with an error message when not.
   */
  applySuccessGate(
    outputs: Record<string, unknown>,
    gateName: string,
  ): { success: boolean; error?: string } {
    const gateValue = outputs[gateName];
    if (gateValue === true) return { success: true };
    return {
      success: false,
      error: `step gated on output \`${gateName}\` which was ${JSON.stringify(gateValue)}`,
    };
  }

  /**
   * Returns true when the failure is caused by a quota or rate-limit error.
   * Detects API-level rate limits (429), usage quota exhaustion, overloaded (529) errors,
   * and the Claude developer plan "You've hit your limit" message.
   * These are transient: the engine should wait and retry rather than failing the step.
   */
  isQuotaError(
    parsed: Record<string, unknown> | null,
    stderr: string,
    stdout: string = ""
  ): boolean {
    const QUOTA_RE = /quota|usage.{0,10}limit|rate.{0,5}limit|too many requests|overloaded|529|hit.{0,10}your.{0,10}limit/i;
    if (parsed?.is_error === true) {
      const resultText = String(parsed.result ?? "");
      if (QUOTA_RE.test(resultText)) return true;
      const subtype = String(parsed.subtype ?? "");
      if (/rate.{0,5}limit|overloaded/i.test(subtype)) return true;
    }
    if (QUOTA_RE.test(stderr)) return true;
    if (QUOTA_RE.test(stdout)) return true;
    return false;
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
