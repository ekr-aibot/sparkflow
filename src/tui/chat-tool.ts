/**
 * Chat-tool abstraction: builds the spawn argv / shell invocation for the
 * dashboard's chat pane depending on which LLM CLI the user wants.
 *
 * Claude accepts sparkflow's MCP config + system prompt via flags
 * (`--mcp-config`, `--append-system-prompt`). Gemini has no equivalent
 * flags — it reads `.gemini/settings.json` and `GEMINI.md` from its cwd —
 * so for Gemini we write those files before spawn and restore any
 * pre-existing copies in `cleanup()`.
 */

import { existsSync, mkdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ChatTool = "claude" | "gemini";

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BuildChatSpawnOpts {
  tool: ChatTool;
  /** Resolved chat binary (defaults: claude → "claude", gemini → "npx"). */
  command: string;
  /** User-supplied extra args, appended after tool-specific prefixes. */
  chatArgs: string[];
  /** MCP server spec; for claude we pass via --mcp-config, for gemini we embed in settings.json. */
  mcpServerSpec: McpServerSpec;
  /** Name used as the key in .gemini/settings.json's mcpServers map and as the claude --mcp-config key. */
  mcpServerName: string;
  /** Path to the already-written MCP config file (claude consumes it directly). */
  mcpConfigPath: string;
  /** System prompt text (embedded as --append-system-prompt arg for claude, or written to GEMINI.md for gemini). */
  systemPromptText: string;
  /** Path to the file containing systemPromptText (used by the tmux shellCmd form via $(cat ...)). */
  systemPromptPath: string;
  /** Working directory — where we write .gemini/ files if applicable. */
  cwd: string;
}

export interface ChatSpawn {
  cmd: string;
  args: string[];
  /** Pre-quoted shell command string for tmux's `sh -c`. */
  shellCmd: string;
  /** Restores any backed-up files / removes tool-specific files we wrote. Safe to call at any point. */
  cleanup: () => void;
}

function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildChatSpawn(opts: BuildChatSpawnOpts): ChatSpawn {
  if (opts.tool === "claude") {
    return buildClaudeSpawn(opts);
  }
  if (opts.tool === "gemini") {
    return buildGeminiSpawn(opts);
  }
  throw new Error(`Unknown chat tool: ${String(opts.tool)}`);
}

function buildClaudeSpawn(opts: BuildChatSpawnOpts): ChatSpawn {
  const args = [
    ...opts.chatArgs,
    "--mcp-config", opts.mcpConfigPath,
    "--append-system-prompt", opts.systemPromptText,
  ];
  const shellCmd = [
    sq(opts.command),
    ...opts.chatArgs.map(sq),
    "--mcp-config", sq(opts.mcpConfigPath),
    "--append-system-prompt", `"$(cat ${sq(opts.systemPromptPath)})"`,
  ].join(" ");
  return { cmd: opts.command, args, shellCmd, cleanup: () => { /* no-op; caller owns temp dir */ } };
}

function buildGeminiSpawn(opts: BuildChatSpawnOpts): ChatSpawn {
  // When command resolves to `npx`, Gemini is invoked via the package spec so
  // NixOS (and any host without a global install) works out of the box. We also
  // add `-y` (yolo, auto-accept tools) since we control the invocation here.
  // For any other command (e.g. user pointed `--chat-command` at a specific
  // binary), we pass chatArgs through verbatim and trust the user.
  const toolPrefix = opts.command === "npx" ? ["@google/gemini-cli@latest", "-y"] : [];
  const args = [...toolPrefix, ...opts.chatArgs];

  const geminiDir = join(opts.cwd, ".gemini");
  const settingsPath = join(geminiDir, "settings.json");
  const settingsBackup = join(geminiDir, "settings.json.sparkflow-backup");
  const contextPath = join(opts.cwd, "GEMINI.md");
  const contextBackup = join(opts.cwd, "GEMINI.md.sparkflow-backup");

  // Write settings.json. If something's already there, back it up first so
  // cleanup() can restore the original.
  let createdDir = false;
  let settingsBackedUp = false;
  let contextBackedUp = false;

  if (!existsSync(geminiDir)) {
    mkdirSync(geminiDir, { recursive: true });
    createdDir = true;
  }
  if (existsSync(settingsPath)) {
    renameSync(settingsPath, settingsBackup);
    settingsBackedUp = true;
  }
  writeFileSync(
    settingsPath,
    JSON.stringify(
      { mcpServers: { [opts.mcpServerName]: opts.mcpServerSpec } },
      null,
      2,
    ),
  );

  if (existsSync(contextPath)) {
    renameSync(contextPath, contextBackup);
    contextBackedUp = true;
  }
  writeFileSync(contextPath, opts.systemPromptText);

  const shellCmd = [sq(opts.command), ...args.map(sq)].join(" ");

  const cleanup = (): void => {
    try { unlinkSync(settingsPath); } catch { /* already gone */ }
    if (settingsBackedUp) {
      try { renameSync(settingsBackup, settingsPath); } catch { /* ignore */ }
    }
    if (createdDir) {
      try { rmdirSync(geminiDir); } catch { /* non-empty or already gone */ }
    }
    try { unlinkSync(contextPath); } catch { /* already gone */ }
    if (contextBackedUp) {
      try { renameSync(contextBackup, contextPath); } catch { /* ignore */ }
    }
  };

  return { cmd: opts.command, args, shellCmd, cleanup };
}
