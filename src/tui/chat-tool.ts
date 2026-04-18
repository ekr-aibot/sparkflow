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

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ChatTool = "claude" | "gemini";

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SlashCommandSpec {
  /** Command body; may use $ARGUMENTS placeholder. */
  body: string;
  /** One-line description shown in `/help`. Optional. */
  description?: string;
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
  /** Custom slash commands to inject. */
  slashCommands: Record<string, SlashCommandSpec>;
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

function escapeTomlBasicString(s: string): string {
  return JSON.stringify(s);
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

  const commandsDir = join(opts.cwd, ".claude", "commands");
  const createdCommandsDir = !existsSync(commandsDir);
  const commandFiles: string[] = [];

  if (Object.keys(opts.slashCommands).length > 0) {
    mkdirSync(commandsDir, { recursive: true });
    for (const [name, spec] of Object.entries(opts.slashCommands)) {
      const filePath = join(commandsDir, `${name}.md`);
      writeFileSync(filePath, spec.body);
      commandFiles.push(filePath);
    }
  }

  const cleanup = (): void => {
    for (const f of commandFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    if (createdCommandsDir) {
      try { rmdirSync(commandsDir); } catch { /* ignore */ }
      try { rmdirSync(join(opts.cwd, ".claude")); } catch { /* ignore */ }
    }
  };

  return { cmd: opts.command, args, shellCmd, cleanup };
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

  const commandsDir = join(geminiDir, "commands");
  const projectDir = join(commandsDir, "project");

  // Write settings.json. If something's already there, back it up first so
  // cleanup() can restore the original.
  let createdGeminiDir = false;
  let settingsBackedUp = false;
  let contextBackedUp = false;

  if (!existsSync(geminiDir)) {
    mkdirSync(geminiDir, { recursive: true });
    createdGeminiDir = true;
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

  let createdCommandsDir = false;
  let createdProjectDir = false;
  const commandFiles: { path: string; backup?: string }[] = [];

  if (Object.keys(opts.slashCommands).length > 0) {
    if (!existsSync(commandsDir)) {
      mkdirSync(commandsDir, { recursive: true });
      createdCommandsDir = true;
    }
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
      createdProjectDir = true;
    }

    for (const [name, spec] of Object.entries(opts.slashCommands)) {
      if (spec.body.includes("'''")) {
        throw new Error(`Slash command "${name}" body cannot contain triple single-quotes (''') for TOML literal string.`);
      }
      const filePath = join(projectDir, `${name}.toml`);
      const backupPath = `${filePath}.sparkflow-backup`;
      if (existsSync(filePath)) {
        if (existsSync(backupPath)) {
          throw new Error(`Backup file already exists: ${backupPath}. Cannot safely overwrite.`);
        }
        renameSync(filePath, backupPath);
        commandFiles.push({ path: filePath, backup: backupPath });
      } else {
        commandFiles.push({ path: filePath });
      }

      const translatedBody = spec.body.replace(/\$ARGUMENTS\b/g, "{{args}}");
      const descriptionLine = spec.description ? `description = ${escapeTomlBasicString(spec.description)}\n` : "";
      const tomlContent = `${descriptionLine}prompt = '''\n${translatedBody}\n'''\n`;
      writeFileSync(filePath, tomlContent);
    }
  }

  const shellCmd = [sq(opts.command), ...args.map(sq)].join(" ");

  const cleanup = (): void => {
    try { unlinkSync(settingsPath); } catch { /* already gone */ }
    if (settingsBackedUp) {
      try { renameSync(settingsBackup, settingsPath); } catch { /* ignore */ }
    }
    try { unlinkSync(contextPath); } catch { /* already gone */ }
    if (contextBackedUp) {
      try { renameSync(contextBackup, contextPath); } catch { /* ignore */ }
    }

    for (const f of commandFiles) {
      try { unlinkSync(f.path); } catch { /* already gone */ }
      if (f.backup) {
        try { renameSync(f.backup, f.path); } catch { /* ignore */ }
      }
    }

    if (createdProjectDir) {
      try { rmdirSync(projectDir); } catch { /* ignore */ }
    }
    if (createdCommandsDir) {
      try { rmdirSync(commandsDir); } catch { /* ignore */ }
    }
    if (createdGeminiDir) {
      try { rmdirSync(geminiDir); } catch { /* non-empty or already gone */ }
    }
  };

  return { cmd: opts.command, args, shellCmd, cleanup };
}
