import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { startWebServer, type WebServerHandle } from "./server-fixture.js";

let server: WebServerHandle;

test.beforeAll(async () => {
  server = await startWebServer();
});

test.afterAll(async () => {
  if (server) await server.stop();
});

const cookieHeader = () => `sf_token=${server.token}`;
const httpBase = () => `http://127.0.0.1:${server.port}`;

// Helper: get the first repoId from /repos
async function getRepoId(): Promise<string> {
  const res = await fetch(`${httpBase()}/repos`, { headers: { Cookie: cookieHeader() } });
  const body = await res.json() as { repos: Array<{ repoId: string }> };
  const repoId = body.repos[0]?.repoId;
  if (!repoId) throw new Error("No repo attached");
  return repoId;
}

// Helper: open a WS to /chat with a chatId
function openChatWs(repoId: string, chatId?: string): Promise<WebSocket> {
  const qs = new URLSearchParams({ token: server.token, repoId });
  if (chatId) qs.set("chatId", chatId);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/chat?${qs}`);
  return new Promise((res, rej) => {
    ws.once("open", () => res(ws));
    ws.once("error", (err) => rej(err));
  });
}

function nextMessage(ws: WebSocket, predicate?: (msg: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      rej(new Error("Timed out waiting for WS message"));
    }, timeoutMs);
    const onMsg = (raw: WebSocket.RawData) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      if (predicate && !predicate(parsed)) return;
      clearTimeout(timer);
      ws.off("message", onMsg);
      res(parsed);
    };
    ws.on("message", onMsg);
  });
}

// ---- /repos/:repoId/chats ----

test("GET /repos/:repoId/chats returns main chat entry", async () => {
  const repoId = await getRepoId();
  const res = await fetch(`${httpBase()}/repos/${repoId}/chats`, { headers: { Cookie: cookieHeader() } });
  expect(res.status).toBe(200);
  const list = await res.json() as Array<{ chatId: string; kind: string; tool: string }>;
  expect(Array.isArray(list)).toBe(true);
  const main = list.find((c) => c.chatId === "main");
  expect(main).toBeDefined();
  expect(main?.kind).toBe("main");
});

test("POST /repos/:repoId/chats creates a side-chat and returns chatId", async () => {
  const repoId = await getRepoId();
  const res = await fetch(`${httpBase()}/repos/${repoId}/chats`, {
    method: "POST",
    headers: { Cookie: cookieHeader(), "content-type": "application/json" },
    body: JSON.stringify({ tool: "claude" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { chatId: string; kind: string; tool: string };
  expect(typeof body.chatId).toBe("string");
  expect(body.chatId).toMatch(/^sidechat-\d+$/);
  expect(body.kind).toBe("sidechat");
  expect(body.tool).toBe("claude");

  // Cleanup
  await fetch(`${httpBase()}/repos/${repoId}/chats/${body.chatId}`, {
    method: "DELETE",
    headers: { Cookie: cookieHeader() },
  });
});

test("Two POST requests return different chatIds", async () => {
  const repoId = await getRepoId();
  const r1 = await fetch(`${httpBase()}/repos/${repoId}/chats`, {
    method: "POST",
    headers: { Cookie: cookieHeader(), "content-type": "application/json" },
    body: JSON.stringify({ tool: "claude" }),
  });
  const r2 = await fetch(`${httpBase()}/repos/${repoId}/chats`, {
    method: "POST",
    headers: { Cookie: cookieHeader(), "content-type": "application/json" },
    body: JSON.stringify({ tool: "claude" }),
  });
  const b1 = await r1.json() as { chatId: string };
  const b2 = await r2.json() as { chatId: string };
  expect(b1.chatId).not.toBe(b2.chatId);

  // Cleanup
  for (const cid of [b1.chatId, b2.chatId]) {
    await fetch(`${httpBase()}/repos/${repoId}/chats/${cid}`, {
      method: "DELETE",
      headers: { Cookie: cookieHeader() },
    });
  }
});

test("WS /chat?chatId=<sidechat> receives data after POST", async () => {
  const repoId = await getRepoId();
  const res = await fetch(`${httpBase()}/repos/${repoId}/chats`, {
    method: "POST",
    headers: { Cookie: cookieHeader(), "content-type": "application/json" },
    body: JSON.stringify({ tool: "claude" }),
  });
  const { chatId } = await res.json() as { chatId: string };

  const ws = await openChatWs(repoId, chatId);
  try {
    // The fake-chat fixture writes SF_TEST_READY on start; the side-chat
    // (bare spawn, no --mcp-config) should NOT emit SF_SAW_CLAUDE_FLAGS.
    const msg = await nextMessage(ws, (m) => m.type === "data" && typeof m.bytes === "string");
    const decoded = Buffer.from(msg.bytes as string, "base64").toString("utf-8");
    expect(decoded).toContain("SF_TEST_READY");
    expect(decoded).not.toContain("SF_SAW_CLAUDE_FLAGS=1");
  } finally {
    ws.close();
    await fetch(`${httpBase()}/repos/${repoId}/chats/${chatId}`, {
      method: "DELETE",
      headers: { Cookie: cookieHeader() },
    });
  }
});

test("DELETE /repos/:repoId/chats/:chatId closes the side-chat", async () => {
  const repoId = await getRepoId();
  const res = await fetch(`${httpBase()}/repos/${repoId}/chats`, {
    method: "POST",
    headers: { Cookie: cookieHeader(), "content-type": "application/json" },
    body: JSON.stringify({ tool: "claude" }),
  });
  const { chatId } = await res.json() as { chatId: string };

  const ws = await openChatWs(repoId, chatId);
  try {
    // Drain the ring buffer
    await nextMessage(ws, (m) => m.type === "data");

    // Listen for chat_ended before sending DELETE
    const endedPromise = nextMessage(ws, (m) => m.type === "chat_ended", 8000);

    const del = await fetch(`${httpBase()}/repos/${repoId}/chats/${chatId}`, {
      method: "DELETE",
      headers: { Cookie: cookieHeader() },
    });
    expect(del.status).toBe(200);

    // Should receive chat_ended on the WS
    await endedPromise;
  } finally {
    ws.close();
  }
});

test("DELETE /repos/:repoId/chats/main returns 400", async () => {
  const repoId = await getRepoId();
  const res = await fetch(`${httpBase()}/repos/${repoId}/chats/main`, {
    method: "DELETE",
    headers: { Cookie: cookieHeader() },
  });
  expect(res.status).toBe(400);
});

test("Spawning more than 8 side-chats returns 429", async () => {
  test.setTimeout(60_000);
  const repoId = await getRepoId();
  const chatIds: string[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${httpBase()}/repos/${repoId}/chats`, {
        method: "POST",
        headers: { Cookie: cookieHeader(), "content-type": "application/json" },
        body: JSON.stringify({ tool: "claude" }),
      });
      expect(r.status).toBe(200);
      const b = await r.json() as { chatId: string };
      chatIds.push(b.chatId);
    }
    // The 9th should be rejected
    const last = await fetch(`${httpBase()}/repos/${repoId}/chats`, {
      method: "POST",
      headers: { Cookie: cookieHeader(), "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude" }),
    });
    expect(last.status).toBe(429);
    const lastBody = await last.json() as { error: string };
    expect(lastBody.error).toMatch(/limit/i);
  } finally {
    for (const cid of chatIds) {
      await fetch(`${httpBase()}/repos/${repoId}/chats/${cid}`, {
        method: "DELETE",
        headers: { Cookie: cookieHeader() },
      });
    }
  }
});

test("WS /chat without chatId still works for main chat", async () => {
  const repoId = await getRepoId();
  const ws = await openChatWs(repoId);
  try {
    const msg = await nextMessage(ws, (m) => m.type === "data" && typeof m.bytes === "string");
    const decoded = Buffer.from(msg.bytes as string, "base64").toString("utf-8");
    expect(decoded).toContain("SF_TEST_READY");
  } finally {
    ws.close();
  }
});
