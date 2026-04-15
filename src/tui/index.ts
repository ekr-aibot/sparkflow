#!/usr/bin/env node

import { resolve } from "node:path";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, mkdirSync, existsSync, rmdirSync } from "node:fs";
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
const SUPERVISOR_PATH = resolve(__dirname, "supervisor.js");

const DEFAULT_SYSTEM_PROMPT = `You are running inside the sparkflow dashboard. The bottom tmux pane shows live status for all running workflow jobs.

You have MCP tools from the sparkflow-dashboard server to manage workflow jobs:
- start_workflow: Start a sparkflow-run job from a workflow JSON file. Returns a job ID.
- list_jobs: List all jobs with current status (state, step, elapsed time).
- get_job_detail: Get the full output log from a specific job.

The user has slash commands:
- /project:sf-plan — Enter planning mode. Help the user think through what they want to build. Produce a project plan for workflow agents to execute.
- /project:sf-dispatch <workflow_path> — Write the plan to disk and start the specified workflow with it via --plan.
- /sf-detail <job_id> — Show output from a job and diagnose failures (MCP prompt).
- /sf-jobs — Quick summary of all running jobs (MCP prompt).

If a job becomes blocked (needs user input), it will show in the status pane at the bottom of the terminal. The user will handle blocked jobs directly.`;

function usage(): never {
  console.log(`Usage: sparkflow [options]

Options:
  --chat-command <cmd>   Chat tool command (default: "claude")
  --chat-args <args>     Extra args for chat tool (comma-separated)
  --cwd <dir>            Working directory (default: current directory)
  --workflow <path>      Default workflow for /project:sf-dispatch (default: none)
  --status-lines <n>     Height of status pane in lines (default: 5)
  --dev                  Hot-reload: run status daemon under a supervisor that
                         watches dist/ and respawns on change (run tsc --watch
                         separately). In-flight jobs survive reloads.`);
  process.exit(0);
}

function parseArgs(argv: string[]): {
  chatCommand: string;
  chatArgs: string[];
  cwd: string;
  workflow: string | null;
  statusLines: number;
  dev: boolean;
} {
  let chatCommand = "claude";
  let chatArgs: string[] = [];
  let cwd = process.cwd();
  let workflow: string | null = null;
  let statusLines = 5;
  let dev = process.env.SPARKFLOW_DEV === "1";

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
      case "--workflow":
        workflow = argv[++i];
        if (!workflow) {
          console.error("Error: --workflow requires a value");
          process.exit(1);
        }
        break;
      case "--status-lines":
        statusLines = parseInt(argv[++i] ?? "5", 10);
        break;
      case "--dev":
        dev = true;
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }

  return { chatCommand, chatArgs, cwd, workflow, statusLines, dev };
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

// Validate --workflow if provided
if (args.workflow) {
  const workflowPath = resolve(args.cwd, args.workflow);
  if (!existsSync(workflowPath)) {
    console.error(`Error: workflow file not found: ${workflowPath}`);
    process.exit(1);
  }
  try {
    const content = readFileSync(workflowPath, "utf-8");
    const data = JSON.parse(content);
    const { validate } = await import("../schema/validate.js");
    const result = validate(data);
    if (!result.valid) {
      console.error(`Error: workflow validation failed: ${workflowPath}`);
      for (const err of result.errors) {
        console.error(`  ${err.message}${err.path ? ` (at ${err.path})` : ""}`);
      }
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`Error: invalid JSON in workflow file: ${workflowPath}`);
      process.exit(1);
    }
    throw err;
  }
}

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

// 4. Inject slash commands into .claude/commands/ in the working directory
const SLASH_COMMANDS: Record<string, string> = {
  "sf-plan": `I want to build a plan for a task. Read my description below, then:

1. If anything is unclear or ambiguous, ask me your questions **all at once** in a single message. Wait for my answers before proceeding.
2. Once you have enough information, produce a complete project plan and stop. Do not ask what to do next or offer to help further — just present the plan.

The plan will be passed to workflow agents as their instructions, so it must be specific enough for them to execute autonomously. Structure the plan with these sections:

- **Goal**: What are we building and why?
- **Scope**: What's in and what's out?
- **Approach**: Key design decisions, architecture, patterns.
- **Files**: What needs to be created or modified?
- **Details**: Edge cases, error handling, testing strategy.
- **Verification**: How do we know it's done?

Keep the plan concrete — name specific files, functions, and types. When I'm happy with it, I'll run /project:sf-dispatch myself.

Here's what I want to build:
$ARGUMENTS`,

};

// sf-dispatch is built dynamically based on --workflow flag
const defaultWorkflowNote = args.workflow
  ? `The default workflow is: ${resolve(args.cwd, args.workflow)}
If the user provides an argument, use that instead: $ARGUMENTS`
  : `The workflow to run: $ARGUMENTS`;

SLASH_COMMANDS["sf-dispatch"] = `Dispatch the plan we just built to a sparkflow workflow.

${defaultWorkflowNote}

Do the following:
1. Call the start_workflow MCP tool with workflow_path set to the workflow path above, and plan_text set to the full plan markdown we developed (not a file path — the tool writes it to .sparkflow/logs/ automatically).
2. Report back the job ID.

The status pane at the bottom of the terminal will show live progress. Use /project:sf-jobs to check on it.`;

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

// 5. Build status display command (session name added after it's generated below).
// In --dev mode we route through the supervisor so code changes under dist/ auto-reload.
const statusEntry = args.dev ? SUPERVISOR_PATH : STATUS_DISPLAY_PATH;
const buildStatusCmd = (session: string) =>
  `exec ${sq(process.execPath)} ${sq(statusEntry)} ${sq(socketPath)} ${sq(args.cwd)} ${sq(session)}`;

// 6. Create tmux session with two panes
const sessionName = `sparkflow-${randomBytes(4).toString("hex")}`;
const attachName = `${sessionName}-attach`;

// sf-quit needs the session name
SLASH_COMMANDS["sf-quit"] = `Shut down the sparkflow dashboard session.

Run this command:
\`\`\`
tmux kill-session -t '${sessionName}'
\`\`\`

This will terminate all running jobs and close the dashboard.`;

// Write slash command files to .claude/commands/
const commandsDir = join(args.cwd, ".claude", "commands");
const createdCommandsDir = !existsSync(commandsDir);
const commandFiles: string[] = [];

mkdirSync(commandsDir, { recursive: true });
for (const [name, content] of Object.entries(SLASH_COMMANDS)) {
  const filePath = join(commandsDir, `${name}.md`);
  writeFileSync(filePath, content);
  commandFiles.push(filePath);
}

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
  // Remove injected slash command files
  for (const f of commandFiles) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
  // Remove commands dir if we created it and it's now empty
  if (createdCommandsDir) {
    try { rmdirSync(commandsDir); } catch { /* ignore — not empty or already gone */ }
  }
}
