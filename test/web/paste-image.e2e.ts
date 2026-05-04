import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startWebServer, type WebServerHandle } from "./server-fixture.js";

// Minimal 1×1 grayscale PNG (67 bytes).
// Structure: PNG sig (8) + IHDR (25) + IDAT (22) + IEND (12)
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a" +          // PNG signature
  "0000000d49484452" +          // IHDR length + type
  "00000001" +                  // width = 1
  "00000001" +                  // height = 1
  "08" +                        // bit depth = 8
  "00" +                        // color type = 0 (grayscale)
  "000000" +                    // compression, filter, interlace
  "3a7e9b55" +                  // IHDR CRC
  "0000000a49444154" +          // IDAT length + type
  "789c6260000000020001" +      // zlib-compressed pixel data
  "e221bc33" +                  // IDAT CRC
  "0000000049454e44" +          // IEND length + type
  "ae426082",                   // IEND CRC
  "hex",
);

let server: WebServerHandle;
let repoId: string;

test.beforeAll(async () => {
  server = await startWebServer();
  // Discover the attached engine's repoId from /repos.
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
const pasteUrl = () => `${httpBase()}/repos/${repoId}/paste-image`;

test("POST /repos/:repoId/paste-image with valid PNG returns 200 and saves file", async () => {
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { Cookie: cookieHeader(), "Content-Type": "image/png" },
    body: TINY_PNG,
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { relpath: string; bytes: number };
  expect(body.relpath).toMatch(/^\.sparkflow\/pasted\/.*\.png$/);
  expect(body.bytes).toBe(TINY_PNG.byteLength);
  expect(existsSync(join(server.cwd, body.relpath))).toBe(true);
});

test("POST /repos/:repoId/paste-image with unsupported MIME type returns 415", async () => {
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { Cookie: cookieHeader(), "Content-Type": "text/plain" },
    body: Buffer.from("hello"),
  });
  expect(res.status).toBe(415);
  const body = await res.json() as { error: string };
  expect(body.error).toContain("text/plain");
});

test("POST /repos/:repoId/paste-image with body over 10 MiB returns 413", async () => {
  const bigBody = Buffer.alloc(11 * 1024 * 1024, 0);
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { Cookie: cookieHeader(), "Content-Type": "image/png" },
    body: bigBody,
  });
  expect(res.status).toBe(413);
});

test("POST /repos/:repoId/paste-image without auth returns 401", async () => {
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: TINY_PNG,
  });
  expect(res.status).toBe(401);
});

test("POST /repos/:repoId/paste-image with jpeg returns 200 and .jpg extension", async () => {
  // Minimal JPEG magic bytes (server doesn't validate structure, only MIME type)
  const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const res = await fetch(pasteUrl(), {
    method: "POST",
    headers: { Cookie: cookieHeader(), "Content-Type": "image/jpeg" },
    body: tinyJpeg,
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { relpath: string; bytes: number };
  expect(body.relpath).toMatch(/\.jpg$/);
});
