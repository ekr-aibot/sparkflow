import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startWebServer, type WebServerHandle } from "./server-fixture.js";

// Minimal 1×1 PNG (67 bytes)
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
  "2e00000000c4944415408d7636060600000000200013491b04000000049454" +
  "4e44ae426082",
  "hex",
);

let server: WebServerHandle;
let repoId: string;

test.beforeAll(async () => {
  server = await startWebServer();
  const res = await fetch(`http://127.0.0.1:${server.port}/repos`, {
    headers: { Cookie: `sf_token=${server.token}` },
  });
  const body = await res.json() as { repos: Array<{ repoId: string }> };
  repoId = body.repos[0].repoId;
});

test.afterAll(async () => {
  if (server) await server.stop();
});

const cookieHeader = () => `sf_token=${server.token}`;
const httpBase = () => `http://127.0.0.1:${server.port}`;
const pasteUrl = () => `${httpBase()}/repos/${encodeURIComponent(repoId)}/paste-image`;

test("POST /repos/:repoId/paste-image with image/png returns 200 with relpath and saves file", async () => {
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { Cookie: cookieHeader(), "Content-Type": "image/png" },
    body: TINY_PNG,
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { relpath: string; bytes: number };
  expect(typeof body.relpath).toBe("string");
  expect(body.relpath.startsWith(".sparkflow/pasted/")).toBe(true);
  expect(body.relpath.endsWith(".png")).toBe(true);
  expect(body.bytes).toBe(TINY_PNG.byteLength);
  expect(existsSync(join(server.cwd, body.relpath))).toBe(true);
});

test("POST /repos/:repoId/paste-image with image/jpeg returns 200 with .jpg extension", async () => {
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { Cookie: cookieHeader(), "Content-Type": "image/jpeg" },
    body: Buffer.from([0xff, 0xd8, 0xff]),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { relpath: string; bytes: number };
  expect(body.relpath.endsWith(".jpg")).toBe(true);
});

test("POST /repos/:repoId/paste-image with text/plain returns 415", async () => {
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { Cookie: cookieHeader(), "Content-Type": "text/plain" },
    body: Buffer.from("hello"),
  });
  expect(res.status).toBe(415);
  const body = await res.json() as { error: string };
  expect(body.error).toContain("unsupported image type");
});

test("POST /repos/:repoId/paste-image with image/svg+xml returns 415", async () => {
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { Cookie: cookieHeader(), "Content-Type": "image/svg+xml" },
    body: Buffer.from("<svg/>"),
  });
  expect(res.status).toBe(415);
});

test("POST /repos/:repoId/paste-image with body over 10 MiB returns 413", async () => {
  const bigBody = Buffer.alloc(11 * 1024 * 1024, 0);
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { Cookie: cookieHeader(), "Content-Type": "image/png" },
    body: bigBody,
  });
  expect(res.status).toBe(413);
  const body = await res.json() as { error: string };
  expect(body.error).toContain("too large");
});

test("POST /repos/:repoId/paste-image without token returns 401", async () => {
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: TINY_PNG,
  });
  expect(res.status).toBe(401);
});

test("POST /repos/:repoId/paste-image with unknown repoId returns 404", async () => {
  const res = await fetch(`${httpBase()}/repos/unknownrepo/paste-image`, {
    method: "POST",
    headers: { Cookie: cookieHeader(), "Content-Type": "image/png" },
    body: TINY_PNG,
  });
  expect(res.status).toBe(404);
});
