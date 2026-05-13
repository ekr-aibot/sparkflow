import { describe, it, expect, vi } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../../src/runtime/codex.js";
import type { RuntimeContext } from "../../src/runtime/types.js";

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    stepId: "test-step",
    step: { name: "Test", interactive: false },
    runtime: { type: "codex" },
    cwd: process.cwd(),
    env: {},
    interactive: false,
    ...overrides,
  };
}

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  it("fails if the cwd does not exist", async () => {
    const ctx = makeCtx({ cwd: "/tmp/this-path-should-not-exist-hopefully-codex" });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cwd does not exist/);
  });

  it("surfaces a clear error when codex binary is not found (ENOENT)", async () => {
    // Run codex from a PATH that only has our fake empty directory (no codex binary).
    const emptyDir = mkdtempSync(join(tmpdir(), "empty-path-"));
    const origPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      const ctx = makeCtx({ prompt: "hello" });
      const result = await adapter.run(ctx);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/codex CLI not found|ENOENT/i);
    } finally {
      process.env.PATH = origPath;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 10000);
});

// Fake codex binary helpers
function mkFakeCodex(turns: string[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const scriptPath = join(dir, "codex");
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ idx: 0 }));

  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('fs');
const statePath = ${JSON.stringify(statePath)};
// Real codex exec reads until EOF. This blocks until stdin is closed.
const input = fs.readFileSync(0, 'utf8');
const turns = ${JSON.stringify(turns)};

let state = { idx: 0 };
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
} catch {}

const response = turns[state.idx] ?? '';
state.idx++;
fs.writeFileSync(statePath, JSON.stringify(state));

// Emit thread.started
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-session-001' }) + '\\n');

// Emit assistant_message (or item.completed)
process.stdout.write(JSON.stringify({
  type: 'assistant_message',
  content: response,
  session_id: 'fake-session-001',
}) + '\\n');

// Emit result or turn.completed
process.stdout.write(JSON.stringify({
  type: 'result',
  session_id: 'fake-session-001',
}) + '\\n');
`,
    { mode: 0o755 }
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true }) };
}

async function withFakeCodex<T>(turns: string[], fn: () => Promise<T>): Promise<T> {
  const { dir, cleanup } = mkFakeCodex(turns);
  const origPath = process.env.PATH;
  process.env.PATH = `${dir}:${origPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = origPath;
    cleanup();
  }
}

describe("CodexAdapter with fake binary", () => {
  const adapter = new CodexAdapter();

  it("runs a prompt and captures the assistant response", async () => {
    const result = await withFakeCodex(
      ['{"answer": "forty-two"}'],
      () => adapter.run(makeCtx({
        prompt: "What is the answer?",
        step: {
          name: "Test",
          interactive: false,
          outputs: { answer: { type: "text" } },
        },
      }))
    );
    expect(result.success).toBe(true);
    expect(result.outputs.answer).toBe("forty-two");
  }, 15000);

  it("captures session_id from event stream", async () => {
    const result = await withFakeCodex(
      ["hello"],
      () => adapter.run(makeCtx({ prompt: "hi" }))
    );
    expect(result.sessionId).toBe("fake-session-001");
  }, 15000);

  it("logs the resolved cwd", async () => {
    const info = vi.fn();
    await withFakeCodex(["done"], () =>
      adapter.run(makeCtx({ prompt: "hi", logger: { info } as any }))
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`cwd=`));
  }, 15000);

  it("extracts JSON outputs from assistant_message", async () => {
    const result = await withFakeCodex(
      ['{"approved": true, "review": "LGTM"}'],
      () => adapter.run(makeCtx({
        prompt: "Review",
        step: {
          name: "Reviewer",
          interactive: false,
          outputs: {
            approved: { type: "json" },
            review: { type: "json" },
          },
        },
      }))
    );
    expect(result.success).toBe(true);
    expect(result.outputs.approved).toBe(true);
    expect(result.outputs.review).toBe("LGTM");
  }, 15000);

  it("handles manual nudges via nudgeQueue", async () => {
    const nudgeQueue = [{ id: "nudge-1", message: "Keep going" }];
    const result = await withFakeCodex(
      ["First response", "Nudged response"],
      () => adapter.run(makeCtx({
        prompt: "Start",
        nudgeQueue: nudgeQueue as any,
      }))
    );
    expect(result.success).toBe(true);
    expect(result.outputs._response).toBe("Nudged response");
  }, 15000);
});

describe("CodexAdapter quota reset parsing", () => {
  const adapter = new CodexAdapter();

  it("populates quotaResetSeconds from stderr 'retry after N seconds' when quotaHit", async () => {
    // Build a fake codex that exits non-zero with a rate-limit message on stderr.
    const dir = mkdtempSync(join(tmpdir(), "fake-codex-quota-"));
    const scriptPath = join(dir, "codex");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
process.stderr.write("rate limit exceeded. Please retry after 60 seconds.\\n");
process.exit(1);
`,
      { mode: 0o755 }
    );
    const origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath ?? ""}`;
    try {
      const result = await adapter.run(makeCtx({ prompt: "do work" }));
      expect(result.success).toBe(false);
      expect(result.quotaHit).toBe(true);
      expect(result.quotaResetSeconds).toBe(60);
    } finally {
      process.env.PATH = origPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
});
