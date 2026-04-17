import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startWebServer } from "./server-fixture.js";

// Open a WS, drain frames up to a deadline, and return every decoded byte
// as one string so tests can assert on markers inside the ring buffer.
async function collectBytes(port: number, token: string, deadlineMs = 4000): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", (e) => rej(e));
  });
  let collected = "";
  const done = new Promise<string>((res) => {
    const timer = setTimeout(() => { ws.close(); res(collected); }, deadlineMs);
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; bytes?: string };
        if (msg.type === "data" && typeof msg.bytes === "string") {
          collected += Buffer.from(msg.bytes, "base64").toString("utf-8");
          if (collected.includes("SF_TEST_READY")) {
            clearTimeout(timer);
            ws.close();
            res(collected);
          }
        }
      } catch { /* ignore */ }
    });
  });
  return done;
}

test("chat-tool claude: fake-chat sees --mcp-config/--append-system-prompt flags", async () => {
  const server = await startWebServer({ chatTool: "claude" });
  try {
    const bytes = await collectBytes(server.port, server.token);
    expect(bytes).toContain("SF_SAW_CLAUDE_FLAGS=1");
    expect(bytes).not.toContain("SF_SAW_GEMINI_FILES=1");
    expect(bytes).toContain("SF_TEST_READY");
  } finally {
    await server.stop();
  }
});

test("chat-tool gemini: writes .gemini/settings.json + GEMINI.md; no Claude flags leak through", async () => {
  const server = await startWebServer({ chatTool: "gemini" });
  try {
    // While the server is running, the tool-specific files should exist in cwd.
    expect(existsSync(join(server.cwd, ".gemini", "settings.json"))).toBe(true);
    expect(existsSync(join(server.cwd, "GEMINI.md"))).toBe(true);

    const bytes = await collectBytes(server.port, server.token);
    expect(bytes).toContain("SF_SAW_GEMINI_FILES=1");
    expect(bytes).not.toContain("SF_SAW_CLAUDE_FLAGS=1");
    expect(bytes).toContain("SF_TEST_READY");
  } finally {
    await server.stop();
    // After shutdown, our temp files are cleaned up by the TUI's finally block.
    expect(existsSync(join(server.cwd, ".gemini", "settings.json"))).toBe(false);
    expect(existsSync(join(server.cwd, "GEMINI.md"))).toBe(false);
  }
});
