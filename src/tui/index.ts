#!/usr/bin/env node

import { resolve } from "node:path";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_BRIDGE_PATH = resolve(__dirname, "mcp-bridge.js");
const STATUS_DISPLAY_PATH = resolve(__dirname, "status-display.js");

const DEFAULT_SYSTEM_PROMPT = `You are running inside the sparkflow dashboard. The bottom tmux pane shows live status for all running workflow jobs.

You have MCP tools from the sparkflow-dashboard server to manage workflow jobs:
- start_workflow: Start a sparkflow-run job from a workflow JSON file. Returns a job ID.
- list_jobs: List all jobs with current status (state, step, elapsed time).
- get_job_detail: Get the full output log from a specific job.

The user has slash commands:
- /sf-plan — Enter planning mode. Help the user think through what they want to build: goals, scope, approach, files to change, edge cases, verification. Produce a clear project plan that workflow agents can execute autonomously.
- /sf-dispatch <workflow_path> — Write the plan from this conversation to a file and start the specified workflow with it. The workflow already exists — the plan is passed via --plan.
- /sf-detail <job_id> — Show output from a job and diagnose failures.
- /sf-jobs — Quick summary of all running jobs.

If a job becomes blocked (needs user input), it will show in the status pane at the bottom of the terminal. The user will handle blocked jobs directly.`;

function usage(): never {
  console.log(`Usage: sparkflow [options]

Options:
  --chat-command <cmd>   Chat tool command (default: "claude")
  --chat-args <args>     Extra args for chat tool (comma-separated)
  --cwd <dir>            Working directory (default: current directory)
  --status-lines <n>     Height of status pane in lines (default: 5)`);
  process.exit(0);
}

function parseArgs(argv: string[]): {
  chatCommand: string;
  chatArgs: string[];
  cwd: string;
  statusLines: number;
} {
  let chatCommand = "claude";
  let chatArgs: string[] = [];
  let cwd = process.cwd();
  let statusLines = 5;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--help":
      case "-h":
        usage();
        break;
      case "--chat-command":
        chatCommand = argv[++i];
        if (!chatCommand) {
          console.error("Error: --chat-command requires a value");
          process.exit(1);
        }
        break;
      case "--chat-args":
        chatArgs = (argv[++i] ?? "").split(",").filter(Boolean);
        break;
      case "--cwd":
        cwd = resolve(argv[++i] ?? ".");
        break;
      case "--status-lines":
        statusLines = parseInt(argv[++i] ?? "5", 10);
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }

  return { chatCommand, chatArgs, cwd, statusLines };
}

function checkTmux(): void {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe" });
  } catch {
    console.error("Error: tmux is required but not found on PATH");
    process.exit(1);
  }
}

const args = parseArgs(process.argv.slice(2));

checkTmux();

// 1. Create temp dir for IPC socket and MCP config
const tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-dashboard-"));
const socketPath = join(tmpDir, `sparkflow-${randomBytes(4).toString("hex")}.sock`);
const mcpConfigPath = join(tmpDir, "mcp-config.json");

// 2. Write MCP config pointing to the bridge
const mcpConfig = {
  mcpServers: {
    "sparkflow-dashboard": {
      command: "node",
      args: [MCP_BRIDGE_PATH],
      env: {
        SPARKFLOW_DASHBOARD_SOCKET: socketPath,
      },
    },
  },
};
writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

// 3. Write system prompt to temp file (avoids shell quoting issues with newlines)
const systemPromptPath = join(tmpDir, "system-prompt.txt");
writeFileSync(systemPromptPath, DEFAULT_SYSTEM_PROMPT);

// Shell-escape a single argument
const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

// 4. Build chat command — use $(cat ...) for the system prompt to avoid quoting newlines
const chatCmdParts = [
  sq(args.chatCommand),
  ...args.chatArgs.map(sq),
  "--mcp-config", sq(mcpConfigPath),
  "--append-system-prompt", `"$(cat ${sq(systemPromptPath)})"`,
];
const chatCmd = chatCmdParts.join(" ");

// 5. Build status display command (session name added after it's generated below)
const buildStatusCmd = (session: string) =>
  `exec ${sq(process.execPath)} ${sq(STATUS_DISPLAY_PATH)} ${sq(socketPath)} ${sq(args.cwd)} ${sq(session)}`;

// 6. Create tmux session with two panes
const sessionName = `sparkflow-${randomBytes(4).toString("hex")}`;
const attachName = `${sessionName}-attach`;

// Get terminal dimensions before we lose the TTY
const cols = process.stdout.columns || 80;
const rows = process.stdout.rows || 24;

try {
  // Create and attach to session in one shot.
  // tmux new-session without -d attaches immediately and blocks.
  // The chat command runs in the initial pane.
  // We use a hook to split the status pane once the session is ready.

  // Create session detached, split, then attach
  execFileSync("tmux", [
    "new-session", "-d",
    "-s", sessionName,
    "-x", String(cols),
    "-y", String(rows),
    "sh", "-c", chatCmd,
  ], { cwd: args.cwd, stdio: "pipe" });

  // Split horizontally to create status pane (bottom)
  execFileSync("tmux", [
    "split-window", "-v",
    "-t", sessionName,
    "-l", String(args.statusLines),
    "sh", "-c", buildStatusCmd(sessionName),
  ], { cwd: args.cwd, stdio: "pipe" });

  // Focus the top pane (chat)
  execFileSync("tmux", ["select-pane", "-t", `${sessionName}:.0`], { stdio: "pipe" });

  // Attach by creating a grouped session that shares the same windows.
  // This works both inside and outside tmux. The grouped session is
  // destroyed when we detach/exit, but the original session persists
  // until its processes end (handled by cleanup in finally block).
  const result = spawnSync("tmux", [
    "new-session", "-s", attachName, "-t", sessionName,
  ], {
    stdio: "inherit",
  });

  process.exitCode = result.status ?? 0;
} finally {
  // Cleanup: kill session if still alive, remove temp files
  try {
    execFileSync("tmux", ["kill-session", "-t", attachName], { stdio: "pipe" });
  } catch { /* already dead */ }
  try {
    execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "pipe" });
  } catch { /* already dead */ }
  try { unlinkSync(mcpConfigPath); } catch { /* ignore */ }
  try { unlinkSync(systemPromptPath); } catch { /* ignore */ }
  try { unlinkSync(socketPath); } catch { /* ignore */ }
}
