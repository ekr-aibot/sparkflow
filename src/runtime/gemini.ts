import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync, rmdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";
import type { GeminiRuntime } from "../schema/types.js";
import { suffixFor, formatGeminiEvent } from "./log-block.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_SERVER_PATH = resolve(__dirname, "../mcp/server.js");

/**
 * Gemini-CLI runtime adapter.
 *
 * Invocation:  npx @google/gemini-cli@latest -p "" -y -m <model> [-o text] [...args]
 * Prompt piped on stdin (Gemini's `-p` flag appends stdin to its argv prompt;
 * we pass `-p ""` to trigger non-interactive / headless mode, then stream the
 * real prompt via stdin so we don't blow the argv size cap).
 *
 * No `--resume` in v1: Gemini's session indexes are numeric per-project, not
 * UUIDs. Retries replay the full prompt + transition message.
 *
 * MCP: Gemini has no `--mcp-config <path>` flag — it reads `.gemini/settings.json`
 * from the cwd. For interactive steps we write one before spawn and restore
 * any pre-existing file in the `finally` branch.
 */
export class GeminiAdapter implements RuntimeAdapter {
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const runtime = ctx.runtime as GeminiRuntime;
    if (runtime.type !== "gemini") {
      throw new Error(`GeminiAdapter received non-gemini runtime: ${runtime.type}`);
    }

    // Resolve binary. When command is omitted, invoke via `npx @google/gemini-cli@latest`
    // so NixOS (and any system without a global install) works out of the box.
    const { cmd, prefixArgs } = runtime.command
      ? { cmd: runtime.command, prefixArgs: [] as string[] }
      : { cmd: "npx", prefixArgs: ["@google/gemini-cli@latest"] };

    const args: string[] = [...prefixArgs];
    // Headless prompt mode. The -p value is appended to stdin, so "" is fine.
    args.push("-p", "");
    // Auto-accept tool calls. Analogous to claude's --dangerously-skip-permissions.
    args.push("-y");
    if (runtime.model) args.push("-m", runtime.model);
    if (ctx.verbose) args.push("-o", "stream-json");
    else args.push("-o", "text");
    if (runtime.mcp_servers && runtime.mcp_servers.length > 0) {
      args.push("--allowed-mcp-server-names", ...runtime.mcp_servers);
    }
    if (runtime.args) args.push(...runtime.args);

    // Interactive step → write .gemini/settings.json with the sparkflow MCP entry.
    // Back up any pre-existing file so we can restore it after the run.
    const geminiDir = join(ctx.cwd, ".gemini");
    const settingsPath = join(geminiDir, "settings.json");
    const backupPath = join(geminiDir, "settings.json.sparkflow-backup");
    let wroteSettings = false;
    let createdDir = false;
    let backedUp = false;

    if (ctx.interactive && ctx.ipcSocketPath) {
      if (!existsSync(geminiDir)) {
        mkdirSync(geminiDir, { recursive: true });
        createdDir = true;
      }
      if (existsSync(settingsPath)) {
        renameSync(settingsPath, backupPath);
        backedUp = true;
      }
      const settings = {
        mcpServers: {
          sparkflow: {
            command: "node",
            args: [MCP_SERVER_PATH],
            env: { SPARKFLOW_SOCKET: ctx.ipcSocketPath },
          },
        },
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      wroteSettings = true;
    }

    const parts: string[] = [];
    if (ctx.prompt) parts.push(ctx.prompt);
    if (ctx.transitionMessage) parts.push(ctx.transitionMessage);
    const fullPrompt = parts.join("\n\n");

    const cleanup = (): void => {
      if (wroteSettings) {
        try { unlinkSync(settingsPath); } catch { /* ignore */ }
      }
      if (backedUp) {
        try { renameSync(backupPath, settingsPath); } catch { /* ignore */ }
      }
      if (createdDir) {
        try { rmdirSync(geminiDir); } catch { /* non-empty or already gone */ }
      }
    };

    return new Promise<RuntimeResult>((resolveP) => {
      const child = spawn(cmd, args, {
        cwd: ctx.cwd,
        env: { ...(process.env as Record<string, string>), ...ctx.env },
        stdio: "pipe",
      });

      if (fullPrompt) {
        child.stdin?.write(fullPrompt);
      }
      child.stdin?.end();

      let stdout = "";
      let stderr = "";
      let stdoutLineBuffer = "";

      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        if (ctx.verbose && ctx.logger) {
          stdoutLineBuffer += chunk;
          let nl: number;
          while ((nl = stdoutLineBuffer.indexOf("\n")) !== -1) {
            const line = stdoutLineBuffer.slice(0, nl).trim();
            stdoutLineBuffer = stdoutLineBuffer.slice(nl + 1);
            if (!line) continue;
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              for (const block of formatGeminiEvent(event)) {
                ctx.logger.info(`[${ctx.stepId}${suffixFor(block.kind)}] ${block.text}`);
              }
            } catch {
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
        cleanup();

        const exitCode = code ?? 1;
        const success = exitCode === 0;

        if (timedOut) {
          resolveP({ success: false, outputs: {}, exitCode, error: `Timed out after ${ctx.timeout}s` });
          return;
        }

        const outputs: Record<string, unknown> = {};
        const trimmed = stdout.trim();

        if (success && trimmed) {
          if (ctx.verbose) {
            // Verbose stdout is JSONL; extract assistant text from non-delta message events.
            let lastAssistantText = "";
            let assistantTextAll = "";
            for (const line of trimmed.split("\n")) {
              const l = line.trim();
              if (!l) continue;
              try {
                const evt = JSON.parse(l) as Record<string, unknown>;
                if (evt.type === "message" && evt.role === "assistant" && evt.delta !== true) {
                  const content = evt.content;
                  let text = "";
                  if (typeof content === "string") {
                    text = content;
                  } else if (Array.isArray(content)) {
                    text = (content as Array<Record<string, unknown>>)
                      .filter(p => p.type === "text")
                      .map(p => String(p.text ?? ""))
                      .join("");
                  }
                  if (text.trim()) {
                    lastAssistantText = text.trim();
                    assistantTextAll += (assistantTextAll ? "\n" : "") + text.trim();
                  }
                }
              } catch { /* skip malformed lines */ }
            }
            const parsedJson = lastAssistantText ? tryParseJson(lastAssistantText) : null;
            if (parsedJson && ctx.step.outputs) {
              for (const name of Object.keys(ctx.step.outputs)) {
                if (parsedJson[name] !== undefined) outputs[name] = parsedJson[name];
              }
              outputs._response = parsedJson;
            } else if (assistantTextAll) {
              if (ctx.step.outputs) {
                for (const [name, decl] of Object.entries(ctx.step.outputs)) {
                  if (decl.type === "text") outputs[name] = assistantTextAll;
                }
              }
              outputs._response = assistantTextAll;
            }
          } else {
            const parsed = tryParseJson(trimmed);
            if (parsed && ctx.step.outputs) {
              for (const name of Object.keys(ctx.step.outputs)) {
                if (parsed[name] !== undefined) outputs[name] = parsed[name];
              }
              outputs._response = parsed;
            } else {
              if (ctx.step.outputs) {
                for (const [name, decl] of Object.entries(ctx.step.outputs)) {
                  if (decl.type === "text") outputs[name] = trimmed;
                }
              }
              outputs._response = trimmed;
            }
          }
        }

        resolveP({
          success,
          outputs,
          exitCode,
          error: success ? undefined : stderr.trim() || `Exit code ${exitCode}`,
        });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        cleanup();
        resolveP({ success: false, outputs: {}, error: err.message });
      });
    });
  }
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

