import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { utimesSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startWebServer } from "./server-fixture.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Waits for a single WS message matching `predicate` and returns its decoded
// bytes payload. Timeboxed to avoid hanging.
async function nextDataBytes(ws: WebSocket, timeoutMs = 4000): Promise<string> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      rej(new Error("Timed out waiting for WS data frame"));
    }, timeoutMs);
    const onMsg = (raw: WebSocket.RawData) => {
      let msg: { type?: string; bytes?: string };
      try { msg = JSON.parse(raw.toString()) as { type?: string; bytes?: string }; } catch { return; }
      if (msg.type !== "data" || typeof msg.bytes !== "string") return;
      clearTimeout(timer);
      ws.off("message", onMsg);
      res(Buffer.from(msg.bytes, "base64").toString("utf-8"));
    };
    ws.on("message", onMsg);
  });
}

async function openChatWs(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", (err) => rej(err));
  });
  return ws;
}

/**
 * Verifies the hot-reload architecture's key property: killing the server
 * child (which happens when dist/src/web/server.js changes in --dev mode)
 * does not tear down the claude PTY — the ring buffer persists and a new
 * browser tab connecting after the restart still sees the pre-restart chat
 * output.
 */
test("dev mode: PTY and ring buffer survive a server child restart", async () => {
  const handle = await startWebServer({ extraArgs: ["--dev"] });
  try {
    // 1. Let fake-chat emit SF_TEST_READY into the PTY, confirmed via WS snapshot.
    const ws1 = await openChatWs(handle.port, handle.token);
    const firstSnapshot = await nextDataBytes(ws1);
    expect(firstSnapshot).toContain("SF_TEST_READY");
    ws1.close();

    // 2. Touch dist/src/web/server.js — this is what the supervisor watches.
    //    Bumping mtime (without a content change) triggers the recursive
    //    fs.watch at the parent, which SIGTERMs the child; the supervisor
    //    respawns it automatically.
    const repoRoot = resolve(__dirname, "..", "..");
    const serverJs = resolve(repoRoot, "dist", "src", "web", "server.js");
    const now = new Date();
    utimesSync(serverJs, now, now);

    // 3. Give the supervisor time to notice, kill, respawn, and re-bind the
    //    HTTP port. The debounce is 80ms; bind is usually <200ms. Retry up to
    //    2s in case the new server isn't ready yet.
    const deadline = Date.now() + 3000;
    let ws2: WebSocket | null = null;
    let secondSnapshot = "";
    while (Date.now() < deadline) {
      try {
        ws2 = await openChatWs(handle.port, handle.token);
        secondSnapshot = await nextDataBytes(ws2);
        break;
      } catch {
        if (ws2) { try { ws2.close(); } catch { /* ignore */ } }
        ws2 = null;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    expect(ws2).not.toBeNull();
    // The key assertion: SF_TEST_READY is still there, because the PTY that
    // produced it was never killed — only the server child was.
    expect(secondSnapshot).toContain("SF_TEST_READY");
    if (ws2) ws2.close();
  } finally {
    await handle.stop();
  }
});
