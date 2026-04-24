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
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { spawn as ptySpawn, type IPty } from "node-pty";

import { JobManager } from "../tui/job-manager.js";
import { IpcServer } from "../mcp/ipc.js";
import { handleIpcRequest } from "../tui/ipc-handler.js";
import { EngineIpcClient } from "./engine-ipc-client.js";
import { repoIdFor, SPARKFLOW_VERSION, SPARKFLOW_PROTOCOL_VERSION } from "./discovery.js";
import { appendRing, RING_BUFFER_BYTES } from "./ring-buffer.js";
import { buildChatSpawn, type ChatTool, type McpServerSpec, type SlashCommandSpec } from "../tui/chat-tool.js";
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
    getChatTool: () => currentChatTool ?? "claude",
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
          deduplicateByPath: true,
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
        const result = jobManager.nudgeJob(msg.jobId, msg.stepId, msg.message);
        if (result.ok) ipcClient.sendResponse(msg.id, { ok: true });
        else ipcClient.sendError(msg.id, result.error ?? "nudge failed");
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
  let pty: IPty | null = null;
  let currentCleanup: (() => void) | null = null;
  let ring: Buffer = Buffer.alloc(0);
  const ptyClients = new Set<Socket>();
  let bridgeServer: NetServer | null = null;

  function broadcastPtyFrame(frame: string): void {
    for (const c of ptyClients) {
      try { c.write(frame); } catch { /* ignore */ }
    }
  }

  if (ingredients && ptyBridgePath) {
    currentChatTool = ingredients.chatTool;
    let switchingTool = false;

    function spawnChatPty(tool: ChatTool): void {
      const chatSpawn = buildChatSpawn({
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
      });

      const nextPty = ptySpawn(chatSpawn.cmd, chatSpawn.args, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,
        env: process.env as Record<string, string>,
      });
      pty = nextPty;
      currentCleanup = chatSpawn.cleanup;
      currentChatTool = tool;

      nextPty.onData((data) => {
        const chunk = Buffer.from(data, "utf-8");
        ring = appendRing(ring, chunk, RING_BUFFER_BYTES);
        broadcastPtyFrame(JSON.stringify({ type: "pty_data", bytes: chunk.toString("base64") }) + "\n");
      });

      nextPty.onExit(({ exitCode }) => {
        if (switchingTool || pty !== nextPty) return;
        console.error(`[sparkflow engine] chat process exited (code=${exitCode}); shutting down`);
        shutdown(0);
      });
    }

    function switchChatTool(nextTool: ToolKind): void {
      if (nextTool === currentChatTool) return;
      broadcastPtyFrame(JSON.stringify({
        type: "pty_data",
        bytes: Buffer.from(`\r\n[sparkflow] switching chat to ${nextTool}…\r\n`, "utf-8").toString("base64"),
      }) + "\n");
      switchingTool = true;
      const oldPty = pty;
      const oldCleanup = currentCleanup;
      pty = null;
      currentCleanup = null;
      ring = Buffer.alloc(0);
      try { oldPty?.kill(); } catch { /* ignore */ }
      try { oldCleanup?.(); } catch { /* ignore */ }
      spawnChatPty(nextTool);
      switchingTool = false;
      broadcastPtyFrame(JSON.stringify({ type: "chat_tool", tool: nextTool }) + "\n");
    }

    spawnChatPty(ingredients.chatTool);

    // PTY bridge server
    try { unlinkSync(ptyBridgePath); } catch { /* not present */ }
    bridgeServer = createNetServer((sock: Socket) => {
      ptyClients.add(sock);
      sock.setEncoding("utf-8");
      if (ring.length > 0) {
        sock.write(JSON.stringify({ type: "snapshot", bytes: ring.toString("base64") }) + "\n");
      }
      // Announce the current tool on every new client so the UI can initialise
      // its pulldown from the engine's live state.
      sock.write(JSON.stringify({ type: "chat_tool", tool: currentChatTool ?? "claude" }) + "\n");
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk as unknown as string;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as { type?: string; bytes?: string; cols?: number; rows?: number; tool?: string };
            if (msg.type === "pty_write" && typeof msg.bytes === "string") {
              pty?.write(Buffer.from(msg.bytes, "base64").toString("utf-8"));
            } else if (msg.type === "pty_resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
              pty?.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
            } else if (msg.type === "set_chat_tool" && (msg.tool === "claude" || msg.tool === "gemini")) {
              switchChatTool(msg.tool);
            }
          } catch { /* ignore */ }
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
    try { pty?.kill(); } catch { /* ignore */ }
    try { currentCleanup?.(); } catch { /* ignore */ }
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
