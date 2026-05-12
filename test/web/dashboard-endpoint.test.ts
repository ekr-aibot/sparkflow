import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTasks, buildDashboardHtml } from "../../src/cli/dashboard.js";

// The /api/dashboard handler logic from server.ts — extracted so it can be
// integration-tested without spinning up the full sparkflow supervisor stack.
function createDashboardServer(cwd: string): ReturnType<typeof createServer> {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const dashPath = join(cwd, ".sparkflow", "dashboard.html");
    try {
      const body = readFileSync(dashPath);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.byteLength,
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no dashboard");
    }
  });
}

async function startServer(cwd: string): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createDashboardServer(cwd);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  const stop = () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
  return { port, stop };
}

describe("/api/dashboard endpoint", () => {
  let tmpDir: string;
  let sparkflowDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-dash-ep-"));
    sparkflowDir = join(tmpDir, ".sparkflow");
    mkdirSync(sparkflowDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns 404 when dashboard.html does not exist", async () => {
    const { port, stop } = await startServer(tmpDir);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toBe("no dashboard");
    } finally {
      await stop();
    }
  });

  it("returns 200 with text/html when dashboard.html exists", async () => {
    writeFileSync(join(sparkflowDir, "dashboard.html"), "<html><body>hello</body></html>", "utf-8");
    const { port, stop } = await startServer(tmpDir);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("hello");
    } finally {
      await stop();
    }
  });

  it("serves the exact bytes written to dashboard.html", async () => {
    const content = "<html><body>exact content ✓</body></html>";
    writeFileSync(join(sparkflowDir, "dashboard.html"), content, "utf-8");
    const { port, stop } = await startServer(tmpDir);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      expect(await res.text()).toBe(content);
    } finally {
      await stop();
    }
  });

  it("round-trip: sparkflow-dashboard output is served correctly", async () => {
    // Write a ROADMAP.md, generate the dashboard HTML via the same functions
    // the CLI uses, then verify the endpoint serves it.
    writeFileSync(join(tmpDir, "ROADMAP.md"), [
      "- [x] first task done",
      "- [ ] second task pending",
      "- [!] third task blocked <!-- blocked: needs review -->",
    ].join("\n"), "utf-8");

    const tasks = parseTasks(readFileSync(join(tmpDir, "ROADMAP.md"), "utf-8"));
    const html = buildDashboardHtml(tasks, new Date(), true);
    writeFileSync(join(sparkflowDir, "dashboard.html"), html, "utf-8");

    const { port, stop } = await startServer(tmpDir);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("1/3");
      expect(body).toContain("first task done");
      expect(body).toContain("second task pending");
      expect(body).toContain("needs review");
    } finally {
      await stop();
    }
  });

  it("returns 404 again after dashboard.html is removed", async () => {
    const dashPath = join(sparkflowDir, "dashboard.html");
    writeFileSync(dashPath, "<html>temp</html>", "utf-8");
    const { port, stop } = await startServer(tmpDir);
    try {
      const first = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      expect(first.status).toBe(200);

      rmSync(dashPath);

      const second = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      expect(second.status).toBe(404);
    } finally {
      await stop();
    }
  });
});
