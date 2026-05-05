import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFrontendDaemon, type FrontendDaemonHandle } from "../../src/dashboard/frontend-daemon.js";
import { EngineIpcClient } from "../../src/dashboard/engine-ipc-client.js";
import { SPARKFLOW_VERSION, SPARKFLOW_PROTOCOL_VERSION } from "../../src/dashboard/discovery.js";

const TEST_TOKEN = "b".repeat(64);

describe("GET /repos/:repoId/pasted/:filename", () => {
  let tmpDir: string;
  let daemon: FrontendDaemonHandle;
  let client: EngineIpcClient;
  const baseUrl = () => `http://127.0.0.1:${daemon.port}`;
  const authedHeaders = { Cookie: `sf_token=${TEST_TOKEN}` };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-paste-serve-test-"));
    const ipcSock = join(tmpDir, "frontend.sock");
    daemon = await createFrontendDaemon({ ipcSocketPath: ipcSock, port: 0, token: TEST_TOKEN });

    const engineSock = join(tmpDir, "mcp.sock");
    client = new EngineIpcClient({
      frontendSocketPath: ipcSock,
      repoId: "testrepo",
      repoPath: tmpDir,
      repoName: "Test Repo",
      mcpSocket: engineSock,
      version: SPARKFLOW_VERSION,
      protocolVersion: SPARKFLOW_PROTOCOL_VERSION,
    });
    await client.connect();

    client.on("command", (msg: { type: string; id?: string }) => {
      if (msg.id && msg.type === "ping") client.sendPong(msg.id);
    });

    // Create the pasted directory with a test image.
    const pastedDir = join(tmpDir, ".sparkflow", "pasted");
    mkdirSync(pastedDir, { recursive: true });
    // Minimal 1×1 PNG (67 bytes).
    const minimalPng = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000000100000001080000000003a" +
      "7e23c000000100494441540878016360000000020001e221bc330000000049454e44ae426082",
      "hex",
    );
    writeFileSync(join(pastedDir, "test-image.png"), minimalPng);
  });

  afterEach(async () => {
    client.close();
    await daemon.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns 200 with correct Content-Type and bytes for an existing png", async () => {
    const res = await fetch(`${baseUrl()}/repos/testrepo/pasted/test-image.png`, {
      headers: authedHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it("returns correct Content-Type for .jpg", async () => {
    const pastedDir = join(tmpDir, ".sparkflow", "pasted");
    writeFileSync(join(pastedDir, "photo.jpg"), Buffer.from("fake-jpeg-bytes"));
    const res = await fetch(`${baseUrl()}/repos/testrepo/pasted/photo.jpg`, {
      headers: authedHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("returns correct Content-Type for .jpeg", async () => {
    const pastedDir = join(tmpDir, ".sparkflow", "pasted");
    writeFileSync(join(pastedDir, "photo.jpeg"), Buffer.from("fake-jpeg-bytes"));
    const res = await fetch(`${baseUrl()}/repos/testrepo/pasted/photo.jpeg`, {
      headers: authedHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("returns 404 when the file does not exist", async () => {
    const res = await fetch(`${baseUrl()}/repos/testrepo/pasted/no-such-file.png`, {
      headers: authedHeaders,
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a filename with ..  (path traversal)", async () => {
    const res = await fetch(`${baseUrl()}/repos/testrepo/pasted/..%2Fetc%2Fpasswd`, {
      headers: authedHeaders,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a filename with a disallowed extension", async () => {
    const res = await fetch(`${baseUrl()}/repos/testrepo/pasted/script.exe`, {
      headers: authedHeaders,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a filename with no extension", async () => {
    const res = await fetch(`${baseUrl()}/repos/testrepo/pasted/noextension`, {
      headers: authedHeaders,
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 when no token is provided", async () => {
    const res = await fetch(`${baseUrl()}/repos/testrepo/pasted/test-image.png`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown repoId", async () => {
    const res = await fetch(`${baseUrl()}/repos/unknownrepo/pasted/test-image.png`, {
      headers: authedHeaders,
    });
    expect(res.status).toBe(404);
  });

  it("sets cache-control header", async () => {
    const res = await fetch(`${baseUrl()}/repos/testrepo/pasted/test-image.png`, {
      headers: authedHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
  });
});
