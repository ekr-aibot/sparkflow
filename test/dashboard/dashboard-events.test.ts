import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFrontendDaemon, type FrontendDaemonHandle } from "../../src/dashboard/frontend-daemon.js";
import { EngineIpcClient } from "../../src/dashboard/engine-ipc-client.js";
import { SPARKFLOW_VERSION, SPARKFLOW_PROTOCOL_VERSION } from "../../src/dashboard/discovery.js";
import type { JobInfo } from "../../src/tui/types.js";

const TEST_TOKEN = "c".repeat(64);

function makeJobInfo(id: string, extra: Partial<JobInfo> = {}): JobInfo {
  return {
    id,
    workflowPath: "/repo/workflow.json",
    workflowName: "workflow",
    state: "running",
    summary: "running",
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

describe("GET /repos/:repoId/dashboard/events (SSE)", () => {
  let tmpDir: string;
  let daemon: FrontendDaemonHandle;
  let client: EngineIpcClient;
  const authHeaders = { Cookie: `sf_token=${TEST_TOKEN}` };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sf-events-"));
    const ipcSock = join(tmpDir, "frontend.sock");
    daemon = await createFrontendDaemon({ ipcSocketPath: ipcSock, port: 0, token: TEST_TOKEN });

    client = new EngineIpcClient({
      frontendSocketPath: ipcSock,
      repoId: "eventsrepo",
      repoPath: tmpDir,
      repoName: "Events Repo",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client.connect();
    await waitFor(() => daemon.registry.getEngine("eventsrepo") !== null);
  });

  afterEach(async () => {
    client.close();
    await daemon.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns 200 with text/event-stream content-type", async () => {
    const ac = new AbortController();
    try {
      const res = await fetch(
        `http://127.0.0.1:${daemon.port}/repos/eventsrepo/dashboard/events`,
        { headers: { ...authHeaders, Accept: "text/event-stream" }, signal: ac.signal },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    } finally {
      ac.abort();
    }
  });

  it("sends initial state event with null when state.json is missing", async () => {
    const ac = new AbortController();
    const events: Array<{ name: string; data: string }> = [];

    try {
      const res = await fetch(
        `http://127.0.0.1:${daemon.port}/repos/eventsrepo/dashboard/events`,
        { headers: authHeaders, signal: ac.signal },
      );

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      // Read until we get at least one 'state' event
      const getEvents = async (): Promise<void> => {
        for (let i = 0; i < 20; i++) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Parse SSE frames
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          let eventName = "message";
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
            else if (line === "" && dataLine !== "") {
              events.push({ name: eventName, data: dataLine });
              eventName = "message";
              dataLine = "";
            }
          }
          if (events.length > 0) break;
        }
      };

      await Promise.race([getEvents(), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 3000))]);
    } finally {
      ac.abort();
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].name).toBe("state");
    expect(events[0].data).toBe("null");
  });

  it("sends initial state event with state.json content when file exists", async () => {
    const dashDir = join(tmpDir, ".sparkflow", "dashboard");
    mkdirSync(dashDir, { recursive: true });
    const stateData = { workflow: "auto-develop", updatedAt: "2025-01-01T00:00:00Z" };
    writeFileSync(join(dashDir, "state.json"), JSON.stringify(stateData));

    const ac = new AbortController();
    const events: Array<{ name: string; data: string }> = [];

    try {
      const res = await fetch(
        `http://127.0.0.1:${daemon.port}/repos/eventsrepo/dashboard/events`,
        { headers: authHeaders, signal: ac.signal },
      );

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const getEvents = async (): Promise<void> => {
        for (let i = 0; i < 20; i++) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          let eventName = "message";
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
            else if (line === "" && dataLine !== "") {
              events.push({ name: eventName, data: dataLine });
              eventName = "message";
              dataLine = "";
            }
          }
          if (events.length > 0) break;
        }
      };

      await Promise.race([getEvents(), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 3000))]);
    } finally {
      ac.abort();
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].name).toBe("state");
    const parsed = JSON.parse(events[0].data);
    expect(parsed.workflow).toBe("auto-develop");
  });

  it("emits a job event when a job state changes for this repo", async () => {
    const ac = new AbortController();
    const events: Array<{ name: string; data: string }> = [];

    const res = await fetch(
      `http://127.0.0.1:${daemon.port}/repos/eventsrepo/dashboard/events`,
      { headers: authHeaders, signal: ac.signal },
    );

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const collector = (async (): Promise<void> => {
      let buf = "";
      let eventName = "message";
      let dataLine = "";
      for (let i = 0; i < 100; i++) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          break;
        }
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
          else if (line === "" && dataLine !== "") {
            events.push({ name: eventName, data: dataLine });
            eventName = "message";
            dataLine = "";
          }
        }
      }
    })();

    // Wait for initial state event
    await waitFor(() => events.some((e) => e.name === "state"), 3000);

    // Emit a job snapshot which triggers a job event
    client.sendJobSnapshot([makeJobInfo("job-abc", { state: "running" })]);

    // Wait for a job event
    await waitFor(() => events.some((e) => e.name === "job"), 3000);

    ac.abort();
    await collector.catch(() => { /* aborted */ });

    const jobEvents = events.filter((e) => e.name === "job");
    expect(jobEvents.length).toBeGreaterThan(0);
    const parsed = JSON.parse(jobEvents[0].data);
    expect(parsed.id).toBe("job-abc");
  });

  it("returns 404 for unknown repoId", async () => {
    const ac = new AbortController();
    try {
      const res = await fetch(
        `http://127.0.0.1:${daemon.port}/repos/unknown-repo/dashboard/events`,
        { headers: authHeaders, signal: ac.signal },
      );
      expect(res.status).toBe(404);
    } finally {
      ac.abort();
    }
  });
});
