/**
 * Frontend-side IPC server. Listens on ~/.sparkflow/dashboard.sock and
 * accepts connections from per-repo engine daemons.
 *
 * Security: on the first message from each connection we expect an `attach`
 * that declares the repoId. We bind that repoId to the socket. Any subsequent
 * message that contains a `repoId` field is stripped of it before processing —
 * the bound value is always used. This prevents a compromised engine in repo A
 * from spoofing repo B's repoId in later messages.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { JobInfo } from "../tui/types.js";
import type {
  RepoInfo,
  FrontendToEngine,
  ResponseMessage,
  ErrorMessage,
  PongMessage,
} from "./ipc-protocol.js";
import { SPARKFLOW_VERSION, SPARKFLOW_PROTOCOL_VERSION } from "./discovery.js";

type CommandResponse = ResponseMessage | ErrorMessage | PongMessage;

export interface EngineConnection {
  readonly repoId: string;     // bound once on attach, immutable
  readonly repoPath: string;
  readonly repoName: string;
  readonly mcpSocket: string;
  readonly ptyBridgePath: string | undefined;
  readonly version: string;
  /** Current live job state for this engine. */
  readonly jobs: Map<string, JobInfo>;
  /** Send a fire-and-forget message to this engine. */
  send(msg: FrontendToEngine): void;
  /** Send a command and await a correlated response. Rejects on socket close. */
  request(msg: FrontendToEngine): Promise<Record<string, unknown>>;
}

export class FrontendIpcServer extends EventEmitter {
  private server: Server | null = null;
  private engines: Map<string, EngineConnection> = new Map();
  private updateCallbacks: Array<() => void> = [];

  constructor(private readonly socketPath: string) {
    super();
  }

  async listen(): Promise<void> {
    try {
      unlinkSync(this.socketPath);
    } catch {
      /* not present */
    }
    return new Promise<void>((resolve, reject) => {
      this.server = createServer((sock) => this.handleConnection(sock));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => {
        // Node inherits umask for the socket inode; lock it down so only
        // the owner can connect.
        try {
          chmodSync(this.socketPath, 0o700);
        } catch (err) {
          reject(err as Error);
          return;
        }
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    // Use a single persistent context object so processLine mutations (e.g.
    // setting ctx.boundRepoId after attach) persist across subsequent calls.
    const ctx = {
      boundRepoId: null as string | null,
      pendingRequests: new Map<
        string,
        { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
      >(),
    };
    let buffer = "";

    socket.setEncoding("utf-8");

    socket.on("data", (chunk) => {
      buffer += chunk as unknown as string;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          this.processLine(socket, line, ctx);
        } catch {
          /* ignore bad frames */
        }
      }
    });

    socket.on("close", () => {
      if (ctx.boundRepoId) {
        this.engines.delete(ctx.boundRepoId);
        this.emit("engineDetached", ctx.boundRepoId);
        this.fireUpdate();
        const err = new Error("engine disconnected");
        for (const [, p] of ctx.pendingRequests) p.reject(err);
        ctx.pendingRequests.clear();
      }
    });

    socket.on("error", () => {
      /* close event handles cleanup */
    });
  }

  private processLine(
    socket: Socket,
    line: string,
    ctx: {
      boundRepoId: string | null;
      pendingRequests: Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>;
    },
  ): void {
    const raw = JSON.parse(line) as Record<string, unknown>;

    // Reject the connection with a final error frame. `socket.end(payload)`
    // flushes the payload before FIN, which `write` + `destroy` does not
    // guarantee — on fast rejects this would otherwise race the destroy and
    // the client would see only a close (no error) and loop-reconnect.
    const rejectAttach = (payload: Record<string, unknown>): void => {
      socket.end(JSON.stringify(payload) + "\n");
    };

    // ---- First message must be `attach` ----
    if (ctx.boundRepoId === null) {
      if (raw.type !== "attach") {
        rejectAttach({ type: "error", error: "first message must be attach", code: "protocol_error" });
        return;
      }
      const repoId = typeof raw.repoId === "string" ? raw.repoId : null;
      if (!repoId) {
        rejectAttach({ type: "error", error: "attach missing repoId", code: "protocol_error" });
        return;
      }
      if (this.engines.has(repoId)) {
        rejectAttach({ type: "error", error: "already_attached", code: "already_attached" });
        return;
      }

      // Protocol check: refuse engines whose wire version differs from the
      // frontend's. Bumped explicitly when the IPC format changes, so
      // patch-level sparkflow upgrades don't break live engines. The `version`
      // field is only used for human-readable error text.
      const engineVersion = typeof raw.version === "string" ? raw.version : "";
      const engineProtocol =
        typeof raw.protocolVersion === "number" ? raw.protocolVersion : 0;
      if (engineProtocol !== SPARKFLOW_PROTOCOL_VERSION) {
        rejectAttach({
          type: "error",
          error:
            `version_mismatch: frontend is sparkflow v${SPARKFLOW_VERSION} (protocol ${SPARKFLOW_PROTOCOL_VERSION}), ` +
            `engine is v${engineVersion || "unknown"} (protocol ${engineProtocol})`,
          code: "version_mismatch",
          frontendVersion: SPARKFLOW_VERSION,
          engineVersion,
          frontendProtocolVersion: SPARKFLOW_PROTOCOL_VERSION,
          engineProtocolVersion: engineProtocol,
        });
        return;
      }

      ctx.boundRepoId = repoId;

      const jobs = new Map<string, JobInfo>();

      const conn: EngineConnection = {
        repoId,
        repoPath: String(raw.repoPath ?? ""),
        repoName: String(raw.repoName ?? ""),
        mcpSocket: String(raw.mcpSocket ?? ""),
        ptyBridgePath: typeof raw.ptyBridgePath === "string" ? raw.ptyBridgePath : undefined,
        version: String(raw.version ?? ""),
        jobs,
        send: (msg) => {
          if (socket.writable) socket.write(JSON.stringify(msg) + "\n");
        },
        request: (msg) => {
          return new Promise<Record<string, unknown>>((resolve, reject) => {
            ctx.pendingRequests.set(msg.id, { resolve, reject });
            if (socket.writable) socket.write(JSON.stringify(msg) + "\n");
            const timer = setTimeout(() => {
              if (ctx.pendingRequests.has(msg.id)) {
                ctx.pendingRequests.delete(msg.id);
                reject(new Error(`request ${msg.id} timed out`));
              }
            }, 30_000);
            if (typeof (timer as NodeJS.Timeout).unref === "function") (timer as NodeJS.Timeout).unref();
          });
        },
      };

      this.engines.set(repoId, conn);
      this.emit("engineAttached", conn);
      this.fireUpdate();
      return;
    }

    // ---- Subsequent messages: strip any spoofed repoId ----
    const msg = { ...raw };
    delete msg.repoId; // ignore — use the bound value

    const repoId = ctx.boundRepoId;
    const conn = this.engines.get(repoId);
    if (!conn) return;

    switch (msg.type) {
      case "detach":
        socket.destroy();
        return;

      case "jobSnapshot": {
        conn.jobs.clear();
        const jobs = Array.isArray(msg.jobs) ? (msg.jobs as JobInfo[]) : [];
        for (const job of jobs) conn.jobs.set(job.id, job);
        this.fireUpdate();
        return;
      }

      case "response":
      case "error":
      case "pong": {
        const id = typeof msg.id === "string" ? msg.id : null;
        if (!id) return;
        const pending = ctx.pendingRequests.get(id);
        if (!pending) return;
        ctx.pendingRequests.delete(id);
        if (msg.type === "error") {
          const errMsg = typeof msg.error === "string" ? msg.error : "unknown engine error";
          // Resolve with an error-shaped object so callers can inspect
          pending.resolve({ error: errMsg, code: msg.code as string | undefined });
        } else {
          const payload =
            msg.type === "response" && typeof msg.payload === "object" && msg.payload !== null
              ? (msg.payload as Record<string, unknown>)
              : (msg as Record<string, unknown>);
          pending.resolve(payload);
        }
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // EngineRegistry API
  // ---------------------------------------------------------------------------

  getRepos(): RepoInfo[] {
    // Disambiguate basename collisions here — the engines send their bare
    // basename as repoName; if two engines share one, append a short repoId
    // suffix to each so the dashboard can tell them apart. Read-time
    // disambiguation keeps the view consistent with the set of currently-
    // attached engines without round-trips to the engines.
    const engines = Array.from(this.engines.values());
    const baseCounts = new Map<string, number>();
    for (const e of engines) baseCounts.set(e.repoName, (baseCounts.get(e.repoName) ?? 0) + 1);

    return engines.map((e) => ({
      repoId: e.repoId,
      repoPath: e.repoPath,
      repoName:
        (baseCounts.get(e.repoName) ?? 0) > 1
          ? `${e.repoName} (${e.repoId.slice(0, 4)})`
          : e.repoName,
      mcpSocket: e.mcpSocket,
      ptyBridgePath: e.ptyBridgePath,
      version: e.version,
    }));
  }

  getEngine(repoId: string): EngineConnection | null {
    return this.engines.get(repoId) ?? null;
  }

  /** All jobs across all attached engines, each tagged with its repoId. */
  getAllJobs(): Array<JobInfo & { repoId: string }> {
    const out: Array<JobInfo & { repoId: string }> = [];
    for (const [repoId, conn] of this.engines) {
      for (const job of conn.jobs.values()) {
        out.push({ ...job, repoId });
      }
    }
    return out;
  }

  /**
   * Send a command to a specific engine and await its response.
   * Returns null if no such engine is attached.
   */
  async sendCommand(
    repoId: string,
    msg: { type: string; id?: string; [key: string]: unknown },
  ): Promise<Record<string, unknown> | null> {
    const conn = this.engines.get(repoId);
    if (!conn) return null;
    const full = { ...msg, id: msg.id ?? randomBytes(8).toString("hex") } as FrontendToEngine;
    return conn.request(full);
  }

  /** Get the first attached engine's PTY bridge path, if any. */
  getPrimaryPtyBridgePath(): string | undefined {
    for (const conn of this.engines.values()) {
      if (conn.ptyBridgePath) return conn.ptyBridgePath;
    }
    return undefined;
  }

  /** Subscribe to registry updates. Returns an unsubscribe function. */
  onUpdate(cb: () => void): () => void {
    this.updateCallbacks.push(cb);
    return () => {
      const idx = this.updateCallbacks.indexOf(cb);
      if (idx !== -1) this.updateCallbacks.splice(idx, 1);
    };
  }

  private fireUpdate(): void {
    // Iterate a snapshot so a callback that unsubscribes itself (or another
    // callback) during delivery doesn't perturb the loop.
    for (const cb of [...this.updateCallbacks]) cb();
  }

  async close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}
