#!/usr/bin/env node

/**
 * Sparkflow MCP server — spawned by claude as a child process.
 *
 * Exposes:
 *   - `bash` — execute a command in the server's local shell. When the
 *     server runs inside a sandbox container, that means the command is
 *     executed inside the container.
 *   - `ask_user` / `send_message` — IPC to the sparkflow engine for
 *     interactive steps. Only registered when SPARKFLOW_SOCKET is set.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { IpcClient, type IpcMessage } from "./ipc.js";
import { randomBytes } from "node:crypto";

const socketPath = process.env.SPARKFLOW_SOCKET;

let ipc: IpcClient | undefined;
if (socketPath) {
  ipc = new IpcClient(socketPath);
  await ipc.connect();
}

const server = new McpServer({
  name: "sparkflow",
  version: "0.1.0",
});

server.tool(
  "bash",
  "Execute a shell command inside the step's sandbox. Use this for any command you would otherwise run via Bash. State (cwd, env, installed packages) does not persist between calls — use absolute paths and one-shot commands. Returns stdout, stderr, and the exit code.",
  {
    command: z.string().describe("The shell command line to execute."),
    cwd: z.string().optional().describe("Working directory. Defaults to /workspace."),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Kill the command after this many milliseconds. Defaults to 120000."),
  },
  async ({ command, cwd, timeout_ms }) => {
    const timeout = timeout_ms ?? 120_000;
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exit_code: number;
      timed_out: boolean;
    }>((resolve) => {
      const child = spawn("sh", ["-c", command], {
        cwd: cwd ?? "/workspace",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exit_code: code ?? -1,
          timed_out: timedOut,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: stderr + (stderr ? "\n" : "") + err.message,
          exit_code: -1,
          timed_out: timedOut,
        });
      });
    });

    const summary = [
      `exit: ${result.exit_code}${result.timed_out ? " (timed out)" : ""}`,
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
    ].filter(Boolean).join("\n");

    return {
      content: [{ type: "text" as const, text: summary }],
      isError: result.exit_code !== 0,
    };
  }
);

if (ipc) {
  const ipcClient = ipc;
  server.tool(
    "ask_user",
    "Ask the user a question and wait for their answer. Use this when you need clarification, decisions, or feedback from the user.",
    {
      question: z.string().describe("The question to ask the user"),
    },
    async ({ question }) => {
      const msg: IpcMessage = {
        type: "ask_user",
        id: randomBytes(8).toString("hex"),
        payload: { question },
      };
      const response = await ipcClient.request(msg);
      if (response.type === "error") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${response.payload.error}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: String(response.payload.response),
          },
        ],
      };
    }
  );

  server.tool(
    "send_message",
    "Display a message to the user without waiting for a response. Use this for progress updates, status, or informational output.",
    {
      message: z.string().describe("The message to display to the user"),
    },
    async ({ message }) => {
      const msg: IpcMessage = {
        type: "send_message",
        id: randomBytes(8).toString("hex"),
        payload: { message },
      };
      await ipcClient.request(msg);
      return {
        content: [
          {
            type: "text" as const,
            text: "Message sent.",
          },
        ],
      };
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
