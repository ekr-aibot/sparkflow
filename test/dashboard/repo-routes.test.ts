import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createFrontendDaemon, type FrontendDaemonHandle } from "../../src/dashboard/frontend-daemon.js";
import { EngineIpcClient } from "../../src/dashboard/engine-ipc-client.js";
import type { JobInfo } from "../../src/tui/types.js";

const TEST_TOKEN = "a".repeat(64);

function makeJobInfo(id: string, extra: Partial<JobInfo> = {}): JobInfo {
  return {
    id,
    workflowPath: "/repo/workflow.json",
    workflowName: "workflow",
    state: "running",
    summary: "starting",
    startTime: Date.now(),
    ...extra,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("frontend-daemon HTTP routes", () => {
  let tmpDir: string;
  let daemon: FrontendDaemonHandle;
  let client: EngineIpcClient;
  const baseUrl = () => `http://127.0.0.1:${daemon.port}`;
  const headers = {
    Accept: "application/json",
    Cookie: `sf_token=${TEST_TOKEN}`,
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-routes-test-"));
    const ipcSock = join(tmpDir, "frontend.sock");
    daemon = await createFrontendDaemon({ ipcSocketPath: ipcSock, port: 0, token: TEST_TOKEN });

    const engineSock = join(tmpDir, "mcp.sock");
    client = new EngineIpcClient({
      frontendSocketPath: ipcSock,
      repoId: "testrepo",
      repoPath: "/repo",
      repoName: "My Repo",
      mcpSocket: engineSock,
      version: "0.1.0",
    });
    await client.connect();

    // Handle commands from frontend so request/response tests work.
    client.on("command", (msg: { type: string; id?: string; jobId?: string }) => {
      if (!msg.id) return;
      if (msg.type === "ping") {
        client.sendPong(msg.id);
        return;
      }
      if (msg.type === "killJob" || msg.type === "answerRecovery") {
        client.sendResponse(msg.id, { ok: true });
        return;
      }
      if (msg.type === "getJobDetail") {
        client.sendResponse(msg.id, {
          info: makeJobInfo(msg.jobId ?? ""),
          output: ["line 1", "line 2"],
        });
        return;
      }
    });

    // Send initial job snapshot.
    client.sendJobSnapshot([makeJobInfo("job-001"), makeJobInfo("job-002", { state: "succeeded" })]);
    await waitFor(() => daemon.registry.getAllJobs().length === 2);
  });

  afterEach(async () => {
    client.close();
    await daemon.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("GET /repos returns attached repos", async () => {
    const res = await fetch(`${baseUrl()}/repos`, { headers });
    expect(res.ok).toBe(true);
    const body = await res.json() as { repos: Array<{ repoId: string; repoName: string }> };
    expect(body.repos.length).toBe(1);
    expect(body.repos[0].repoId).toBe("testrepo");
    expect(body.repos[0].repoName).toBe("My Repo");
  });

  it("GET /events streams repos and jobs", async () => {
    // Just verify the endpoint responds with SSE content type.
    const ac = new AbortController();
    const res = await fetch(`${baseUrl()}/events`, {
      headers: { ...headers, Accept: "text/event-stream" },
      signal: ac.signal,
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    ac.abort();
  });

  it("GET /repos/:repoId/jobs/:jobId/log returns output", async () => {
    const res = await fetch(`${baseUrl()}/repos/testrepo/jobs/job-001/log`, { headers });
    expect(res.ok).toBe(true);
    const body = await res.json() as { lines: string[]; length: number };
    expect(Array.isArray(body.lines)).toBe(true);
  });

  it("POST /repos/:repoId/jobs/:jobId/kill returns ok", async () => {
    const res = await fetch(`${baseUrl()}/repos/testrepo/jobs/job-001/kill`, {
      method: "POST",
      headers,
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("POST /repos/:repoId/jobs/:jobId/recovery validates action field", async () => {
    const res = await fetch(`${baseUrl()}/repos/testrepo/jobs/job-001/recovery`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ action: "invalid" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown repoId", async () => {
    const res = await fetch(`${baseUrl()}/repos/unknownrepo/jobs/job-001/kill`, {
      method: "POST",
      headers,
    });
    expect(res.status).toBe(404);
  });

  it("returns 401 when token is missing", async () => {
    const res = await fetch(`${baseUrl()}/repos`, {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("POST /repos/:repoId/start dispatches workflow", async () => {
    // Override command handler to handle startWorkflow.
    client.removeAllListeners("command");
    client.on("command", (msg: { type: string; id?: string; workflowPath?: string }) => {
      if (!msg.id) return;
      if (msg.type === "startWorkflow") {
        client.sendResponse(msg.id, { jobId: "new-job-xyz" });
      }
    });

    const res = await fetch(`${baseUrl()}/repos/testrepo/start`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ workflowPath: "/repo/my-workflow.json", slug: "test run" }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { jobId: string };
    expect(body.jobId).toBe("new-job-xyz");
  });
});
