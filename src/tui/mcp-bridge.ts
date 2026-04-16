#!/usr/bin/env node

/**
 * Sparkflow Dashboard MCP server — spawned by the chat tool (e.g. claude) as a child.
 * Exposes tools to start workflows, list jobs, get details, and answer questions.
 * Communicates with the dashboard app via IPC over a Unix socket.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IpcClient, type IpcMessage } from "../mcp/ipc.js";
import { randomBytes } from "node:crypto";

const socketPath = process.env.SPARKFLOW_DASHBOARD_SOCKET;
if (!socketPath) {
  console.error("SPARKFLOW_DASHBOARD_SOCKET environment variable is required");
  process.exit(1);
}

const ipc = new IpcClient(socketPath);
await ipc.connect();

const server = new McpServer({
  name: "sparkflow-dashboard",
  version: "0.1.0",
});

server.tool(
  "start_workflow",
  "Start a sparkflow-run workflow job. Returns a job ID that can be used to track status.",
  {
    workflow_path: z.string().describe("Path to the workflow JSON file"),
    cwd: z.string().optional().describe("Working directory for the workflow"),
    plan: z.string().optional().describe("Path to a plan file to prepend to prompts"),
    plan_text: z.string().optional().describe("Plan text to prepend to prompts (written to a temp file automatically)"),
  },
  async ({ workflow_path, cwd, plan, plan_text }) => {
    const msg: IpcMessage = {
      type: "start_workflow",
      id: randomBytes(8).toString("hex"),
      payload: { workflowPath: workflow_path, cwd, plan, planText: plan_text },
    };
    const response = await ipc.request(msg);
    if (response.type === "error") {
      return {
        content: [{ type: "text" as const, text: `Error: ${response.payload.error}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(response.payload) }],
    };
  }
);

server.tool(
  "list_jobs",
  "List all sparkflow-run jobs with their current status, including workflow name, state, current step, and elapsed time.",
  {},
  async () => {
    const msg: IpcMessage = {
      type: "list_jobs",
      id: randomBytes(8).toString("hex"),
      payload: {},
    };
    const response = await ipc.request(msg);
    if (response.type === "error") {
      return {
        content: [{ type: "text" as const, text: `Error: ${response.payload.error}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(response.payload, null, 2) }],
    };
  }
);

server.tool(
  "get_job_detail",
  "Get detailed output from a specific sparkflow-run job, including its full log.",
  {
    job_id: z.string().describe("The job ID to get details for"),
  },
  async ({ job_id }) => {
    const msg: IpcMessage = {
      type: "get_job_detail",
      id: randomBytes(8).toString("hex"),
      payload: { jobId: job_id },
    };
    const response = await ipc.request(msg);
    if (response.type === "error") {
      return {
        content: [{ type: "text" as const, text: `Error: ${response.payload.error}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(response.payload, null, 2) }],
    };
  }
);

server.tool(
  "kill_job",
  "Terminate a running sparkflow-run job (SIGTERM). The job transitions to FAILED with summary 'killed by user'. Idempotent: calling on an already-terminal job is a no-op. Worktrees and logs are preserved for inspection.",
  {
    job_id: z.string().describe("The job ID to kill (shown in status pane or list_jobs output)"),
  },
  async ({ job_id }) => {
    const msg: IpcMessage = {
      type: "kill_job",
      id: randomBytes(8).toString("hex"),
      payload: { jobId: job_id },
    };
    const response = await ipc.request(msg);
    if (response.type === "error") {
      return {
        content: [{ type: "text" as const, text: `Error: ${response.payload.error}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: `Killed job ${job_id}.` }],
    };
  }
);

server.tool(
  "restart_job",
  "Restart a sparkflow-run job. mode='fresh' (default) re-runs the workflow from step one with the original plan and cwd; if the job is still running it is killed first. mode='resume' is reserved for future checkpoint-based resume and currently returns an error. The old job's log/worktree are preserved; a new job id is returned.",
  {
    job_id: z.string().describe("The job ID to restart"),
    mode: z.enum(["fresh", "resume"]).optional().describe("fresh (default) re-runs from scratch; resume is not yet implemented"),
  },
  async ({ job_id, mode }) => {
    const msg: IpcMessage = {
      type: "restart_job",
      id: randomBytes(8).toString("hex"),
      payload: { jobId: job_id, mode: mode ?? "fresh" },
    };
    const response = await ipc.request(msg);
    if (response.type === "error") {
      return {
        content: [{ type: "text" as const, text: `Error: ${response.payload.error}` }],
        isError: true,
      };
    }
    const newJobId = response.payload.newJobId as string;
    return {
      content: [{ type: "text" as const, text: `Restarted job ${job_id} as new job ${newJobId}.` }],
    };
  }
);

// --- MCP Prompts (for commands that need live IPC data) ---
// sf-plan and sf-dispatch are injected as Claude Code slash commands
// in .claude/commands/ by the sparkflow entry point.

server.prompt(
  "sf-detail",
  "Get detailed output from a sparkflow job to diagnose failures",
  { job_id: z.string().describe("The job ID to inspect (shown in status pane or /sf-jobs output)") },
  async ({ job_id }) => {
    const msg: IpcMessage = {
      type: "get_job_detail",
      id: randomBytes(8).toString("hex"),
      payload: { jobId: job_id },
    };
    const response = await ipc.request(msg);
    if (response.type === "error") {
      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text: `Error: ${response.payload.error}` } }],
      };
    }
    const info = response.payload.info as Record<string, unknown>;
    const output = response.payload.output as string[];

    // Show the last N lines to keep it manageable, full log available via tool
    const tail = output.slice(-100);
    const truncated = output.length > 100 ? `\n... (${output.length - 100} earlier lines omitted)\n` : "";

    const header = `Job ${info.id} — ${(info.state as string).toUpperCase()} (${info.workflowName})`;
    const body = truncated + tail.join("\n");

    return {
      messages: [{ role: "user" as const, content: { type: "text" as const, text: `${header}\n\n\`\`\`\n${body}\n\`\`\`\n\nAnalyze the output above and explain what went wrong. If there's a clear fix, suggest it.` } }],
    };
  }
);

server.prompt(
  "sf-jobs",
  "Show current status of all sparkflow workflow jobs",
  async () => {
    const msg: IpcMessage = {
      type: "list_jobs",
      id: randomBytes(8).toString("hex"),
      payload: {},
    };
    const response = await ipc.request(msg);
    if (response.type === "error") {
      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text: `Error listing jobs: ${response.payload.error}` } }],
      };
    }
    const jobs = response.payload.jobs as Array<Record<string, unknown>>;
    if (jobs.length === 0) {
      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text: "No sparkflow jobs are currently running. Use /sf-plan to design a workflow, then /sf-dispatch to start it." } }],
      };
    }
    const summary = jobs.map((j) => {
      const step = j.currentStep ? `/${j.currentStep}` : "";
      const question = j.pendingQuestion ? ` — pending: "${j.pendingQuestion}"` : "";
      return `- [${j.workflowName}${step}] ${(j.state as string).toUpperCase()} ${j.summary}${question}`;
    }).join("\n");
    return {
      messages: [{ role: "user" as const, content: { type: "text" as const, text: `Current sparkflow jobs:\n${summary}\n\nUse get_job_detail tool to see full output. Blocked jobs are shown in the status pane for the user to handle directly.` } }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
