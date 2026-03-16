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

const socketPath = process.env.SPARKFLOW_SOCKET;
if (!socketPath) {
  console.error("SPARKFLOW_SOCKET environment variable is required");
  process.exit(1);
}

const ipc = new IpcClient(socketPath);
await ipc.connect();

const server = new McpServer({
  name: "sparkflow",
  version: "0.1.0",
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
