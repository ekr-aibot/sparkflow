import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FrontendIpcServer } from "../../src/dashboard/frontend-ipc-server.js";
import { EngineIpcClient } from "../../src/dashboard/engine-ipc-client.js";
import { SPARKFLOW_VERSION, SPARKFLOW_PROTOCOL_VERSION } from "../../src/dashboard/discovery.js";
import type { ErrorMessage } from "../../src/dashboard/ipc-protocol.js";
import type { JobInfo } from "../../src/tui/types.js";

function makeJobInfo(id: string): JobInfo {
  return {
    id,
    workflowPath: "/repo/workflow.json",
    workflowName: "workflow",
    state: "running",
    summary: "starting",
    startTime: Date.now(),
  };
}

describe("engine ↔ frontend IPC integration", () => {
  let tmpDir: string;
  let sockPath: string;
  let server: FrontendIpcServer;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-ipc-test-"));
    sockPath = join(tmpDir, "frontend.sock");
    server = new FrontendIpcServer(sockPath);
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("engine attaches and frontend emits engineAttached", async () => {
    const attached = new Promise<string>((resolve) => {
      server.once("engineAttached", (conn) => resolve(conn.repoId));
    });

    const client = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "abc123",
      repoPath: "/repo",
      repoName: "testrepo",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client.connect();

    const repoId = await attached;
    expect(repoId).toBe("abc123");

    const repos = server.getRepos();
    expect(repos.length).toBe(1);
    expect(repos[0].repoName).toBe("testrepo");

    client.close();
  });

  it("job snapshot is reflected in server registry", async () => {
    const attached = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });

    const client = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "repo1",
      repoPath: "/r1",
      repoName: "r1",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client.connect();
    await attached;

    const jobs: JobInfo[] = [makeJobInfo("job-a"), makeJobInfo("job-b")];
    client.sendJobSnapshot(jobs);

    // Poll until the snapshot lands.
    await waitFor(() => {
      const all = server.getAllJobs();
      return all.length === 2;
    });

    const all = server.getAllJobs();
    expect(all.map((j) => j.id).sort()).toEqual(["job-a", "job-b"]);
    expect(all[0].repoId).toBe("repo1");

    client.close();
  });

  it("frontend can send a command and receive a response via engine", async () => {
    const attached = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });

    const client = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "repo2",
      repoPath: "/r2",
      repoName: "r2",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client.connect();
    await attached;

    // Engine listens for ping and responds with pong.
    client.on("command", (msg: { type: string; id?: string }) => {
      if (msg.type === "ping" && msg.id) {
        client.sendPong(msg.id);
      }
    });

    const result = await server.sendCommand("repo2", { type: "ping" });
    expect(result).not.toBeNull();
    expect((result as { id?: string }).id).toBeTruthy();

    client.close();
  });

  it("engine detaches cleanly: frontend emits engineDetached", async () => {
    const attached = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });
    const detached = new Promise<string>((resolve) => {
      server.once("engineDetached", (repoId) => resolve(repoId));
    });

    const client = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "repo3",
      repoPath: "/r3",
      repoName: "r3",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client.connect();
    await attached;

    client.close({ detach: true });

    const repoId = await detached;
    expect(repoId).toBe("repo3");
    expect(server.getRepos().length).toBe(0);
  });

  it("duplicate attach is rejected and client emits attachError (no reconnect loop)", async () => {
    const attached = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });

    const client1 = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "dupe",
      repoPath: "/r",
      repoName: "r",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client1.connect();
    await attached;

    const client2 = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "dupe",
      repoPath: "/r",
      repoName: "r",
      mcpSocket: join(tmpDir, "mcp2.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });

    let reconnectCount = 0;
    client2.on("reconnect", () => reconnectCount++);
    const attachErr = new Promise<ErrorMessage>((resolve) => {
      client2.once("attachError", (e: ErrorMessage) => resolve(e));
    });

    await client2.connect();
    const err = await attachErr;
    expect(err.code).toBe("already_attached");

    // Give a window for any stray reconnect to kick in — should not happen.
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(reconnectCount).toBe(0);
    expect(server.getRepos().length).toBe(1);

    client1.close();
    client2.close();
  });

  it("attach with mismatched protocol version is rejected with version_mismatch", async () => {
    const client = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "v-mismatch",
      repoPath: "/vm",
      repoName: "vm",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: "99.99.99",
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION + 1,
    });

    const attachErr = new Promise<ErrorMessage>((resolve) => {
      client.once("attachError", (e: ErrorMessage) => resolve(e));
    });

    await client.connect();
    const err = await attachErr;
    expect(err.code).toBe("version_mismatch");
    expect(err.frontendVersion).toBe(SPARKFLOW_VERSION);
    expect(err.engineVersion).toBe("99.99.99");
    expect(err.frontendProtocolVersion).toBe(SPARKFLOW_PROTOCOL_VERSION);
    expect(err.engineProtocolVersion).toBe(SPARKFLOW_PROTOCOL_VERSION + 1);

    // Registry must NOT list the rejected engine.
    expect(server.getRepos().length).toBe(0);

    client.close();
  });

  it("patch-level sparkflow version mismatch does NOT trigger rejection", async () => {
    // Bumping the sparkflow package version but keeping the wire protocol
    // stable should not break attaches — only protocolVersion mismatches do.
    const client = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "patch-bump",
      repoPath: "/pb",
      repoName: "pb",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: "99.99.99", // different sparkflow package version
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });

    const attached = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });
    await client.connect();
    await attached;
    expect(server.getRepos().length).toBe(1);

    client.close();
  });

  it("socket inode is chmodded to 0700", () => {
    const st = statSync(sockPath);
    // Mode permissions below 0o777. chmodSync(0o700) should set exactly rwx------.
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("colliding repo basenames are disambiguated in getRepos()", async () => {
    const attached1 = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });
    const client1 = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "abcdef0001",
      repoPath: "/home/alice/sparkflow",
      repoName: "sparkflow",
      mcpSocket: join(tmpDir, "mcp-a.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client1.connect();
    await attached1;

    // Before the collision, no suffix.
    const reposBefore = server.getRepos();
    expect(reposBefore[0].repoName).toBe("sparkflow");

    const attached2 = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });
    const client2 = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "abcdef0002",
      repoPath: "/home/bob/sparkflow",
      repoName: "sparkflow",
      mcpSocket: join(tmpDir, "mcp-b.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client2.connect();
    await attached2;

    const reposAfter = server.getRepos();
    expect(reposAfter.length).toBe(2);
    for (const r of reposAfter) {
      // Suffix is 6+ hex chars (extended on collision).
      expect(r.repoName).toMatch(/^sparkflow \([0-9a-f]{6,}\)$/);
    }
    // And the two suffixes are distinct even when the first 6 chars collide
    // (the synthesized repoIds here share "abcdef" — the implementation
    // must extend the suffix until unique).
    expect(reposAfter[0].repoName).not.toBe(reposAfter[1].repoName);

    client1.close();
    client2.close();
  });

  it("post-attach un-correlated error does NOT trigger attachError or reconnect", async () => {
    // The frontend sends `attachAck` on a successful attach. The client must
    // record that and subsequently ignore any un-correlated error frames —
    // they're protocol bugs on the frontend, not attach rejections.
    const attached = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });

    const client = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "post-attach-err",
      repoPath: "/p",
      repoName: "p",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });

    let attachErrors = 0;
    let reconnects = 0;
    client.on("attachError", () => attachErrors++);
    client.on("reconnect", () => reconnects++);

    await client.connect();
    await attached;

    // Fabricate a post-attach un-correlated error by reaching into the
    // server's connection and writing a raw frame. This is exactly the
    // kind of wayward frame a buggy future frontend change might emit.
    const conn = server.getEngine("post-attach-err");
    if (!conn) throw new Error("expected engine in registry");
    conn.send({ type: "error", error: "spurious mid-session error" } as unknown as Parameters<typeof conn.send>[0]);

    // Give the client time to mis-react if it's going to.
    await new Promise<void>((r) => setTimeout(r, 200));

    expect(attachErrors).toBe(0);
    expect(reconnects).toBe(0);
    // Engine is still in the registry — we did not tear down the session.
    expect(server.getRepos().length).toBe(1);

    client.close();
  });

  it("onUpdate returns an unsubscribe that actually detaches the callback", async () => {
    let count = 0;
    const unsubscribe = server.onUpdate(() => { count++; });

    const client = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "sub-test",
      repoPath: "/r",
      repoName: "r",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client.connect();
    await waitFor(() => count >= 1);

    const after = count;
    unsubscribe();

    // After unsubscribe, further engine activity must not invoke the callback.
    client.sendJobSnapshot([makeJobInfo("j1")]);
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(count).toBe(after);

    client.close();
  });

  it("anti-spoofing: a spoofed repoId field in post-attach messages is ignored", async () => {
    // Bypass EngineIpcClient so we can send a raw frame the real client
    // would never emit. The registry MUST bind jobs to the attach-time
    // repoId, not to whatever the sender later claims.
    const attached = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });

    const sock = createConnection(sockPath);
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
    });

    // Legitimate attach as "legit".
    sock.write(
      JSON.stringify({
        type: "attach",
        repoId: "legit",
        repoPath: "/legit",
        repoName: "legit",
        mcpSocket: join(tmpDir, "mcp.sock"),
        version: SPARKFLOW_VERSION,
        protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
      }) + "\n",
    );
    await attached;

    // Now send a jobSnapshot with an explicit spoofed repoId.
    sock.write(
      JSON.stringify({
        type: "jobSnapshot",
        repoId: "evil",
        jobs: [makeJobInfo("spoofed-job")],
      }) + "\n",
    );

    await waitFor(() => server.getAllJobs().length === 1);
    const all = server.getAllJobs();
    expect(all[0].repoId).toBe("legit");
    expect(all.find((j) => j.repoId === "evil")).toBeUndefined();
    expect(server.getEngine("evil")).toBeNull();

    sock.destroy();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
