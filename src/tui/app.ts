import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { IpcServer, type IpcMessage } from "../mcp/ipc.js";
import { PtyPane } from "./pty-pane.js";
import { StatusPane } from "./status-pane.js";
import { JobManager } from "./job-manager.js";
import { TerminalWriter } from "./terminal-writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_BRIDGE_PATH = resolve(__dirname, "mcp-bridge.js");

const STATUS_MIN_HEIGHT = 2; // header + at least 1 job line
const STATUS_DEFAULT_LINES = 5; // header + 4 job lines

const DEFAULT_SYSTEM_PROMPT = `You are running inside the sparkflow dashboard. The bottom pane of the terminal shows live status for all running workflow jobs.

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

export interface AppOptions {
  chatCommand: string;
  chatArgs: string[];
  cwd: string;
}

export class App {
  private ptyPane: PtyPane | null = null;
  private statusPane: StatusPane;
  private jobManager: JobManager;
  private ipcServer: IpcServer;
  private options: AppOptions;
  private tempFiles: string[] = [];
  private running = false;
  private statusHeight = STATUS_DEFAULT_LINES;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private writer: TerminalWriter;
  private gotCtrlX = false;

  constructor(options: AppOptions) {
    this.options = options;
    this.writer = new TerminalWriter();
    this.statusPane = new StatusPane();
    this.statusPane.setWriter(this.writer);
    this.jobManager = new JobManager();
    this.ipcServer = new IpcServer();
  }

  async start(): Promise<void> {
    this.running = true;

    // 1. Set up IPC server for MCP bridge communication
    this.ipcServer.onRequest(async (msg: IpcMessage) => {
      return this.handleIpcRequest(msg);
    });
    await this.ipcServer.listen();

    // 2. Create temp MCP config for the chat tool
    const tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-dashboard-"));
    const mcpConfigPath = join(tmpDir, "mcp-config.json");
    this.tempFiles.push(mcpConfigPath);

    const mcpConfig = {
      mcpServers: {
        "sparkflow-dashboard": {
          command: "node",
          args: [MCP_BRIDGE_PATH],
          env: {
            SPARKFLOW_DASHBOARD_SOCKET: this.ipcServer.path,
          },
        },
      },
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

    // 3. Enter alternate screen, set up terminal
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    process.stdout.write("\x1b[?1049h"); // alternate screen
    process.stdout.write("\x1b[H\x1b[2J"); // clear

    // 4. Calculate layout
    const topRows = rows - this.statusHeight;

    // 5. Set scroll region for top pane
    process.stdout.write(`\x1b[1;${topRows}r`);
    process.stdout.write("\x1b[H"); // cursor to top

    // 6. Configure status pane
    this.statusPane.setDimensions(cols, rows);
    this.statusPane.setHeight(this.statusHeight);

    // 7. Spawn PTY with chat command + MCP config + system prompt
    const chatArgs = [
      ...this.options.chatArgs,
      "--mcp-config", mcpConfigPath,
      "--append-system-prompt", DEFAULT_SYSTEM_PROMPT,
    ];
    this.ptyPane = new PtyPane(this.options.chatCommand, chatArgs, {
      cwd: this.options.cwd,
      cols,
      rows: topRows,
    });

    // 8. PTY output → writer (serialized with status pane renders)
    this.ptyPane.onData((data) => {
      this.writer.write(data);
    });

    // 9. PTY exit → shutdown
    this.ptyPane.onExit(() => {
      this.shutdown();
    });

    // 10. stdin → PTY (raw mode), with C-x C-c to quit
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      const buf = Buffer.from(data);

      // C-x C-c: two-chord exit (like emacs)
      // C-x = 0x18, C-c = 0x03
      if (buf.length === 1 && buf[0] === 0x18) {
        this.gotCtrlX = true;
        return; // swallow C-x, wait for next key
      }
      if (this.gotCtrlX) {
        this.gotCtrlX = false;
        if (buf.length === 1 && buf[0] === 0x03) {
          this.shutdown();
          return;
        }
        // Not C-c after C-x — forward both the original C-x and this key
        if (this.ptyPane) {
          this.ptyPane.write("\x18");
          this.ptyPane.write(data.toString());
        }
        return;
      }

      if (this.ptyPane) {
        this.ptyPane.write(data.toString());
      }
    });

    // 11. Job status updates → re-render status pane
    this.jobManager.onUpdate(() => {
      this.updateStatusHeight();
      this.statusPane.render(this.jobManager.getJobs());
    });

    // 12. Periodic re-render for elapsed time updates
    this.statusTimer = setInterval(() => {
      const jobs = this.jobManager.getJobs();
      if (jobs.length > 0) {
        this.statusPane.render(jobs);
      }
    }, 1000);

    // 13. Handle resize
    process.stdout.on("resize", () => {
      this.handleResize();
    });

    // 14. Handle signals
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => {
      // Forward Ctrl+C to PTY instead of handling it ourselves
      // (the PTY process should handle it)
    });

    // Initial status render
    this.statusPane.render([]);
  }

  private handleIpcRequest(msg: IpcMessage): Promise<IpcMessage> {
    const response = (payload: Record<string, unknown>): IpcMessage => ({
      type: "response",
      id: msg.id,
      payload,
    });

    const errorResponse = (error: string): IpcMessage => ({
      type: "error",
      id: msg.id,
      payload: { error },
    });

    switch (msg.type) {
      case "start_workflow": {
        const { workflowPath, cwd, plan } = msg.payload as {
          workflowPath: string;
          cwd?: string;
          plan?: string;
        };
        const jobId = this.jobManager.startJob(workflowPath, {
          cwd: cwd ?? this.options.cwd,
          plan,
        });
        return Promise.resolve(response({ jobId }));
      }

      case "list_jobs": {
        const jobs = this.jobManager.getJobs();
        return Promise.resolve(response({ jobs }));
      }

      case "get_job_detail": {
        const { jobId } = msg.payload as { jobId: string };
        const detail = this.jobManager.getJobDetail(jobId);
        if (!detail) {
          return Promise.resolve(errorResponse(`Job not found: ${jobId}`));
        }
        return Promise.resolve(response(detail as unknown as Record<string, unknown>));
      }

      case "answer_question": {
        const { jobId, answer } = msg.payload as { jobId: string; answer: string };
        const ok = this.jobManager.answerQuestion(jobId, answer);
        if (!ok) {
          return Promise.resolve(errorResponse(`No pending question for job: ${jobId}`));
        }
        return Promise.resolve(response({}));
      }

      default:
        return Promise.resolve(errorResponse(`Unknown message type: ${msg.type}`));
    }
  }

  private updateStatusHeight(): void {
    const jobs = this.jobManager.getJobs();
    const needed = Math.max(STATUS_MIN_HEIGHT, jobs.length + 1); // +1 for header
    const maxHeight = Math.floor((process.stdout.rows || 24) / 3);
    const newHeight = Math.min(needed, maxHeight, STATUS_DEFAULT_LINES);

    if (newHeight !== this.statusHeight) {
      this.statusHeight = newHeight;
      this.handleResize();
    }
  }

  private handleResize(): void {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const topRows = rows - this.statusHeight;

    // Update scroll region
    process.stdout.write(`\x1b[1;${topRows}r`);

    // Resize PTY
    if (this.ptyPane) {
      this.ptyPane.resize(cols, topRows);
    }

    // Update status pane dimensions
    this.statusPane.setDimensions(cols, rows);
    this.statusPane.setHeight(this.statusHeight);
    this.statusPane.render(this.jobManager.getJobs());
  }

  private shutdown(): void {
    if (!this.running) return;
    this.running = false;

    // Clear timer
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }

    // Kill all job children
    this.jobManager.killAll();

    // Close IPC server
    this.ipcServer.close().catch(() => {});

    // Kill PTY if still running
    if (this.ptyPane) {
      try {
        this.ptyPane.kill();
      } catch {
        // ignore
      }
    }

    // Restore terminal
    process.stdout.write("\x1b[r");       // reset scroll region
    process.stdout.write("\x1b[?1049l");  // exit alternate screen

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    // Cleanup temp files
    for (const f of this.tempFiles) {
      try {
        unlinkSync(f);
      } catch {
        // ignore
      }
    }

    process.exit(0);
  }
}
