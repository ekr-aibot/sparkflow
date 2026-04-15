import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface IpcMessage {
  type: string;
  id: string;
  payload: Record<string, unknown>;
}

/**
 * IPC server that listens on a Unix socket.
 * Used by the sparkflow engine to receive requests from MCP servers.
 */
export class IpcServer {
  private server: Server | null = null;
  private socketPath: string;
  private handler: ((msg: IpcMessage) => Promise<IpcMessage>) | null = null;
  private connections: Set<Socket> = new Set();

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? join(
      tmpdir(),
      `sparkflow-${randomBytes(8).toString("hex")}.sock`
    );
  }

  get path(): string {
    return this.socketPath;
  }

  onRequest(handler: (msg: IpcMessage) => Promise<IpcMessage>): void {
    this.handler = handler;
  }

  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.connections.add(socket);
        socket.on("close", () => this.connections.delete(socket));

        let buffer = "";
        socket.on("data", (data) => {
          buffer += data.toString();
          // Process complete messages (newline-delimited JSON)
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            if (line.trim()) {
              this.handleLine(socket, line);
            }
          }
        });
      });

      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    if (!this.handler) return;

    let msgId = "unknown";
    try {
      const msg = JSON.parse(line) as IpcMessage;
      msgId = msg.id;
      const response = await this.handler(msg);
      socket.write(JSON.stringify(response) + "\n");
    } catch (err) {
      const errorResponse: IpcMessage = {
        type: "error",
        id: msgId,
        payload: { error: err instanceof Error ? err.message : String(err) },
      };
      socket.write(JSON.stringify(errorResponse) + "\n");
    }
  }

  async close(): Promise<void> {
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}

/**
 * IPC client that connects to a Unix socket.
 *
 * Tolerates the server restarting (e.g. sparkflow's dev-mode status daemon
 * reloading): on close/error it reconnects with exponential backoff and
 * re-issues any in-flight requests. Callers' promises stay pending across
 * the reload rather than being rejected.
 */
export class IpcClient {
  private socket: Socket | null = null;
  private socketPath: string;
  private pendingRequests = new Map<
    string,
    { resolve: (msg: IpcMessage) => void; reject: (err: Error) => void; payload: string }
  >();
  private buffer = "";
  private closed = false;
  private reconnectDelay = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      let settled = false;
      sock.once("connect", () => {
        settled = true;
        this.attachSocket(sock);
        this.reconnectDelay = 0;
        // Re-issue any requests that were in flight when the previous socket died.
        for (const [, pending] of this.pendingRequests) {
          try { sock.write(pending.payload); } catch { /* will retry on next reconnect */ }
        }
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

    sock.on("data", (data) => {
      this.buffer += data.toString();
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIdx);
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line.trim()) this.handleLine(line);
      }
    });

    const onDisconnect = () => {
      if (this.socket !== sock) return;
      this.socket = null;
      if (this.closed) return;
      this.scheduleReconnect();
    };
    sock.on("close", onDisconnect);
    sock.on("error", () => { /* handled via close */ });
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

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line) as IpcMessage;
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg);
      }
    } catch {
      // Ignore malformed responses
    }
  }

  async request(msg: IpcMessage): Promise<IpcMessage> {
    const payload = JSON.stringify(msg) + "\n";
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(msg.id, { resolve, reject, payload });
      if (this.socket) {
        try {
          this.socket.write(payload);
        } catch {
          // Will be resent when the socket reconnects.
        }
      }
      // If we have no socket, the request sits in pendingRequests and goes out
      // on the next successful reconnect.
    });
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
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("IPC client closed"));
    }
    this.pendingRequests.clear();
  }
}
