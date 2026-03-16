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
  },
  async ({ workflow_path, cwd, plan }) => {
    const msg: IpcMessage = {
      type: "start_workflow",
      id: randomBytes(8).toString("hex"),
      payload: { workflowPath: workflow_path, cwd, plan },
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

// --- MCP Prompts (show up as /slash-commands in claude) ---

server.prompt(
  "sf-plan",
  "Enter planning mode to build a project plan before dispatching to a workflow",
  async () => {
    return {
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Enter planning mode. Help me think through what I want to build before handing it off to a sparkflow workflow.

Work with me to produce a clear, detailed project plan. This plan will be passed to the workflow agents as their instructions, so it needs to be specific enough for them to execute autonomously. Help me think through:

1. **Goal**: What are we building? What problem does it solve?
2. **Scope**: What's in and what's out? What are the boundaries?
3. **Approach**: How should it be implemented? Key design decisions, architecture, patterns.
4. **Files**: What files need to be created or modified?
5. **Details**: Edge cases, error handling, testing strategy, anything the agents need to know.
6. **Verification**: How do we know it's done? What does success look like?

Ask me questions, challenge my assumptions, and help me refine the plan. When we're both happy with it, I'll use /sf-dispatch to write the plan to disk and kick off the workflow.`,
        },
      }],
    };
  }
);

server.prompt(
  "sf-dispatch",
  "Write the plan to disk and dispatch it to a sparkflow workflow",
  { workflow_path: z.string().describe("Path to the workflow JSON file to run") },
  async ({ workflow_path }) => {
    return {
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Dispatch the plan we just built to the workflow at: ${workflow_path}

Do the following:
1. Write the plan we developed to a markdown file (e.g. plan.md in the current directory).
2. Call the start_workflow tool with workflow_path="${workflow_path}" and plan set to the path of the plan file.
3. Report back the job ID.

The status pane at the bottom of the terminal will show live progress.`,
        },
      }],
    };
  }
);

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
