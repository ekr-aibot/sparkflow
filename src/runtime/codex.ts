import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";
import type { CodexRuntime } from "../schema/types.js";
import {
  buildCodexArgs,
  writeCodexMcpConfig,
  extractCodexSessionId,
  isCodexQuotaError,
  isCodexTokenLimitError,
  codexUserMessage,
} from "./codex-flags.js";
import { extractJsonFromResult, applySuccessGate } from "./claude-code.js";

export class CodexAdapter implements RuntimeAdapter {

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const runtime = ctx.runtime as CodexRuntime;
    if (runtime.type !== "codex") {
      throw new Error(`CodexAdapter received non-codex runtime: ${runtime.type}`);
    }

    const cwdStat = (() => { try { return statSync(ctx.cwd); } catch { return null; } })();
    if (!cwdStat || !cwdStat.isDirectory()) {
      return { success: false, outputs: {}, error: `cwd does not exist or is not a directory: ${ctx.cwd}` };
    }
    ctx.logger?.info(`[${ctx.stepId}] cwd=${ctx.cwd}`);

    const tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-codex-"));
    const tempFiles: string[] = [];

    // Build args: [exec|exec resume <sessionId>] [flags]
    // On resume, use `codex exec resume <id>` instead of `codex exec`.
    const resuming = Boolean(ctx.resume && ctx.sessionId);
    const subcommand: string[] = resuming
      ? ["exec", "resume", ctx.sessionId!]
      : ["exec"];

    // Interactive step → write temp config with sparkflow MCP entry.
    // Create the file first so buildCodexArgs can include --config-file alongside
    // the other flags in the right order.
    let mcpConfigPath: string | undefined;
    if (ctx.interactive && ctx.ipcSocketPath) {
      mcpConfigPath = writeCodexMcpConfig(tmpDir, ctx.ipcSocketPath);
      tempFiles.push(mcpConfigPath);
    }
    const extraArgs = buildCodexArgs(runtime, { mcpConfigPath });

    // Build the prompt to send as first stdin message. On resume, the prompt
    // is the transition message only; the original prompt is already in the
    // session's history.
    const parts: string[] = [];
    if (!resuming && ctx.prompt) parts.push(ctx.prompt);
    if (ctx.transitionMessage) parts.push(ctx.transitionMessage);
    const fullPrompt = parts.join("\n\n");

    // `codex exec` reads the prompt from stdin (--json mode). Pass it as first
    // user_input event after spawning.
    const args = [...subcommand, ...extraArgs];

    return new Promise<RuntimeResult>((resolve) => {
      const child = spawn("codex", args, {
        cwd: ctx.cwd,
        env: { ...process.env as Record<string, string>, ...ctx.env },
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";
      let stdoutLineBuffer = "";

      // Captured from the first event that carries a session_id field.
      let capturedSessionId: string | undefined = resuming ? ctx.sessionId : undefined;

      // The final assistant message text from the last turn.
      let lastAssistantText = "";
      // Accumulates all assistant text in case we need it for extraction.
      let allAssistantText = "";

      // Turn-boundary detection: codex emits a "result" or "done" event when
      // a turn completes. We track a callback to resolve the current wait.
      let onTurnEnd: (() => void) | null = null;
      let turnEnded = false;

      // Nudge tracking
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

            // Capture session ID from any event that carries it.
            if (!capturedSessionId) {
              const sid = extractCodexSessionId(event);
              if (sid) capturedSessionId = sid;
            }

            // Accumulate assistant message text.
            const evType = String(event.type ?? "");
            if (evType === "assistant_message" || evType === "item.completed") {
              const content = event.content ?? event.text ?? event.result;
              let text = "";
              if (typeof content === "string") {
                text = content;
              } else if (Array.isArray(content)) {
                text = (content as Array<Record<string, unknown>>)
                  .filter(p => p.type === "text" || p.type === "output_text")
                  .map(p => String(p.text ?? ""))
                  .join("");
              }
              if (text.trim()) {
                lastAssistantText = text.trim();
                allAssistantText += (allAssistantText ? "\n" : "") + text.trim();
              }
            }

            if (evType === "assistant" && deliveredNudge) {
              postNudgeTurnCount++;
            }

            // Turn-end: codex signals completion via a "result" or "done" event.
            if (evType === "result" || evType === "done" || evType === "turn_complete") {
              turnEnded = true;
              const cb = onTurnEnd;
              onTurnEnd = null;
              cb?.();
            }

            if (ctx.verbose && ctx.logger) {
              ctx.logger.info(`[${ctx.stepId}] ${line}`);
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
            if (line.trim()) ctx.logger!.info(`[${ctx.stepId}:stderr] ${line}`);
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
        for (const f of tempFiles) {
          try { unlinkSync(f); } catch { /* ignore */ }
        }
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

        // Unblock turn loop if waiting.
        turnEnded = true;
        const cb = onTurnEnd;
        onTurnEnd = null;
        cb?.();

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

        const exitCode = code ?? 1;
        let success = exitCode === 0;

        if (timedOut) {
          resolve({ success: false, outputs: {}, exitCode, error: `Timed out after ${ctx.timeout}s` });
          return;
        }

        const tokenLimitHit = !success && (
          isCodexTokenLimitError(stderr) || isCodexTokenLimitError(stdout)
        );
        const quotaHit = !success && !tokenLimitHit && (
          isCodexQuotaError(stderr) || isCodexQuotaError(stdout)
        );

        const outputs: Record<string, unknown> = {};
        const resultText = lastAssistantText || allAssistantText || stdout.trim();
        const parsedJson = resultText
          ? extractJsonFromResult(resultText)
          : null;

        if (ctx.step.outputs) {
          for (const [name, decl] of Object.entries(ctx.step.outputs)) {
            if (parsedJson !== null && parsedJson[name] !== undefined) {
              outputs[name] = parsedJson[name];
            } else if (decl.type === "text" && resultText) {
              outputs[name] = resultText;
            }
          }
        }
        if (success && resultText) {
          outputs._response = parsedJson ?? resultText;
        }

        // Success gate
        let gateError: string | undefined;
        if (success && ctx.step.success_output) {
          const gate = applySuccessGate(outputs, ctx.step.success_output);
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
          sessionId: capturedSessionId,
          tokenLimitHit,
          quotaHit,
        });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        for (const f of tempFiles) {
          try { unlinkSync(f); } catch { /* ignore */ }
        }
        const message = err.message.includes("ENOENT")
          ? `codex CLI not found on $PATH — install from https://github.com/openai/codex`
          : err.message;
        resolve({ success: false, outputs: {}, error: message, sessionId: capturedSessionId });
      });

      // Multi-turn loop: write the initial prompt, then service nudges between turns.
      const runTurns = async (): Promise<void> => {
        if (!fullPrompt) {
          // Nothing to send (e.g. resume with no continuation). Let codex exit.
          child.stdin?.end();
          return;
        }

        child.stdin?.write(codexUserMessage(fullPrompt));

        while (true) {
          // Wait for the current turn to end.
          turnEnded = false;
          await new Promise<void>((r) => {
            if (turnEnded) { r(); return; }
            onTurnEnd = r;
          });

          // Self-nudge if success_output gate output is absent.
          if (
            ctx.step.success_output &&
            !selfNudgeUsed &&
            lastAssistantText
          ) {
            const parsedCurrent = extractJsonFromResult(lastAssistantText);
            const gatePresent = parsedCurrent !== null && ctx.step.success_output in parsedCurrent;
            if (!gatePresent) {
              const declaredNames = ctx.step.outputs
                ? Object.keys(ctx.step.outputs)
                : [ctx.step.success_output];
              const nudgeText =
                `Your previous response did not include the required \`${ctx.step.success_output}\`` +
                ` field (and possibly other declared outputs). Please respond now with a valid JSON` +
                ` object containing all of: ${declaredNames.join(", ")}. Do not include any other prose.`;
              ctx.logger?.info(`[${ctx.stepId}:self-nudge] gate output \`${ctx.step.success_output}\` was absent, requesting re-emit`);
              child.stdin?.write(codexUserMessage(nudgeText));
              selfNudgeUsed = true;
              continue;
            }
          }

          // Emit nudge ack if one was in flight.
          if (deliveredNudge) {
            const now = Date.now();
            const dn = deliveredNudge;
            const tc = postNudgeTurnCount;
            deliveredNudge = null;
            process.stderr.write(
              JSON.stringify({
                type: "nudge_event", nudge_id: dn.id, phase: "acked",
                step: ctx.stepId, at: now, duration_ms: now - dn.deliveredAt, turn_count: tc,
              }) + "\n"
            );
            ctx.logger?.info(`[${ctx.stepId}:nudge:acked]`);
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
            child.stdin?.write(codexUserMessage(nudgeMsg));
          } else {
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
}
