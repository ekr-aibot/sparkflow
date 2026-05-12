import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexRuntime } from "../schema/types.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const MCP_SERVER_PATH = resolve(__dirname, "../mcp/server.js");

/**
 * Build the `codex exec` CLI args from a CodexRuntime and optional MCP config path.
 * The prompt is passed as a positional argument by the caller, not here.
 */
export function buildCodexArgs(
  runtime: CodexRuntime,
  opts: { mcpConfigPath?: string } = {}
): string[] {
  const args: string[] = [];
  if (runtime.model) args.push("--model", runtime.model);
  // Permission bypass — always required for autonomous non-interactive steps.
  args.push("--dangerously-bypass-approvals-and-sandbox");
  // JSON streaming mode for NDJSON event output.
  args.push("--json");
  if (opts.mcpConfigPath) args.push("--config-file", opts.mcpConfigPath);
  if (runtime.args) args.push(...runtime.args);
  return args;
}

/**
 * Write a minimal codex TOML config to tmpDir/codex-config.toml that wires
 * in the sparkflow MCP server. Returns the path to the config file.
 */
export function writeCodexMcpConfig(tmpDir: string, ipcSocketPath: string): string {
  const configPath = join(tmpDir, "codex-config.toml");
  const toml = [
    `[mcp_servers.sparkflow]`,
    `command = "node"`,
    `args = [${JSON.stringify(MCP_SERVER_PATH)}]`,
    ``,
    `[mcp_servers.sparkflow.env]`,
    `SPARKFLOW_SOCKET = ${JSON.stringify(ipcSocketPath)}`,
  ].join("\n") + "\n";
  writeFileSync(configPath, toml);
  return configPath;
}

/**
 * Extract the session ID from a codex NDJSON event, if present.
 * Codex may emit the session_id in different fields depending on version.
 */
export function extractCodexSessionId(event: Record<string, unknown>): string | undefined {
  if (typeof event.session_id === "string" && event.session_id) return event.session_id;
  if (typeof event.sessionId === "string" && event.sessionId) return event.sessionId;
  // Some versions embed it nested
  const meta = event.meta;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    if (typeof m.session_id === "string" && m.session_id) return m.session_id;
  }
  return undefined;
}

/**
 * Returns true when the failure text indicates a quota or rate-limit error.
 * These are transient: the engine should wait and retry.
 */
export function isCodexQuotaError(text: string): boolean {
  return /rate.{0,5}limit|quota.{0,20}exceeded|too many requests|resource.{0,10}exhausted|429/i.test(text);
}

/**
 * Returns true when the failure text indicates a context/token window limit.
 * The engine will attempt a fresh session (auto-resume) on token limit hits.
 */
export function isCodexTokenLimitError(text: string): boolean {
  return /context.{0,20}(length|window)|context_length_exceeded|input.{0,10}too.{0,10}long|maximum.{0,10}context/i.test(text);
}

/**
 * Format a user message as a codex NDJSON stdin event.
 */
export function codexUserMessage(text: string): string {
  return JSON.stringify({ type: "user_input", text }) + "\n";
}
