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
 * Used by the MCP server to send requests to the sparkflow engine.
 */
export class IpcClient {
  private socket: Socket | null = null;
  private socketPath: string;
  private pendingRequests = new Map<
    string,
    { resolve: (msg: IpcMessage) => void; reject: (err: Error) => void }
  >();
  private buffer = "";

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = connect(this.socketPath, () => resolve());
      this.socket.on("error", reject);

      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        let newlineIdx: number;
        while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, newlineIdx);
          this.buffer = this.buffer.slice(newlineIdx + 1);
          if (line.trim()) {
            this.handleLine(line);
          }
        }
      });

      this.socket.on("close", () => {
        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error("IPC connection closed"));
        }
        this.pendingRequests.clear();
      });
    });
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
    if (!this.socket) {
      throw new Error("IPC client not connected");
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(msg.id, { resolve, reject });
      this.socket!.write(JSON.stringify(msg) + "\n");
    });
  }

  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
