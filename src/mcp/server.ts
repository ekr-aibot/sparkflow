#!/usr/bin/env node

/**
 * Sparkflow MCP server — spawned by claude as a child process.
 * Exposes `ask_user` and `send_message` tools that communicate
 * with the sparkflow engine via IPC over a Unix socket.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IpcClient, type IpcMessage } from "./ipc.js";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// server.js lives at <pkg>/dist/src/mcp/. Package root is three up.
const PKG_ROOT = resolve(__dirname, "..", "..", "..");
const PKG_JSON_PATH = resolve(PKG_ROOT, "package.json");

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const PKG_VERSION = readPackageVersion();

const socketPath = process.env.SPARKFLOW_SOCKET;
if (!socketPath) {
  console.error("SPARKFLOW_SOCKET environment variable is required");
  process.exit(1);
}

const ipc = new IpcClient(socketPath);
await ipc.connect();

const server = new McpServer({
  name: "sparkflow",
  version: PKG_VERSION,
});

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
    const response = await ipc.request(msg);
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
  "sparkflow_version",
  "Return the running sparkflow version, build mode, and (when available) git commit. Use this to confirm which sparkflow you're talking to.",
  {},
  async () => {
    let gitCommit: string | undefined;
    try {
      gitCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: PKG_ROOT,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
      if (!gitCommit) gitCommit = undefined;
    } catch {
      gitCommit = undefined;
    }
    const buildMode = process.env.SPARKFLOW_DEV === "1" ? "dev" : "prod";
    const info: Record<string, unknown> = { version: PKG_VERSION, buildMode };
    if (gitCommit) info.gitCommit = gitCommit;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
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
    // Fire and forget — we still send over IPC so the engine can display it
    await ipc.request(msg);
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

const transport = new StdioServerTransport();
await server.connect(transport);
