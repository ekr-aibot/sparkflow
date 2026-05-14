import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFrontendDaemon, type FrontendDaemonHandle } from "../../src/dashboard/frontend-daemon.js";
import { EngineIpcClient } from "../../src/dashboard/engine-ipc-client.js";
import { SPARKFLOW_VERSION, SPARKFLOW_PROTOCOL_VERSION } from "../../src/dashboard/discovery.js";

const TEST_TOKEN = "d".repeat(64);

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("Dashboard SPA static asset serving", () => {
  let tmpDir: string;
  let daemon: FrontendDaemonHandle;
  let client: EngineIpcClient;
  const authHeaders = { Cookie: `sf_token=${TEST_TOKEN}` };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sf-spa-assets-"));
    const ipcSock = join(tmpDir, "frontend.sock");
    daemon = await createFrontendDaemon({ ipcSocketPath: ipcSock, port: 0, token: TEST_TOKEN });

    client = new EngineIpcClient({
      frontendSocketPath: ipcSock,
      repoId: "sparepo",
      repoPath: tmpDir,
      repoName: "SPA Repo",
      mcpSocket: join(tmpDir, "mcp.sock"),
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client.connect();
    await waitFor(() => daemon.registry.getEngine("sparepo") !== null);

    // Set up .sparkflow/dashboard/ with SPA files
    const dashDir = join(tmpDir, ".sparkflow", "dashboard");
    mkdirSync(dashDir, { recursive: true });
    writeFileSync(join(dashDir, "index.html"), "<html><body>SPA Index</body></html>");
    writeFileSync(join(dashDir, "app.js"), "console.log('app')");
    writeFileSync(join(dashDir, "style.css"), "body { background: #000; }");
  });

  afterEach(async () => {
    client.close();
    await daemon.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("GET /repos/:repoId/dashboard returns index.html from SPA directory", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/repos/sparepo/dashboard`, { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("SPA Index");
  });

  it("GET /repos/:repoId/dashboard/app.js returns JavaScript", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/repos/sparepo/dashboard/app.js`, { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain("console.log");
  });

  it("GET /repos/:repoId/dashboard/style.css returns CSS", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/repos/sparepo/dashboard/style.css`, { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("css");
  });

  it("returns 404 for path traversal attempts", async () => {
    const res = await fetch(
      `http://127.0.0.1:${daemon.port}/repos/sparepo/dashboard/../../etc/passwd`,
      { headers: authHeaders },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for nonexistent files", async () => {
    const res = await fetch(
      `http://127.0.0.1:${daemon.port}/repos/sparepo/dashboard/nonexistent.js`,
      { headers: authHeaders },
    );
    expect(res.status).toBe(404);
  });

  it("falls back to legacy dashboard.html when SPA index.html is absent", async () => {
    // Set up a second repo without SPA directory
    const tmpDir2 = mkdtempSync(join(tmpdir(), "sf-legacy-"));
    try {
      mkdirSync(join(tmpDir2, ".sparkflow"), { recursive: true });
      writeFileSync(join(tmpDir2, ".sparkflow", "dashboard.html"), "<html>Legacy</html>");

      const client2 = new EngineIpcClient({
        frontendSocketPath: join(tmpDir, "frontend.sock"),
        repoId: "legacyrepo",
        repoPath: tmpDir2,
        repoName: "Legacy Repo",
        mcpSocket: join(tmpDir2, "mcp.sock"),
        version: SPARKFLOW_VERSION,
        protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
      });
      await client2.connect();
      await waitFor(() => daemon.registry.getEngine("legacyrepo") !== null);

      try {
        const res = await fetch(`http://127.0.0.1:${daemon.port}/repos/legacyrepo/dashboard`, { headers: authHeaders });
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("Legacy");
      } finally {
        client2.close();
      }
    } finally {
      try { rmSync(tmpDir2, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("returns 404 when neither SPA nor legacy dashboard exists", async () => {
    // Set up a repo with no dashboard files
    const tmpDir3 = mkdtempSync(join(tmpdir(), "sf-nodash-"));
    try {
      mkdirSync(join(tmpDir3, ".sparkflow"), { recursive: true });

      const client3 = new EngineIpcClient({
        frontendSocketPath: join(tmpDir, "frontend.sock"),
        repoId: "nodashrepo",
        repoPath: tmpDir3,
        repoName: "No Dash Repo",
        mcpSocket: join(tmpDir3, "mcp.sock"),
        version: SPARKFLOW_VERSION,
        protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
      });
      await client3.connect();
      await waitFor(() => daemon.registry.getEngine("nodashrepo") !== null);

      try {
        const res = await fetch(`http://127.0.0.1:${daemon.port}/repos/nodashrepo/dashboard`, { headers: authHeaders });
        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body).toBe("no dashboard");
      } finally {
        client3.close();
      }
    } finally {
      try { rmSync(tmpDir3, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
