/**
 * Codex chat surface helpers.
 *
 * Manages the lifecycle of sparkflow-managed files in ~/.codex/ for the
 * interactive codex chat:
 *
 * - MCP wiring: inserts/removes a [mcp_servers.sparkflow] block in
 *   ~/.codex/config.toml, bounded by marker comments so cleanup is safe.
 * - System prompt: writes/removes an AGENTS.md block in the project cwd
 *   (Codex's equivalent of CLAUDE.md), bounded by the same markers.
 * - Slash commands: writes/removes ~/.codex/prompts/sf-*.md files.
 *
 * All install/uninstall operations are idempotent — multiple concurrent
 * sparkflow chats writing identical content is safe (last write wins,
 * and cleanup removes the marker section without clobbering other content).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MARKER_START = "# managed-by: sparkflow — do not edit between markers\n";
const MARKER_END = "# end sparkflow managed block\n";

// ---------------------------------------------------------------------------
// TOML block helpers
// ---------------------------------------------------------------------------

/**
 * Insert or replace the sparkflow MCP block (between markers) in a TOML
 * config string. Returns the modified string.
 */
function upsertTomlBlock(existing: string, block: string): string {
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  const markedBlock = MARKER_START + block + MARKER_END;

  if (start !== -1 && end !== -1 && end > start) {
    // Replace existing block.
    return existing.slice(0, start) + markedBlock + existing.slice(end + MARKER_END.length);
  }
  // Append.
  const sep = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
  return existing + sep + markedBlock;
}

/**
 * Remove the sparkflow MCP block (between markers) from a TOML config string.
 * Returns the modified string (original if markers not found).
 */
function removeTomlBlock(existing: string): string {
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end <= start) return existing;
  return existing.slice(0, start) + existing.slice(end + MARKER_END.length);
}

// ---------------------------------------------------------------------------
// ~/.codex/config.toml MCP wiring
// ---------------------------------------------------------------------------

const CODEX_CONFIG_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_CONFIG_DIR, "config.toml");

function buildMcpTomlBlock(mcpServerPath: string, ipcSocketPath: string): string {
  return [
    `[mcp_servers.sparkflow]`,
    `command = "node"`,
    `args = [${JSON.stringify(mcpServerPath)}]`,
    ``,
    `[mcp_servers.sparkflow.env]`,
    `SPARKFLOW_DASHBOARD_SOCKET = ${JSON.stringify(ipcSocketPath)}`,
    ``,
  ].join("\n");
}

/**
 * Install the sparkflow MCP entry into ~/.codex/config.toml.
 * Creates the directory and file if they don't exist.
 * Returns false (with a warning logged) if the file is unwritable.
 */
export function installCodexMcp(
  mcpServerPath: string,
  ipcSocketPath: string,
  warn: (msg: string) => void = console.warn
): boolean {
  try {
    mkdirSync(CODEX_CONFIG_DIR, { recursive: true });
    const existing = existsSync(CODEX_CONFIG_PATH)
      ? readFileSync(CODEX_CONFIG_PATH, "utf-8")
      : "";
    const block = buildMcpTomlBlock(mcpServerPath, ipcSocketPath);
    const updated = upsertTomlBlock(existing, block);
    writeFileSync(CODEX_CONFIG_PATH, updated);
    return true;
  } catch (err) {
    warn(`[codex-chat] could not write ${CODEX_CONFIG_PATH}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Remove the sparkflow MCP entry from ~/.codex/config.toml.
 * Leaves the file unchanged (with a warning) if it cannot be read or written.
 */
export function uninstallCodexMcp(
  warn: (msg: string) => void = console.warn
): void {
  if (!existsSync(CODEX_CONFIG_PATH)) return;
  try {
    const existing = readFileSync(CODEX_CONFIG_PATH, "utf-8");
    const updated = removeTomlBlock(existing);
    writeFileSync(CODEX_CONFIG_PATH, updated);
  } catch (err) {
    warn(`[codex-chat] could not update ${CODEX_CONFIG_PATH}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md system prompt injection
// ---------------------------------------------------------------------------

const AGENTS_MARKER_START = "<!-- sparkflow context start -->\n";
const AGENTS_MARKER_END = "<!-- sparkflow context end -->\n";

function upsertAgentsBlock(existing: string, content: string): string {
  const block = AGENTS_MARKER_START + content + AGENTS_MARKER_END;
  const start = existing.indexOf(AGENTS_MARKER_START);
  const end = existing.indexOf(AGENTS_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + AGENTS_MARKER_END.length);
  }
  const sep = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
  return existing + sep + block;
}

function removeAgentsBlock(existing: string): string {
  const start = existing.indexOf(AGENTS_MARKER_START);
  const end = existing.indexOf(AGENTS_MARKER_END);
  if (start === -1 || end === -1 || end <= start) return existing;
  return existing.slice(0, start) + existing.slice(end + AGENTS_MARKER_END.length);
}

/**
 * Inject the sparkflow system prompt into AGENTS.md in the given cwd.
 */
export function installCodexSystemPrompt(
  cwd: string,
  systemPromptText: string,
  warn: (msg: string) => void = console.warn
): void {
  const agentsPath = join(cwd, "AGENTS.md");
  try {
    const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf-8") : "";
    const updated = upsertAgentsBlock(existing, systemPromptText + "\n");
    writeFileSync(agentsPath, updated);
  } catch (err) {
    warn(`[codex-chat] could not write ${agentsPath}: ${(err as Error).message}`);
  }
}

/**
 * Remove the sparkflow context block from AGENTS.md in the given cwd.
 */
export function uninstallCodexSystemPrompt(
  cwd: string,
  warn: (msg: string) => void = console.warn
): void {
  const agentsPath = join(cwd, "AGENTS.md");
  if (!existsSync(agentsPath)) return;
  try {
    const existing = readFileSync(agentsPath, "utf-8");
    const updated = removeAgentsBlock(existing);
    // If the file would be empty after removal, leave it rather than creating a zero-byte file.
    if (updated.trim()) {
      writeFileSync(agentsPath, updated);
    } else {
      unlinkSync(agentsPath);
    }
  } catch (err) {
    warn(`[codex-chat] could not update ${agentsPath}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// ~/.codex/prompts/sf-*.md slash commands
// ---------------------------------------------------------------------------

const CODEX_PROMPTS_DIR = join(CODEX_CONFIG_DIR, "prompts");

/**
 * Install sparkflow slash commands as sf-*.md files in ~/.codex/prompts/.
 * Prefixed with "sf-" so the cleanup pass can find them unambiguously.
 * Returns a list of installed file paths.
 */
export function installCodexPrompts(
  slashCommands: Record<string, { body: string; description?: string }>,
  warn: (msg: string) => void = console.warn
): string[] {
  if (Object.keys(slashCommands).length === 0) return [];
  try {
    mkdirSync(CODEX_PROMPTS_DIR, { recursive: true });
  } catch (err) {
    warn(`[codex-chat] could not create ${CODEX_PROMPTS_DIR}: ${(err as Error).message}`);
    return [];
  }
  const installed: string[] = [];
  for (const [name, spec] of Object.entries(slashCommands)) {
    const safeName = name.startsWith("sf-") ? name : `sf-${name}`;
    const filePath = join(CODEX_PROMPTS_DIR, `${safeName}.md`);
    try {
      writeFileSync(filePath, spec.body);
      installed.push(filePath);
    } catch (err) {
      warn(`[codex-chat] could not write ${filePath}: ${(err as Error).message}`);
    }
  }
  return installed;
}

/**
 * Remove all sf-*.md files from ~/.codex/prompts/ (sparkflow-managed prompts).
 */
export function uninstallCodexPrompts(
  warn: (msg: string) => void = console.warn
): void {
  if (!existsSync(CODEX_PROMPTS_DIR)) return;
  let entries: string[];
  try {
    entries = readdirSync(CODEX_PROMPTS_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("sf-") || !entry.endsWith(".md")) continue;
    try {
      unlinkSync(join(CODEX_PROMPTS_DIR, entry));
    } catch (err) {
      warn(`[codex-chat] could not remove ${entry}: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Build spawn args for the interactive codex chat TUI
// ---------------------------------------------------------------------------

export interface BuildCodexSpawnResult {
  cmd: string;
  args: string[];
  shellCmd: string;
  cleanup: () => void;
}

function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface BuildCodexSpawnOpts {
  /** Resolved binary path (defaults to "codex"). */
  command: string;
  /** Extra args from user (--chat-args). */
  chatArgs: string[];
  /** Path to compiled MCP server JS. */
  mcpServerPath: string;
  /** Sparkflow IPC socket path. */
  ipcSocketPath: string;
  /** System prompt text to inject. */
  systemPromptText: string;
  /** Working directory (for AGENTS.md). */
  cwd: string;
  /** Custom slash commands. */
  slashCommands: Record<string, { body: string; description?: string }>;
  /** Warning logger. */
  warn?: (msg: string) => void;
}

/**
 * Build the spawn arguments for the interactive codex chat TUI and install
 * sparkflow's config/prompt files. Returns cleanup() to call on chat exit.
 */
export function buildCodexSpawn(opts: BuildCodexSpawnOpts): BuildCodexSpawnResult {
  const warn = opts.warn ?? console.warn;

  installCodexMcp(opts.mcpServerPath, opts.ipcSocketPath, warn);
  installCodexSystemPrompt(opts.cwd, opts.systemPromptText, warn);
  const installedPrompts = installCodexPrompts(opts.slashCommands, warn);

  const yoloFlag = opts.command === "codex" ? ["--dangerously-bypass-approvals-and-sandbox"] : [];
  const args = [...yoloFlag, ...opts.chatArgs];
  const shellCmd = [sq(opts.command), ...args.map(sq)].join(" ");

  const cleanup = (): void => {
    uninstallCodexMcp(warn);
    uninstallCodexSystemPrompt(opts.cwd, warn);
    for (const f of installedPrompts) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  };

  return { cmd: opts.command, args, shellCmd, cleanup };
}

/**
 * Build a bare codex spawn (no MCP, no system prompt, no slash commands).
 * Used for side-chat instances.
 */
export function buildBareCodexSpawn(opts: {
  command: string;
  chatArgs: string[];
}): BuildCodexSpawnResult {
  const args = [...opts.chatArgs];
  const shellCmd = [sq(opts.command), ...args.map(sq)].join(" ");
  return { cmd: opts.command, args, shellCmd, cleanup: () => {} };
}
