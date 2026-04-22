/**
 * Engine-side IPC client. The per-repo engine daemon uses this to connect to
 * the shared frontend socket, announce its identity (attach), propagate job
 * events, and receive commands from the frontend.
 *
 * Reconnects on transient failures using exponential back-off.
 */

import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import type { JobInfo } from "../tui/types.js";
import type {
  FrontendToEngine,
  ResponseMessage,
  ErrorMessage,
  PongMessage,
} from "./ipc-protocol.js";

export interface EngineIpcClientOptions {
  frontendSocketPath: string;
  repoId: string;
  repoPath: string;
  repoName: string;
  mcpSocket: string;
  ptyBridgePath?: string;
  version: string;
}

/** Events emitted by EngineIpcClient:
 *  "command" (msg: FrontendToEngine)  — a command from the frontend
 *  "reconnect"                         — after a successful reconnect
 *  "frontendDisconnect"                — lost connection (will attempt to reconnect)
 */
export class EngineIpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = "";
  private closed = false;
  private reconnectDelay = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private hasConnectedOnce = false;

  constructor(private readonly opts: EngineIpcClientOptions) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = createConnection(this.opts.frontendSocketPath);
      let settled = false;
      sock.once("connect", () => {
        settled = true;
        this.attachSocket(sock);
        this.reconnectDelay = 0;
        // Announce ourselves on every (re)connect
        this.sendMsg(sock, {
          type: "attach",
          repoId: this.opts.repoId,
          repoPath: this.opts.repoPath,
          repoName: this.opts.repoName,
          mcpSocket: this.opts.mcpSocket,
          ...(this.opts.ptyBridgePath ? { ptyBridgePath: this.opts.ptyBridgePath } : {}),
          version: this.opts.version,
        });
        const isReconnect = this.hasConnectedOnce;
        this.hasConnectedOnce = true;
        if (isReconnect) setImmediate(() => this.emit("reconnect"));
        resolve();
      });
      sock.once("error", (err) => {
        if (!settled) reject(err);
      });
    });
  }

  private attachSocket(sock: Socket): void {
    this.socket = sock;
    this.buffer = "";

    sock.setEncoding("utf-8");
    sock.on("data", (chunk) => {
      this.buffer += chunk as unknown as string;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
      }
    });

    const onDisconnect = () => {
      if (this.socket !== sock) return;
      this.socket = null;
      if (this.closed) return;
      this.emit("frontendDisconnect");
      this.scheduleReconnect();
    };
    sock.on("close", onDisconnect);
    sock.on("error", () => {
      /* handled by close */
    });
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line) as FrontendToEngine | ResponseMessage | ErrorMessage | PongMessage;
      this.emit("command", msg);
    } catch {
      /* ignore malformed */
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectDelay = Math.min(Math.max(this.reconnectDelay * 2, 100), 2000);
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Outbound messages
  // ---------------------------------------------------------------------------

  sendDetach(): void {
    this.write(JSON.stringify({ type: "detach" }) + "\n");
  }

  sendJobSnapshot(jobs: JobInfo[]): void {
    this.write(JSON.stringify({ type: "jobSnapshot", jobs }) + "\n");
  }

  sendJobUpdate(job: JobInfo): void {
    this.write(JSON.stringify({ type: "jobUpdate", job }) + "\n");
  }

  sendJobRemoved(jobId: string): void {
    this.write(JSON.stringify({ type: "jobRemoved", jobId }) + "\n");
  }

  sendResponse(id: string, payload: Record<string, unknown>): void {
    this.write(JSON.stringify({ type: "response", id, payload }) + "\n");
  }

  sendError(id: string, error: string, code?: string): void {
    const msg: ErrorMessage = { type: "error", id, error };
    if (code) msg.code = code;
    this.write(JSON.stringify(msg) + "\n");
  }

  sendPong(id: string): void {
    this.write(JSON.stringify({ type: "pong", id }) + "\n");
  }

  private write(data: string): void {
    if (!this.socket) return;
    try {
      this.socket.write(data);
    } catch {
      /* will resend on reconnect if needed */
    }
  }

  private sendMsg(sock: Socket, msg: Record<string, unknown>): void {
    try {
      sock.write(JSON.stringify(msg) + "\n");
    } catch {
      /* ignore */
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
