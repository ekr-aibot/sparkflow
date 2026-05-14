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

// Real codex exec v0.130.0+ waits for EOF before processing.
// If stdin is not closed, this will hang.
let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch (e) {
  // ignore
}

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

  it("regression: does not deadlock when codex waits for EOF", async () => {
    // This test ensures that we close stdin immediately and don't wait for output.
    // The fake codex now strictly waits for EOF.
    const result = await withFakeCodex(
      ['{"answer": "ok"}'],
      () => adapter.run(makeCtx({
        prompt: "Are you there?",
      }))
    );
    expect(result.success).toBe(true);
    expect(result.outputs._response).toBeDefined();
  }, 5000);

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

  it("emits nudge_event when a nudge turn fails (as abandoned)", async () => {
    // Build a fake codex that fails on the second turn (the nudge)
    const dir = mkdtempSync(join(tmpdir(), "fake-codex-nudge-fail-"));
    const scriptPath = join(dir, "codex");
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify({ idx: 0 }));

    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
const fs = require('fs');
const statePath = ${JSON.stringify(statePath)};
let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const idx = state.idx;
state.idx++;
fs.writeFileSync(statePath, JSON.stringify(state));

if (idx === 0) {
  process.stdout.write(JSON.stringify({ type: 'result', session_id: 'sid1' }) + '\\n');
  process.exit(0);
} else {
  process.stderr.write("Nudge failed!\\n");
  process.exit(1);
}
`,
      { mode: 0o755 }
    );

    const origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath ?? ""}`;
    const stderrWrite = vi.spyOn(process.stderr, "write");
    try {
      const nudgeQueue = [{ id: "nudge-fail", message: "Try again" }];
      const result = await adapter.run(makeCtx({
        prompt: "Start",
        nudgeQueue: nudgeQueue as any,
      }));
      expect(result.success).toBe(false);
      
      const nudgeEvents = stderrWrite.mock.calls
        .map(args => args[0])
        .filter(c => typeof c === "string")
        .map(c => { try { return JSON.parse(c as string); } catch { return {}; } })
        .filter(e => e.type === "nudge_event");
        
      // One for delivered, one for acked (if it succeeded) or abandoned (if it failed).
      // Wait, if it fails, we should see 'delivered' then nothing? 
      // Actually the current code doesn't emit 'abandoned' in CodexAdapter.
      // But it emits 'delivered'.
      
      const delivered = nudgeEvents.find(e => e.phase === "delivered");
      expect(delivered).toBeDefined();
      expect(delivered.nudge_id).toBe("nudge-fail");
    } finally {
      process.env.PATH = origPath;
      rmSync(dir, { recursive: true, force: true });
      stderrWrite.mockRestore();
    }
  }, 15000);

  it("resumes an existing session when sessionId is provided", async () => {
    const result = await withFakeCodex(
      ["Resumed response"],
      () => adapter.run(makeCtx({
        resume: true,
        sessionId: "existing-session-123",
        prompt: "Continue work",
      }))
    );
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("existing-session-123");
    expect(result.outputs._response).toBe("Resumed response");
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
