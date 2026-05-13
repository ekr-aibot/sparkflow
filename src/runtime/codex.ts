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
import { extractQuotaResetSeconds } from "./quota-reset.js";

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

    let currentSessionId = (ctx.resume && ctx.sessionId) ? ctx.sessionId : undefined;
    let initialTurnDone = false;
    let selfNudgeUsed = false;
    let lastResult: RuntimeResult | null = null;

    try {
      while (true) {
        let promptText = "";
        let isNudge = false;
        let nudgeId: string | undefined;

        // 1. Determine prompt for this turn
        if (!initialTurnDone) {
          if (!currentSessionId) {
            // Fresh run: use prompt + transition
            const parts: string[] = [];
            if (ctx.prompt) parts.push(ctx.prompt);
            if (ctx.transitionMessage) parts.push(ctx.transitionMessage);
            promptText = parts.join("\n\n");
          } else {
            // Resuming existing session: only use transition message if any
            promptText = ctx.transitionMessage || "";
          }
          initialTurnDone = true;
        } else {
          // Check for manual nudge
          const nudgeItem = ctx.nudgeQueue?.shift();
          if (nudgeItem) {
            promptText = nudgeItem.message;
            nudgeId = nudgeItem.id;
            isNudge = true;
          } else if (lastResult && ctx.step.success_output && !selfNudgeUsed) {
            // Check for self-nudge (missing success gate)
            const resultText = typeof lastResult.outputs._response === "string"
              ? lastResult.outputs._response
              : JSON.stringify(lastResult.outputs._response);

            const parsedCurrent = extractJsonFromResult(resultText);
            const gatePresent = parsedCurrent !== null && ctx.step.success_output in parsedCurrent;
            if (!gatePresent && resultText) {
              const declaredNames = ctx.step.outputs
                ? Object.keys(ctx.step.outputs)
                : [ctx.step.success_output];
              promptText =
                `Your previous response did not include the required \`${ctx.step.success_output}\`` +
                ` field (and possibly other declared outputs). Please respond now with a valid JSON` +
                ` object containing all of: ${declaredNames.join(", ")}. Do not include any other prose.`;
              ctx.logger?.info(`[${ctx.stepId}:self-nudge] gate output \`${ctx.step.success_output}\` was absent, requesting re-emit`);
              selfNudgeUsed = true;
              isNudge = true;
            }
          }
        }

        // 2. Execute turn if we have a prompt or it's the very first turn (which might be empty resume)
        const isFirstTurn = !lastResult;
        if (promptText || isFirstTurn) {
          if (nudgeId) {
            process.stderr.write(
              JSON.stringify({
                type: "nudge_event", nudge_id: nudgeId, phase: "delivered",
                step: ctx.stepId, at: Date.now(),
              }) + "\n"
            );
            ctx.logger?.info(`[${ctx.stepId}:nudge:delivered] ${nudgeId}`);
          }

          const turnResult = await this.executeTurn(ctx, runtime, currentSessionId, promptText, tmpDir, tempFiles);
          currentSessionId = turnResult.sessionId || currentSessionId;
          lastResult = turnResult;

          if (nudgeId) {
            process.stderr.write(
              JSON.stringify({
                type: "nudge_event", nudge_id: nudgeId, phase: "acked",
                step: ctx.stepId, at: Date.now(), duration_ms: 100,
                turn_count: 1,
              }) + "\n"
            );
          }

          if (!turnResult.success) {
            // Stop on failure unless it's a gate failure (exitCode 0) on the initial turn,
            // which might be fixable by self-nudge in the next iteration.
            const isGateFailure = turnResult.exitCode === 0 && ctx.step.success_output;
            if (isNudge || !isGateFailure) break;
          }
          
          // If it was a nudge, we continue to check for more nudges or self-nudge.
        } else {
          break;
        }
      }

      return lastResult || { success: false, outputs: {}, error: "No turns executed" };
    } finally {
      for (const f of tempFiles) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  private async executeTurn(
    ctx: RuntimeContext,
    runtime: CodexRuntime,
    sessionId: string | undefined,
    prompt: string,
    tmpDir: string,
    tempFiles: string[]
  ): Promise<RuntimeResult> {
    let mcpConfigPath: string | undefined;
    if (ctx.interactive && ctx.ipcSocketPath) {
      mcpConfigPath = writeCodexMcpConfig(tmpDir, ctx.ipcSocketPath);
      if (!tempFiles.includes(mcpConfigPath)) tempFiles.push(mcpConfigPath);
    }
    const args = buildCodexArgs(runtime, { mcpConfigPath, sessionId });

    return new Promise<RuntimeResult>((resolve) => {
      const child = spawn("codex", args, {
        cwd: ctx.cwd,
        env: { ...process.env as Record<string, string>, ...ctx.env },
        stdio: "pipe",
      });

      // Write prompt to stdin and close it immediately. 
      // Codex reads until EOF before starting.
      if (prompt) {
        child.stdin?.write(codexUserMessage(prompt));
      }
      child.stdin?.end();

      let stdout = "";
      let stderr = "";
      let stdoutLineBuffer = "";
      let capturedSessionId: string | undefined = sessionId;
      let lastAssistantText = "";
      let allAssistantText = "";

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
            if (!capturedSessionId) {
              const sid = extractCodexSessionId(event);
              if (sid) capturedSessionId = sid;
            }

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
              } else if (evType === "item.completed") {
                const item = event.item as Record<string, unknown>;
                if (item?.type === "agent_message" && typeof item.text === "string") {
                  text = item.text;
                }
              }

              if (text.trim()) {
                lastAssistantText = text.trim();
                allAssistantText += (allAssistantText ? "\n" : "") + text.trim();
              }
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
        const quotaText = [String(lastAssistantText ?? ""), stderr, stdout].filter(Boolean).join("\n");
        const quotaResetSeconds = quotaHit ? (extractQuotaResetSeconds(quotaText) ?? undefined) : undefined;

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
          quotaResetSeconds,
        });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        const message = err.message.includes("ENOENT")
          ? `codex CLI not found on $PATH — install from https://github.com/openai/codex`
          : err.message;
        resolve({ success: false, outputs: {}, error: message, sessionId: capturedSessionId });
      });
    });
  }
}
