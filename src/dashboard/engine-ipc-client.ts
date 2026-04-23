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
  AttachAckMessage,
  FrontendToEngine,
  ResponseMessage,
  ErrorMessage,
  PongMessage,
  ToolKind,
} from "./ipc-protocol.js";

type IncomingFrame =
  | AttachAckMessage
  | FrontendToEngine
  | ResponseMessage
  | ErrorMessage
  | PongMessage;

export interface EngineIpcClientOptions {
  frontendSocketPath: string;
  repoId: string;
  repoPath: string;
  repoName: string;
  mcpSocket: string;
  ptyBridgePath?: string;
  /** Current chat tool (only meaningful if ptyBridgePath is set). */
  getChatTool?: () => ToolKind;
  /** Current jobs tool. */
  getJobTool?: () => ToolKind;
  /** Sparkflow package version (informational, shown in error messages). */
  version: string;
  /** Wire-format version — must match the frontend's SPARKFLOW_PROTOCOL_VERSION. */
  protocolVersion: number;
}

/** Events emitted by EngineIpcClient:
 *  "command" (msg: FrontendToEngine)  — a command from the frontend
 *  "reconnect"                         — after a successful reconnect
 *  "frontendDisconnect"                — lost connection (will attempt to reconnect)
 *  "attachError" (msg: ErrorMessage)   — frontend rejected our attach (fatal,
 *                                        no reconnect scheduled)
 */
export class EngineIpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = "";
  private closed = false;
  private reconnectDelay = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private hasConnectedOnce = false;
  /** Set when the frontend rejects our attach — suppresses reconnect. */
  private attachRejected = false;
  /**
   * True once we've seen any inbound frame from the frontend OTHER than a
   * pre-attach rejection. Un-correlated errors are only fatal while this is
   * false — a mid-session error without an id is a protocol bug, not an
   * attach rejection.
   */
  private attachAcknowledged = false;

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
          ...(this.opts.getChatTool ? { chatTool: this.opts.getChatTool() } : {}),
          ...(this.opts.getJobTool ? { jobTool: this.opts.getJobTool() } : {}),
          version: this.opts.version,
          protocolVersion: this.opts.protocolVersion,
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
    this.attachAcknowledged = false;

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
      if (this.closed || this.attachRejected) return;
      this.emit("frontendDisconnect");
      this.scheduleReconnect();
    };
    sock.on("close", onDisconnect);
    sock.on("error", () => {
      /* handled by close */
    });
  }

  private handleLine(line: string): void {
    let msg: IncomingFrame;
    try {
      msg = JSON.parse(line) as IncomingFrame;
    } catch {
      return;
    }

    // Positive attach acknowledgement. The frontend sends exactly one of
    // these on successful attach — any later un-correlated errors are
    // protocol bugs, not rejections, and we must not tear down the session.
    if (msg.type === "attachAck") {
      this.attachAcknowledged = true;
      return;
    }

    // Pre-attach rejection: the frontend sends one un-correlated error frame
    // and closes the socket. If we haven't yet been acknowledged, treat this
    // as fatal — suppress the reconnect loop and surface it so the engine
    // daemon can exit cleanly.
    //
    // Any un-correlated error received AFTER the ack is a protocol bug on
    // the frontend side, not a rejection — ignore it rather than tearing
    // down a healthy session.
    if (msg.type === "error" && !(msg as ErrorMessage).id) {
      if (!this.attachAcknowledged) {
        this.attachRejected = true;
        this.closed = true;
        this.emit("attachError", msg as ErrorMessage);
      }
      return;
    }
    this.emit("command", msg);
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

  sendJobSnapshot(jobs: JobInfo[]): void {
    this.write(JSON.stringify({ type: "jobSnapshot", jobs }) + "\n");
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

  /**
   * Graceful shutdown. If `detach` is true and a socket is open, writes a
   * `{type:"detach"}` frame and sends FIN via `socket.end(...)`, which
   * flushes before teardown. Otherwise destroys immediately. Use `detach:
   * true` for orderly exit, `detach: false` for fatal error paths where
   * the peer shouldn't wait around for a clean goodbye.
   */
  close(opts: { detach?: boolean } = {}): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.socket;
    this.socket = null;
    if (!sock) return;
    if (opts.detach && sock.writable) {
      try {
        sock.end(JSON.stringify({ type: "detach" }) + "\n");
      } catch {
        // `socket.end()` normally surfaces errors via events, but an
        // unusual state could synchronously throw — fall through to
        // destroy so shutdown is never blocked on a stuck end().
        try { sock.destroy(); } catch { /* ignore */ }
        return;
      }
      // Destroy safety net in case FIN ack never arrives.
      setTimeout(() => {
        try { sock.destroy(); } catch { /* ignore */ }
      }, 1000).unref();
    } else {
      sock.destroy();
    }
  }
}
