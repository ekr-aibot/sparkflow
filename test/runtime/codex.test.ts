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
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
const turns = ${JSON.stringify(turns)};
let idx = 0;
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === 'user_input') {
      const text = turns[idx++] ?? '';
      // Emit assistant_message event with session_id
      process.stdout.write(JSON.stringify({
        type: 'assistant_message',
        content: text,
        session_id: 'fake-session-001',
      }) + '\\n');
      // Emit result to signal turn end
      process.stdout.write(JSON.stringify({
        type: 'result',
        session_id: 'fake-session-001',
      }) + '\\n');
    }
  } catch {}
});
rl.on('close', () => process.exit(0));
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

  it("self-nudges when success_output gate output is absent in turn 1", async () => {
    const selfNudgeLogs: string[] = [];
    const result = await withFakeCodex(
      ["Some prose without JSON.", '{"approved": true}'],
      () => adapter.run(makeCtx({
        prompt: "Review the code",
        step: {
          name: "Reviewer",
          interactive: false,
          success_output: "approved",
          outputs: { approved: { type: "json" } },
        },
        logger: {
          info: (msg: string) => {
            if (msg.includes("self-nudge")) selfNudgeLogs.push(msg);
          },
        } as any,
      }))
    );
    expect(result.success).toBe(true);
    expect(result.outputs.approved).toBe(true);
    expect(selfNudgeLogs).toHaveLength(1);
  }, 15000);

  it("does NOT self-nudge when step has no success_output", async () => {
    const selfNudgeLogs: string[] = [];
    const result = await withFakeCodex(
      ["Just prose."],
      () => adapter.run(makeCtx({
        prompt: "Do something",
        step: { name: "Plain", interactive: false },
        logger: {
          info: (msg: string) => {
            if (msg.includes("self-nudge")) selfNudgeLogs.push(msg);
          },
        } as any,
      }))
    );
    expect(result.success).toBe(true);
    expect(selfNudgeLogs).toHaveLength(0);
  }, 15000);

  it("extracts JSON outputs from assistant message", async () => {
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
});

