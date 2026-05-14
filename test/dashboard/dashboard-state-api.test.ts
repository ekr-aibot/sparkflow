import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFrontendDaemon, type FrontendDaemonHandle } from "../../src/dashboard/frontend-daemon.js";
import { EngineIpcClient } from "../../src/dashboard/engine-ipc-client.js";
import { SPARKFLOW_VERSION, SPARKFLOW_PROTOCOL_VERSION } from "../../src/dashboard/discovery.js";

const TEST_TOKEN = "b".repeat(64);

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("GET /repos/:repoId/dashboard/state", () => {
  let tmpDir: string;
  let daemon: FrontendDaemonHandle;
  let client: EngineIpcClient;
  const authHeaders = { Cookie: `sf_token=${TEST_TOKEN}` };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sf-state-api-"));
    const ipcSock = join(tmpDir, "frontend.sock");
    daemon = await createFrontendDaemon({ ipcSocketPath: ipcSock, port: 0, token: TEST_TOKEN });

    client = new EngineIpcClient({
      frontendSocketPath: ipcSock,
      repoId: "staterepo",
      repoPath: tmpDir,
      repoName: "State Repo",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client.connect();
    await waitFor(() => daemon.registry.getEngine("staterepo") !== null);
  });

  afterEach(async () => {
    client.close();
    await daemon.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns 404 when state.json is missing", async () => {
    const res = await fetch(
      `http://127.0.0.1:${daemon.port}/repos/staterepo/dashboard/state`,
      { headers: authHeaders },
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("no state");
  });

  it("returns JSON when state.json exists", async () => {
    const dashDir = join(tmpDir, ".sparkflow", "dashboard");
    mkdirSync(dashDir, { recursive: true });
    const stateData = { workflow: "auto-develop", summary: { done: 1, total: 3 } };
    writeFileSync(join(dashDir, "state.json"), JSON.stringify(stateData));

    const res = await fetch(
      `http://127.0.0.1:${daemon.port}/repos/staterepo/dashboard/state`,
      { headers: authHeaders },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as typeof stateData;
    expect(body.workflow).toBe("auto-develop");
    expect(body.summary.done).toBe(1);
  });

  it("returns 404 for unknown repoId", async () => {
    const res = await fetch(
      `http://127.0.0.1:${daemon.port}/repos/unknown/dashboard/state`,
      { headers: authHeaders },
    );
    expect(res.status).toBe(404);
  });
});
