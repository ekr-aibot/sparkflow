#!/usr/bin/env node

/**
 * Per-repo engine daemon.
 *
 * Owns the JobManager, StateStore, worktree management, and MCP socket for
 * one repository. Connects outward to the shared frontend daemon via IPC, and
 * propagates job state changes as they happen.
 *
 * Also owns the chat PTY (if chat-tool ingredients are present in the
 * environment) and exposes a PTY-bridge socket so the frontend can proxy the
 * /chat WebSocket to it.
 *
 * Invocation (from src/tui/index.ts):
 *   node engine-daemon.js <frontendSocketPath> <cwd> <mcpSocketPath> <ptyBridgePath>
 *
 * Environment (same as the old web/index.ts supervisor):
 *   SPARKFLOW_WEB_CHAT_TOOL, SPARKFLOW_WEB_CHAT_COMMAND, SPARKFLOW_WEB_CHAT_ARGS_JSON,
 *   SPARKFLOW_WEB_MCP_CONFIG_PATH, SPARKFLOW_WEB_SYSTEM_PROMPT_PATH,
 *   SPARKFLOW_WEB_MCP_SERVER_NAME, SPARKFLOW_WEB_SLASH_COMMANDS_JSON,
 *   SPARKFLOW_WEB_DEV, SPARKFLOW_WEB_TOKEN
 *   SPARKFLOW_ENGINE_NAME  — optional display name override (--name flag)
 */

import { resolve } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { spawn as ptySpawn, type IPty } from "node-pty";

import { JobManager } from "../tui/job-manager.js";
import { IpcServer } from "../mcp/ipc.js";
import { handleIpcRequest } from "../tui/ipc-handler.js";
import { EngineIpcClient } from "./engine-ipc-client.js";
import { repoIdFor, SPARKFLOW_VERSION, SPARKFLOW_PROTOCOL_VERSION } from "./discovery.js";
import { appendRing, RING_BUFFER_BYTES } from "./ring-buffer.js";
import { buildChatSpawn, buildBareChatSpawn, type ChatTool, type McpServerSpec, type SlashCommandSpec } from "../tui/chat-tool.js";
import type { ErrorMessage, FrontendToEngine, ToolKind } from "./ipc-protocol.js";

// ---------------------------------------------------------------------------
// Args / env
// ---------------------------------------------------------------------------

interface Args {
  frontendSocketPath: string;
  cwd: string;
  mcpSocketPath: string;
  ptyBridgePath: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length < 4) {
    console.error("Usage: engine-daemon <frontendSocketPath> <cwd> <mcpSocketPath> <ptyBridgePath>");
    process.exit(1);
  }
  const [frontendSocketPath, cwd, mcpSocketPath, ptyBridgePath] = argv;
  return { frontendSocketPath, cwd: resolve(cwd), mcpSocketPath, ptyBridgePath };
}

interface ChatIngredients {
  chatTool: ChatTool;
  chatArgs: string[];
  mcpServerName: string;
  mcpServerSpec: McpServerSpec;
  mcpConfigPath: string;
  systemPromptText: string;
  systemPromptPath: string;
  commandOverride: string | null;
  slashCommands: Record<string, SlashCommandSpec>;
}

function readChatIngredients(): ChatIngredients | null {
  const mcpConfigPath = process.env.SPARKFLOW_WEB_MCP_CONFIG_PATH;
  const systemPromptPath = process.env.SPARKFLOW_WEB_SYSTEM_PROMPT_PATH;
  if (!mcpConfigPath || !systemPromptPath) return null;

  const mcpServerName = process.env.SPARKFLOW_WEB_MCP_SERVER_NAME ?? "sparkflow-dashboard";
  let chatArgs: string[] = [];
  try {
    const parsed = JSON.parse(process.env.SPARKFLOW_WEB_CHAT_ARGS_JSON ?? "[]");
    if (Array.isArray(parsed)) chatArgs = parsed.map(String);
  } catch { /* keep default */ }

  let mcpServerSpec: McpServerSpec | undefined;
  try {
    const mcp = JSON.parse(readFileSync(mcpConfigPath, "utf-8")) as { mcpServers?: Record<string, McpServerSpec> };
    mcpServerSpec = mcp.mcpServers?.[mcpServerName];
  } catch { return null; }

  if (!mcpServerSpec) return null;

  let systemPromptText: string;
  try { systemPromptText = readFileSync(systemPromptPath, "utf-8"); }
  catch { return null; }

  const commandOverride = process.env.SPARKFLOW_WEB_CHAT_COMMAND_OVERRIDDEN === "1"
    ? (process.env.SPARKFLOW_WEB_CHAT_COMMAND ?? null)
    : null;

  let slashCommands: Record<string, SlashCommandSpec> = {};
  try { slashCommands = JSON.parse(process.env.SPARKFLOW_WEB_SLASH_COMMANDS_JSON ?? "{}"); }
  catch { /* keep empty */ }

  const chatToolRaw = process.env.SPARKFLOW_WEB_CHAT_TOOL;
  const chatTool: ChatTool = chatToolRaw === "gemini" ? "gemini" : "claude";

  return { chatTool, chatArgs, mcpServerName, mcpServerSpec, mcpConfigPath, systemPromptText, systemPromptPath, commandOverride, slashCommands };
}

function defaultCommandFor(tool: ChatTool, override: string | null): string {
  if (override) return override;
  return tool === "gemini" ? "npx" : "claude";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const { cwd, mcpSocketPath, ptyBridgePath, frontendSocketPath } = args;

  // --- JobManager ---
  const jobManager = new JobManager(cwd);
  jobManager.rehydrate();
  jobManager.autoStartMonitors();

  // --- MCP IPC server (for mcp-bridge.ts to connect to) ---
  try { unlinkSync(mcpSocketPath); } catch { /* not present */ }
  const ipcServer = new IpcServer(mcpSocketPath);
  ipcServer.onRequest((msg) => handleIpcRequest(msg, jobManager, cwd));
  await ipcServer.listen();

  // --- Repo identity ---
  const repoId = repoIdFor(cwd);
  // Send the bare basename as repoName. Disambiguation of colliding names
  // across attached engines happens on the frontend side in getRepos(),
  // which is the only place that knows the full set.
  const repoName =
    process.env.SPARKFLOW_ENGINE_NAME ?? (cwd.split("/").at(-1) ?? cwd);

  // --- Chat/jobs tool state (mutable: switched at runtime via IPC or bridge). ---
  const initialJobToolRaw = process.env.SPARKFLOW_LLM;
  let currentJobTool: ToolKind = initialJobToolRaw === "gemini" ? "gemini" : "claude";
  // currentChatTool is assigned once ingredients are read (below). Exposed
  // through the ipcClient so the frontend sees it in AttachMessage.
  let currentChatTool: ToolKind | null = null;

  // --- Frontend IPC client ---
  const ipcClient = new EngineIpcClient({
    frontendSocketPath,
    repoId,
    repoPath: cwd,
    repoName,
    mcpSocket: mcpSocketPath,
    ptyBridgePath: ptyBridgePath || undefined,
    getChatTool: () => chats.get("main")?.tool ?? currentChatTool ?? "claude",
    getJobTool: () => currentJobTool,
    version: SPARKFLOW_VERSION,
    protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
  });

  // Wire job updates to frontend
  jobManager.onUpdate(() => {
    ipcClient.sendJobSnapshot(jobManager.getJobs());
  });

  // Handle commands from frontend
  ipcClient.on("command", (msg: FrontendToEngine) => {
    switch (msg.type) {
      case "ping":
        ipcClient.sendPong(msg.id);
        break;

      case "startWorkflow": {
        const jobId = jobManager.startJob(msg.workflowPath, {
          cwd: msg.cwd ?? cwd,
          plan: msg.plan,
          planText: msg.planText,
          slug: msg.slug,
          description: msg.description,
          deduplicate: true,
        });
        ipcClient.sendResponse(msg.id, { jobId });
        break;
      }

      case "killJob": {
        const result = jobManager.killJob(msg.jobId);
        if (result.ok) ipcClient.sendResponse(msg.id, { ok: true });
        else ipcClient.sendError(msg.id, result.error ?? "kill failed");
        break;
      }

      case "removeJob": {
        const result = jobManager.removeJob(msg.jobId);
        if (result.ok) ipcClient.sendResponse(msg.id, { ok: true });
        else ipcClient.sendError(msg.id, result.error ?? "remove failed");
        break;
      }

      case "restartJob": {
        jobManager.restartJob(msg.jobId, msg.mode ?? "fresh").then((result) => {
          if (result.ok) ipcClient.sendResponse(msg.id, { ok: true, newJobId: result.newJobId });
          else ipcClient.sendError(msg.id, result.error ?? "restart failed");
        }).catch((err: unknown) => {
          ipcClient.sendError(msg.id, err instanceof Error ? err.message : String(err));
        });
        break;
      }

      case "answerRecovery": {
        const ok = jobManager.answerRecovery(msg.jobId, msg.action, msg.message);
        if (ok) ipcClient.sendResponse(msg.id, { ok: true });
        else ipcClient.sendError(msg.id, `Job ${msg.jobId} is not waiting for recovery`);
        break;
      }

      case "getJobDetail": {
        const detail = jobManager.getJobDetail(msg.jobId);
        if (!detail) ipcClient.sendError(msg.id, `Job not found: ${msg.jobId}`);
        else ipcClient.sendResponse(msg.id, detail as unknown as Record<string, unknown>);
        break;
      }

      case "setJobTool": {
        if (msg.tool !== "claude" && msg.tool !== "gemini") {
          ipcClient.sendError(msg.id, `invalid tool: ${String(msg.tool)}`);
          break;
        }
        currentJobTool = msg.tool;
        // Mutate the engine's env so subsequent sparkflow-run children inherit
        // the new preference. Claude is the hardcoded default in engine.ts, so
        // we actively unset the env var rather than writing "claude".
        if (msg.tool === "gemini") process.env.SPARKFLOW_LLM = "gemini";
        else delete process.env.SPARKFLOW_LLM;
        ipcClient.sendResponse(msg.id, { jobTool: msg.tool });
        break;
      }

      case "nudgeJob": {
        const nudgeId = randomBytes(8).toString("hex");
        const result = jobManager.nudgeJob(msg.jobId, msg.stepId, msg.message, nudgeId);
        if (!result.ok) {
          ipcClient.sendError(msg.id, result.error ?? "nudge failed");
          break;
        }
        const timeoutMs = Number(process.env.NUDGE_ACK_TIMEOUT_MS ?? "600000");
        jobManager.waitForNudgeAck(nudgeId, timeoutMs).then((ackResult) => {
          if ("status" in ackResult && ackResult.status === "timeout") {
            ipcClient.sendResponse(msg.id, { ok: false, status: "pending", nudgeId });
          } else {
            ipcClient.sendResponse(msg.id, { ok: true, ...ackResult });
          }
        }).catch(() => {
          ipcClient.sendResponse(msg.id, { ok: false, nudgeId, error: "ack wait failed" });
        });
        break;
      }
    }
  });

  ipcClient.on("frontendDisconnect", () => {
    console.error("[sparkflow engine] frontend disconnected — will attempt to reconnect");
  });

  // Frontend rejected our attach (duplicate repo, version mismatch, etc.)
  // — exit cleanly rather than loop-reconnect forever.
  ipcClient.on("attachError", (err: ErrorMessage) => {
    if (err.code === "already_attached") {
      console.error(
        `[sparkflow engine] another sparkflow --web is already attached for this repo (${repoName})`,
      );
    } else if (err.code === "version_mismatch") {
      console.error(
        `[sparkflow engine] version mismatch: frontend is v${err.frontendVersion} (protocol ${err.frontendProtocolVersion ?? "?"}), ` +
          `this engine is v${err.engineVersion} (protocol ${err.engineProtocolVersion ?? "?"}). ` +
          `Restart the frontend ('pkill -f frontend-daemon') or install a matching sparkflow version.`,
      );
    } else {
      console.error(`[sparkflow engine] frontend rejected attach: ${err.error}`);
    }
    jobManager.release();
    try { ipcClient.close(); } catch { /* ignore */ }
    void ipcServer.close().finally(() => process.exit(1));
  });

  // --- PTY bridge (optional: only if chat ingredients are available) ---
  //
  // IMPORTANT: the PTY bridge server must be listening BEFORE we attach to
  // the frontend. The frontend kicks off `connectPtyBridge(ptyBridgePath)`
  // synchronously on receiving the attach, and if the bridge isn't
  // listening yet, that connect() gets ECONNREFUSED and silently falls
  // through — WS /chat then serves no data. Order: spawn pty → listen on
  // bridge → attach to frontend.
  const ingredients = readChatIngredients();
  const ptyClients = new Set<Socket>();
  let bridgeServer: NetServer | null = null;

  interface ChatSession {
    pty: IPty | null;
    ring: Buffer;
    cleanup: (() => void) | null;
    tool: ChatTool;
    kind: "main" | "sidechat";
    switchingTool: boolean;
  }
  // Populated inside the if-block below; used by cleanup() outside it.
  const chats = new Map<string, ChatSession>();

  function broadcastPtyFrame(frame: string): void {
    for (const c of ptyClients) {
      try { c.write(frame); } catch { /* ignore */ }
    }
  }

  if (ingredients && ptyBridgePath) {
    let sideCounter = 0;
    const MAX_SIDE_CHATS = 8;

    currentChatTool = ingredients.chatTool;

    function wireChatPty(chatId: string, nextPty: IPty): void {
      nextPty.onData((data) => {
        const session = chats.get(chatId);
        if (!session) return;
        const chunk = Buffer.from(data, "utf-8");
        session.ring = appendRing(session.ring, chunk, RING_BUFFER_BYTES);
        broadcastPtyFrame(JSON.stringify({ type: "pty_data", chatId, bytes: chunk.toString("base64") }) + "\n");
      });
      nextPty.onExit(({ exitCode }) => {
        const session = chats.get(chatId);
        if (!session || session.switchingTool || session.pty !== nextPty) return;
        if (chatId === "main") {
          console.error(`[sparkflow engine] chat process exited (code=${exitCode}); shutting down`);
          shutdown(0);
        } else {
          console.error(`[sparkflow engine] side-chat ${chatId} exited (code=${exitCode})`);
          const oldCleanup = session.cleanup;
          chats.delete(chatId);
          try { oldCleanup?.(); } catch { /* ignore */ }
          broadcastPtyFrame(JSON.stringify({ type: "chat_closed", chatId }) + "\n");
        }
      });
    }

    function spawnChatPty(chatId: string, tool: ChatTool, kind: "main" | "sidechat"): void {
      const chatSpawnObj = kind === "main"
        ? buildChatSpawn({
            tool,
            command: defaultCommandFor(tool, ingredients!.commandOverride),
            chatArgs: ingredients!.chatArgs,
            mcpServerSpec: ingredients!.mcpServerSpec,
            mcpServerName: ingredients!.mcpServerName,
            mcpConfigPath: ingredients!.mcpConfigPath,
            systemPromptText: ingredients!.systemPromptText,
            systemPromptPath: ingredients!.systemPromptPath,
            cwd,
            slashCommands: ingredients!.slashCommands,
          })
        : buildBareChatSpawn({
            tool,
            command: defaultCommandFor(tool, ingredients!.commandOverride),
            chatArgs: ingredients!.chatArgs,
            cwd,
          });

      const nextPty = ptySpawn(chatSpawnObj.cmd, chatSpawnObj.args, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,
        env: process.env as Record<string, string>,
      });

      const session: ChatSession = {
        pty: nextPty,
        ring: Buffer.alloc(0),
        cleanup: chatSpawnObj.cleanup,
        tool,
        kind,
        switchingTool: false,
      };
      chats.set(chatId, session);
      if (chatId === "main") currentChatTool = tool;
      wireChatPty(chatId, nextPty);
    }

    function switchChatTool(nextTool: ToolKind): void {
      const session = chats.get("main");
      if (!session || nextTool === session.tool) return;
      broadcastPtyFrame(JSON.stringify({
        type: "pty_data",
        chatId: "main",
        bytes: Buffer.from(`\r\n[sparkflow] switching chat to ${nextTool}…\r\n`, "utf-8").toString("base64"),
      }) + "\n");
      session.switchingTool = true;
      const oldPty = session.pty;
      const oldCleanup = session.cleanup;
      session.pty = null;
      session.cleanup = null;
      session.ring = Buffer.alloc(0);
      try { oldPty?.kill(); } catch { /* ignore */ }
      try { oldCleanup?.(); } catch { /* ignore */ }
      const chatSpawnObj = buildChatSpawn({
        tool: nextTool,
        command: defaultCommandFor(nextTool, ingredients!.commandOverride),
        chatArgs: ingredients!.chatArgs,
        mcpServerSpec: ingredients!.mcpServerSpec,
        mcpServerName: ingredients!.mcpServerName,
        mcpConfigPath: ingredients!.mcpConfigPath,
        systemPromptText: ingredients!.systemPromptText,
        systemPromptPath: ingredients!.systemPromptPath,
        cwd,
        slashCommands: ingredients!.slashCommands,
      });
      const nextPty = ptySpawn(chatSpawnObj.cmd, chatSpawnObj.args, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,
        env: process.env as Record<string, string>,
      });
      session.pty = nextPty;
      session.cleanup = chatSpawnObj.cleanup;
      session.tool = nextTool;
      session.switchingTool = false;
      currentChatTool = nextTool;
      wireChatPty("main", nextPty);
      broadcastPtyFrame(JSON.stringify({ type: "chat_tool", chatId: "main", tool: nextTool }) + "\n");
    }

    function spawnSideChat(tool: ChatTool, clientReqId: string): void {
      const sideChatCount = [...chats.values()].filter(s => s.kind === "sidechat").length;
      if (sideChatCount >= MAX_SIDE_CHATS) {
        broadcastPtyFrame(JSON.stringify({ type: "chat_create_failed", clientReqId, error: "side-chat limit reached (8)" }) + "\n");
        return;
      }
      const chatId = `sidechat-${++sideCounter}`;
      spawnChatPty(chatId, tool, "sidechat");
      broadcastPtyFrame(JSON.stringify({ type: "chat_created", clientReqId, chatId, tool }) + "\n");
    }

    function closeChat(chatId: string, clientReqId: string): void {
      if (chatId === "main") {
        broadcastPtyFrame(JSON.stringify({ type: "chat_close_failed", clientReqId, error: "cannot close main chat" }) + "\n");
        return;
      }
      const session = chats.get(chatId);
      if (!session) {
        broadcastPtyFrame(JSON.stringify({ type: "chat_close_failed", clientReqId, error: "chat not found" }) + "\n");
        return;
      }
      const oldPty = session.pty;
      const oldCleanup = session.cleanup;
      // Remove before kill so the onExit handler skips re-broadcast.
      chats.delete(chatId);
      try { oldPty?.kill(); } catch { /* ignore */ }
      try { oldCleanup?.(); } catch { /* ignore */ }
      broadcastPtyFrame(JSON.stringify({ type: "chat_closed", chatId, clientReqId }) + "\n");
    }

    spawnChatPty("main", ingredients.chatTool, "main");

    // PTY bridge server
    try { unlinkSync(ptyBridgePath); } catch { /* not present */ }
    bridgeServer = createNetServer((sock: Socket) => {
      ptyClients.add(sock);
      sock.setEncoding("utf-8");
      // Send chat pool state: list first, then per-chat snapshots.
      const chatList = [...chats.entries()].map(([cId, s]) => ({ chatId: cId, kind: s.kind, tool: s.tool }));
      sock.write(JSON.stringify({ type: "chat_list", chats: chatList }) + "\n");
      for (const [cId, session] of chats) {
        if (session.ring.length > 0) {
          sock.write(JSON.stringify({ type: "snapshot", chatId: cId, bytes: session.ring.toString("base64") }) + "\n");
        }
      }
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk as unknown as string;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as {
              type?: string; chatId?: string; bytes?: string;
              cols?: number; rows?: number; tool?: string; clientReqId?: string;
            };
            if (msg.type === "pty_write" && typeof msg.chatId === "string" && typeof msg.bytes === "string") {
              chats.get(msg.chatId)?.pty?.write(Buffer.from(msg.bytes, "base64").toString("utf-8"));
            } else if (msg.type === "pty_resize" && typeof msg.chatId === "string" && typeof msg.cols === "number" && typeof msg.rows === "number") {
              chats.get(msg.chatId)?.pty?.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
            } else if (msg.type === "set_chat_tool" && (msg.tool === "claude" || msg.tool === "gemini")) {
              switchChatTool(msg.tool);
            } else if (msg.type === "chat_create" && typeof msg.clientReqId === "string" && (msg.tool === "claude" || msg.tool === "gemini")) {
              spawnSideChat(msg.tool, msg.clientReqId);
            } else if (msg.type === "chat_close" && typeof msg.chatId === "string" && typeof msg.clientReqId === "string") {
              closeChat(msg.chatId, msg.clientReqId);
            }
          } catch { /* ignore bad frame */ }
        }
      });
      sock.on("close", () => ptyClients.delete(sock));
      sock.on("error", () => { ptyClients.delete(sock); });
    });

    await new Promise<void>((res) => bridgeServer!.listen(ptyBridgePath, () => res()));
  }

  // Connect to frontend — now that the PTY bridge is ready for the
  // frontend's inbound connection triggered by engineAttached.
  try {
    await ipcClient.connect();
    ipcClient.sendJobSnapshot(jobManager.getJobs());
  } catch (err) {
    console.error(`[sparkflow engine] failed to connect to frontend: ${(err as Error).message}`);
    process.exit(1);
  }

  // --- Lifecycle ---
  let exiting = false;

  function cleanup(): void {
    for (const [, session] of chats) {
      try { session.pty?.kill(); } catch { /* ignore */ }
      try { session.cleanup?.(); } catch { /* ignore */ }
    }
    chats.clear();
    try { bridgeServer?.close(); } catch { /* ignore */ }
    if (ptyBridgePath) try { unlinkSync(ptyBridgePath); } catch { /* ignore */ }
  }

  function shutdown(code: number): void {
    if (exiting) return;
    exiting = true;
    jobManager.flush();
    // Detach frame is flushed before FIN via socket.end(); destroy safety
    // net inside close() keeps shutdown bounded.
    ipcClient.close({ detach: true });
    ipcServer.close().finally(() => {
      cleanup();
      process.exit(code);
    });
  }

  process.on("SIGINT", () => {
    jobManager.killAll();
    shutdown(0);
  });
  process.on("SIGTERM", () => {
    jobManager.release();
    shutdown(0);
  });
  process.on("SIGHUP", () => {
    jobManager.release();
    shutdown(0);
  });

  if (!ingredients || !ptyBridgePath) {
    // No PTY — block by keeping the process alive until a signal
    process.stderr.write(
      `[sparkflow engine] attached repo "${repoName}" (${repoId}) to dashboard\n`,
    );
  }
}

main().catch((err) => {
  console.error("[sparkflow engine] fatal:", err);
  process.exit(1);
});
