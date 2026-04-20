import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter } from "../../src/runtime/claude-code.js";
import { NudgeQueue } from "../../src/runtime/types.js";
import type { RuntimeContext } from "../../src/runtime/types.js";

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    stepId: "test-step",
    step: { name: "Test", interactive: false },
    runtime: { type: "claude-code" },
    cwd: process.cwd(),
    env: {},
    interactive: false,
    ...overrides,
  };
}

describe("NudgeQueue", () => {
  it("push and shift work FIFO", () => {
    const q = new NudgeQueue();
    q.push("first");
    q.push("second");
    expect(q.shift()).toBe("first");
    expect(q.shift()).toBe("second");
    expect(q.shift()).toBeUndefined();
  });

  it("drain empties the queue and returns all messages in order", () => {
    const q = new NudgeQueue();
    q.push("a");
    q.push("b");
    q.push("c");
    const drained = q.drain();
    expect(drained).toEqual(["a", "b", "c"]);
    expect(q.shift()).toBeUndefined();
  });

  it("drain on empty queue returns empty array", () => {
    const q = new NudgeQueue();
    expect(q.drain()).toEqual([]);
  });
});

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  it("logs the resolved cwd", async () => {
    // We mock statSync to ensure the directory exists for this test,
    // since we want to reach the logger part.
    // However, since we're actually running in a real env, it should exist.
    const info = vi.fn();
    const ctx = makeCtx({ logger: { info } as any });
    // This might fail to spawn 'claude' but the logger call happens before spawn.
    try {
      await adapter.run(ctx);
    } catch {
      // ignore spawn errors
    }
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`cwd=${ctx.cwd}`));
  });

  it("fails if the cwd does not exist", async () => {
    const ctx = makeCtx({ cwd: "/tmp/this-path-should-not-exist-hopefully-claude" });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cwd does not exist/);
  });

  describe("isTokenLimitError", () => {
    it("detects error_max_turns subtype", () => {
      const parsed = { is_error: true, subtype: "error_max_turns", result: "" };
      expect(adapter.isTokenLimitError(parsed, "")).toBe(true);
    });

    it("detects context length exceeded in result text", () => {
      const parsed = { is_error: true, subtype: "other", result: "context length exceeded" };
      expect(adapter.isTokenLimitError(parsed, "")).toBe(true);
    });

    it("detects context window exceeded in result text", () => {
      const parsed = { is_error: true, subtype: "other", result: "context window exceeded" };
      expect(adapter.isTokenLimitError(parsed, "")).toBe(true);
    });

    it("detects context_length_exceeded in result text", () => {
      const parsed = { is_error: true, subtype: "other", result: "context_length_exceeded" };
      expect(adapter.isTokenLimitError(parsed, "")).toBe(true);
    });

    it("detects context length exceeded in stderr", () => {
      expect(adapter.isTokenLimitError(null, "Error: context length exceeded")).toBe(true);
    });

    it("detects too many tokens in stderr", () => {
      expect(adapter.isTokenLimitError(null, "too many tokens in request")).toBe(true);
    });

    it("returns false for non-error result events", () => {
      const parsed = { is_error: false, subtype: "success", result: "done" };
      expect(adapter.isTokenLimitError(parsed, "")).toBe(false);
    });

    it("returns false for generic errors", () => {
      const parsed = { is_error: true, subtype: "other_error", result: "something went wrong" };
      expect(adapter.isTokenLimitError(parsed, "some unrelated error")).toBe(false);
    });

    it("returns false when parsed is null and stderr has no token keywords", () => {
      expect(adapter.isTokenLimitError(null, "exit code 1")).toBe(false);
    });
  });
});
