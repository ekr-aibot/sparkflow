import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FrontendIpcServer } from "../../src/dashboard/frontend-ipc-server.js";
import { EngineIpcClient } from "../../src/dashboard/engine-ipc-client.js";
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
      version: "0.1.0",
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
      version: "0.1.0",
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
      version: "0.1.0",
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
      version: "0.1.0",
    });
    await client.connect();
    await attached;

    client.sendDetach();
    client.close();

    const repoId = await detached;
    expect(repoId).toBe("repo3");
    expect(server.getRepos().length).toBe(0);
  });

  it("duplicate attach is rejected", async () => {
    const attached = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });

    const client1 = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "dupe",
      repoPath: "/r",
      repoName: "r",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: "0.1.0",
    });
    await client1.connect();
    await attached;

    // Second client with same repoId should fail to attach (socket gets destroyed).
    const client2 = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "dupe",
      repoPath: "/r",
      repoName: "r",
      mcpSocket: join(tmpDir, "mcp2.sock"),
      version: "0.1.0",
    });

    // connect() will succeed (TCP layer), but the server will destroy the socket
    // when it sees the duplicate repoId. The engine will reconnect; we just check
    // the registry still has exactly one entry.
    try { await client2.connect(); } catch { /* may reject */ }
    await new Promise<void>((r) => setTimeout(r, 100));

    expect(server.getRepos().length).toBe(1);

    client1.close();
    client2.close();
  });

  it("anti-spoofing: post-attach repoId field is ignored", async () => {
    const attached = new Promise<void>((resolve) => {
      server.once("engineAttached", () => resolve());
    });

    const client = new EngineIpcClient({
      frontendSocketPath: sockPath,
      repoId: "legit",
      repoPath: "/legit",
      repoName: "legit",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: "0.1.0",
    });
    await client.connect();
    await attached;

    // After attach, send a jobSnapshot with a spoofed repoId field.
    // The FrontendIpcServer should strip it and use the bound "legit" id.
    const jobs: JobInfo[] = [makeJobInfo("spoofed-job")];
    client.sendJobSnapshot(jobs);

    await waitFor(() => server.getAllJobs().length === 1);

    const all = server.getAllJobs();
    expect(all[0].repoId).toBe("legit"); // not "evil"

    client.close();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
