#!/usr/bin/env node

import { resolve } from "node:path";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, mkdirSync, existsSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadProjectConfig, resolveWorkflowPath } from "../config/project-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_BRIDGE_PATH = resolve(__dirname, "mcp-bridge.js");
const STATUS_DISPLAY_PATH = resolve(__dirname, "status-display.js");
const SUPERVISOR_PATH = resolve(__dirname, "supervisor.js");
const WEB_ENTRY_PATH = resolve(__dirname, "..", "web", "index.js");

function defaultSystemPrompt(mode: "tmux" | "web"): string {
  const surface = mode === "web"
    ? "the status panel below the chat in your browser"
    : "the bottom tmux pane";
  return `You are running inside the sparkflow dashboard. ${cap(surface)} shows live status for all running workflow jobs.

You have MCP tools from the sparkflow-dashboard server to manage workflow jobs:
- start_workflow: Start a sparkflow-run job from a workflow JSON file. Returns a job ID.
- list_jobs: List all jobs with current status (state, step, elapsed time).
- get_job_detail: Get the full output log from a specific job.
- answer_job_recovery: Resolve a job paused in failed_waiting state. Pass action=retry|skip|abort and an optional message.

The user has slash commands:
- /project:sf-plan — Enter planning mode. Help the user think through what they want to build. Produce a project plan for workflow agents to execute.
- /project:sf-dispatch <workflow_path> — Write the plan to disk and start the specified workflow with it via --plan.
- /sf-detail <job_id> — Show output from a job and diagnose failures (MCP prompt).
- /sf-recover <job_id> — Diagnose a failed_waiting job, work with the user on a fix, then resolve it.
- /sf-jobs — Quick summary of all running jobs (MCP prompt).

If a job becomes blocked (needs user input), it will show in ${surface}. The user will handle blocked jobs directly.

**IMPORTANT — failed jobs:** When a job enters \`FAILED_WAITING\` state in ${surface}, the workflow has paused because a step opted in (via \`ask_on_failure\`) to ask for help rather than abort. Proactively run \`/sf-recover <job_id>\` without being asked. Work with the user to understand what went wrong and craft a concrete correction, then call \`answer_job_recovery\`. For a retry of a claude-code step, the agent's conversation resumes with your correction message — phrase it as a direct instruction. Jobs that simply fail (state \`FAILED\`) did not opt in; don't try to recover them.

Call \`sparkflow_capabilities\` for the full command/tool reference whenever you're unsure what sparkflow can do, and \`sparkflow_version\` to confirm which build is running.

If a tool response starts with \`[sparkflow reloaded — documentation updates follow]\`, sparkflow's daemon restarted under hot-reload and the diff that follows shows what changed in the documentation. Read the diff and incorporate any capability changes before continuing.`;
}
function cap(s: string): string { return s[0].toUpperCase() + s.slice(1); }

function usage(): never {
  console.log(`Usage: sparkflow [options]

Options:
  --chat-command <cmd>   Chat tool command (default: "claude")
  --chat-args <args>     Extra args for chat tool (comma-separated)
  --cwd <dir>            Working directory (default: current directory)
  --workflow <path>      Default workflow for /project:sf-dispatch (default: none)
  --status-lines <n>     Height of status pane in lines (default: 5; tmux only)
  --dev                  Hot-reload: run status daemon under a supervisor that
                         watches dist/ and respawns on change (run tsc --watch
                         separately). In-flight jobs survive reloads. Tmux only.
  --web                  Start the web UI alternative (browser-based dashboard,
                         single shared token printed at startup) instead of the
                         tmux dashboard.
  --port <n>             Port for the web UI (default: ephemeral). Requires --web.`);
  process.exit(0);
}

function parseArgs(argv: string[]): {
  chatCommand: string;
  chatArgs: string[];
  cwd: string;
  workflow: string | null;
  statusLines: number;
  dev: boolean;
  web: boolean;
  port: number;
} {
  let chatCommand = "claude";
  let chatArgs: string[] = [];
  let cwd = process.cwd();
  let workflow: string | null = null;
  let statusLines = 5;
  let dev = process.env.SPARKFLOW_DEV === "1";
  let web = false;
  let port = 0;
  let portSet = false;
  let statusLinesSet = false;

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
        statusLinesSet = true;
        break;
      case "--dev":
        dev = true;
        break;
      case "--web":
        web = true;
        break;
      case "--port": {
        const raw = argv[++i];
        const n = parseInt(raw ?? "", 10);
        if (Number.isNaN(n) || n < 0 || n > 65535) {
          console.error(`Error: --port requires a number 0-65535, got: ${raw}`);
          process.exit(1);
        }
        port = n;
        portSet = true;
        break;
      }
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }

  // Mutual-exclusion checks.
  if (portSet && !web) {
    console.error("Error: --port requires --web");
    process.exit(1);
  }
  if (web && statusLinesSet) {
    console.error("Error: --status-lines is tmux-only; not valid with --web");
    process.exit(1);
  }
  // --web + --dev: the web supervisor watches dist/ and respawns the server
  // child on change while keeping the claude PTY alive. Handled via env var
  // at spawn-time below.

  return { chatCommand, chatArgs, cwd, workflow, statusLines, dev, web, port };
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

// Resolve workflow via .sparkflow/config.json when not provided on CLI,
// and accept bare names as .sparkflow/workflows/<name>.json.
let resolvedWorkflowPath: string | null = null;
try {
  const projectConfig = loadProjectConfig(args.cwd);
  const candidate = args.workflow ?? projectConfig.defaultWorkflow;
  if (candidate) {
    resolvedWorkflowPath = resolveWorkflowPath(candidate, args.cwd, projectConfig);
  }
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}

if (resolvedWorkflowPath) {
  const workflowPath = resolvedWorkflowPath;
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
  args.workflow = workflowPath;
}

if (!args.web) checkTmux();

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
        SPARKFLOW_CWD: args.cwd,
        ...(args.dev ? { SPARKFLOW_DEV: "1" } : {}),
      },
    },
  },
};
writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

// 3. Write system prompt to temp file (avoids shell quoting issues with newlines)
const systemPromptPath = join(tmpDir, "system-prompt.txt");
const systemPromptText = defaultSystemPrompt(args.web ? "web" : "tmux");
writeFileSync(systemPromptPath, systemPromptText);

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
1. Call the start_workflow MCP tool with:
   - workflow_path set to the workflow path above,
   - plan_text set to the full plan markdown we developed (not a file path — the tool writes it to .sparkflow/logs/ automatically),
   - slug set to a 3-words-or-less label summarizing the plan's goal (e.g. "add user auth", "fix login bug", "refactor pdf export"). Use lowercase, no punctuation.
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

// sf-quit needs the session name; web mode has no tmux session to kill — skip it.
if (!args.web) {
  SLASH_COMMANDS["sf-quit"] = `Shut down the sparkflow dashboard session.

Run this command:
\`\`\`
tmux kill-session -t '${sessionName}'
\`\`\`

This will terminate all running jobs and close the dashboard.`;
}

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
  if (args.web) {
    // Web mode: spawn the web server directly, passing the chat command + its
    // args so the server can exec it under a PTY. No shell, so we pass the
    // system prompt text as a literal arg rather than via $(cat …).
    const chatToolArgs = [
      ...args.chatArgs,
      "--mcp-config", mcpConfigPath,
      "--append-system-prompt", systemPromptText,
    ];
    const webEnv = args.dev
      ? { ...process.env, SPARKFLOW_WEB_DEV: "1" }
      : (process.env as Record<string, string>);
    const result = spawnSync(
      process.execPath,
      [
        WEB_ENTRY_PATH,
        socketPath,
        args.cwd,
        String(args.port),
        args.chatCommand,
        ...chatToolArgs,
      ],
      { cwd: args.cwd, stdio: "inherit", env: webEnv },
    );
    process.exitCode = result.status ?? 0;
  } else {
    // Tmux mode (existing flow).
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
  }
} finally {
  // Cleanup: kill tmux sessions if any, remove temp files
  if (!args.web) {
    try {
      execFileSync("tmux", ["kill-session", "-t", attachName], { stdio: "pipe" });
    } catch { /* already dead */ }
    try {
      execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "pipe" });
    } catch { /* already dead */ }
  }
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
