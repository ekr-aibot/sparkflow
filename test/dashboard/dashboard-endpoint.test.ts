import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { createFrontendDaemon } from "../../src/dashboard/frontend-daemon.js";
import { SPARKFLOW_PROTOCOL_VERSION } from "../../src/dashboard/discovery.js";

async function attachEngine(socketPath: string, repoId: string, repoPath: string): Promise<() => void> {
  const sock = createConnection(socketPath);
  await new Promise<void>((res) => sock.on("connect", res));
  sock.write(JSON.stringify({
    type: "attach",
    repoId,
    repoPath,
    protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    version: "0.1.0"
  }) + "\n");
  // Wait for attachAck
  await new Promise<void>((res) => {
    sock.on("data", (data) => {
      if (data.toString().includes("attachAck")) res();
    });
  });
  return () => sock.destroy();
}

describe("Dashboard endpoint integration", () => {
  let tmpDir: string;
  let repoDir: string;
  let sparkflowDir: string;
  let daemon: any;
  const token = "a".repeat(64);

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sf-frontend-test-"));
    repoDir = join(tmpDir, "repo");
    sparkflowDir = join(repoDir, ".sparkflow");
    mkdirSync(sparkflowDir, { recursive: true });

    const socketPath = join(tmpDir, "frontend.sock");
    daemon = await createFrontendDaemon({
      ipcSocketPath: socketPath,
      port: 0,
      token,
    });
  });

  afterEach(async () => {
    if (daemon) await daemon.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns 404 when no engines are attached", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/dashboard?token=${token}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("no dashboard");
  });

  it("returns 404 when engine attached but dashboard.html missing", async () => {
    const detach = await attachEngine(daemon.ipcSocketPath, "repo1", repoDir);
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/dashboard?token=${token}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("no dashboard");
    } finally {
      detach();
    }
  });

  it("returns 200 and content when dashboard.html exists", async () => {
    const content = "<html><body>Dashboard Content</body></html>";
    writeFileSync(join(sparkflowDir, "dashboard.html"), content);

    const detach = await attachEngine(daemon.ipcSocketPath, "repo1", repoDir);
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/dashboard?token=${token}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("last-modified")).toBeTruthy();
      expect(await res.text()).toBe(content);
    } finally {
      detach();
    }
  });

  it("updates Last-Modified when file is updated", async () => {
    const dashPath = join(sparkflowDir, "dashboard.html");
    writeFileSync(dashPath, "v1");

    const detach = await attachEngine(daemon.ipcSocketPath, "repo1", repoDir);
    try {
      const res1 = await fetch(`http://127.0.0.1:${daemon.port}/api/dashboard?token=${token}`);
      const lastMod1 = res1.headers.get("last-modified");

      // Small delay to ensure mtime change is detectable if resolution is low,
      // though utimesSync with explicit past date also works.
      const past = new Date(Date.now() - 10000);
      utimesSync(dashPath, past, past);

      const res2 = await fetch(`http://127.0.0.1:${daemon.port}/api/dashboard?token=${token}`);
      const lastMod2 = res2.headers.get("last-modified");

      expect(lastMod2).not.toBe(lastMod1);
    } finally {
      detach();
    }
  });
});
