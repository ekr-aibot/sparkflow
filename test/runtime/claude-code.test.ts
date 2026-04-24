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

  describe("isQuotaError", () => {
    it("detects rate limit in result text", () => {
      const parsed = { is_error: true, subtype: "other", result: "Error: rate limit exceeded" };
      expect(adapter.isQuotaError(parsed, "")).toBe(true);
    });

    it("detects usage limit in result text", () => {
      const parsed = { is_error: true, subtype: "other", result: "You have exceeded your usage limit" };
      expect(adapter.isQuotaError(parsed, "")).toBe(true);
    });

    it("detects quota in result text", () => {
      const parsed = { is_error: true, subtype: "other", result: "quota exhausted" };
      expect(adapter.isQuotaError(parsed, "")).toBe(true);
    });

    it("detects overloaded in result text", () => {
      const parsed = { is_error: true, subtype: "other", result: "The API is currently overloaded" };
      expect(adapter.isQuotaError(parsed, "")).toBe(true);
    });

    it("detects 529 in result text", () => {
      const parsed = { is_error: true, subtype: "other", result: "HTTP 529: service overloaded" };
      expect(adapter.isQuotaError(parsed, "")).toBe(true);
    });

    it("detects rate_limit subtype", () => {
      const parsed = { is_error: true, subtype: "rate_limit", result: "" };
      expect(adapter.isQuotaError(parsed, "")).toBe(true);
    });

    it("detects rate limit in stderr", () => {
      expect(adapter.isQuotaError(null, "Error: rate limit exceeded, please retry")).toBe(true);
    });

    it("detects overloaded in stderr", () => {
      expect(adapter.isQuotaError(null, "API overloaded, try again later")).toBe(true);
    });

    it("detects too many requests in stderr", () => {
      expect(adapter.isQuotaError(null, "429 Too Many Requests")).toBe(true);
    });

    it("returns false for non-error result events", () => {
      const parsed = { is_error: false, subtype: "success", result: "done" };
      expect(adapter.isQuotaError(parsed, "")).toBe(false);
    });

    it("returns false for token limit errors", () => {
      const parsed = { is_error: true, subtype: "error_max_turns", result: "context length exceeded" };
      expect(adapter.isQuotaError(parsed, "")).toBe(false);
    });

    it("returns false for generic errors", () => {
      const parsed = { is_error: true, subtype: "other_error", result: "something went wrong" };
      expect(adapter.isQuotaError(parsed, "network timeout")).toBe(false);
    });

    it("returns false when parsed is null and stderr has no quota keywords", () => {
      expect(adapter.isQuotaError(null, "exit code 1")).toBe(false);
    });
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

  describe("extractJsonFromResult", () => {
    it("extracts a flat JSON object from result text", () => {
      const result = adapter.extractJsonFromResult('{"approved": true, "review": "LGTM"}');
      expect(result).toEqual({ approved: true, review: "LGTM" });
    });

    it("returns null for non-JSON text", () => {
      expect(adapter.extractJsonFromResult("some prose output")).toBeNull();
    });

    it("returns null for a JSON array", () => {
      expect(adapter.extractJsonFromResult("[1, 2, 3]")).toBeNull();
    });

    it("returns null for a JSON primitive", () => {
      expect(adapter.extractJsonFromResult('"just a string"')).toBeNull();
    });

    it("handles whitespace around the JSON", () => {
      const result = adapter.extractJsonFromResult('  {"approved": false}  ');
      expect(result).toEqual({ approved: false });
    });

    it("extracts JSON after a prose preamble", () => {
      const result = adapter.extractJsonFromResult(
        'Here is my decision:\n{"action":"file-issue","title":"x"}'
      );
      expect(result).toEqual({ action: "file-issue", title: "x" });
    });

    it("extracts JSON before a prose suffix", () => {
      const result = adapter.extractJsonFromResult(
        '{"approved":true,"review":"LGTM"}\n\nLet me know if you need adjustments.'
      );
      expect(result).toEqual({ approved: true, review: "LGTM" });
    });

    it("ignores `{` and `}` that appear inside quoted string values", () => {
      const result = adapter.extractJsonFromResult(
        '{"msg":"contains } and { chars","ok":true}'
      );
      expect(result).toEqual({ msg: "contains } and { chars", ok: true });
    });

    it("honors backslash-escaped quotes inside strings", () => {
      const result = adapter.extractJsonFromResult(
        '{"msg":"with \\"escaped\\" quote"}'
      );
      expect(result).toEqual({ msg: 'with "escaped" quote' });
    });

    it("handles nested objects when embedded in prose", () => {
      const result = adapter.extractJsonFromResult(
        'decision follows:\n{"action":"redispatch","meta":{"retry":1}}\ndone.'
      );
      expect(result).toEqual({ action: "redispatch", meta: { retry: 1 } });
    });

    it("strips a ```json code fence wrapper", () => {
      const result = adapter.extractJsonFromResult(
        '```json\n{"approved":true}\n```'
      );
      expect(result).toEqual({ approved: true });
    });

    it("returns the first JSON object when multiple are present", () => {
      const result = adapter.extractJsonFromResult(
        '{"a":1}\n\nsecond thought: {"a":2}'
      );
      expect(result).toEqual({ a: 1 });
    });

    it("returns null when the text contains no complete JSON object", () => {
      expect(
        adapter.extractJsonFromResult('prose only { with an opening brace')
      ).toBeNull();
    });

    it("returns null for empty input", () => {
      expect(adapter.extractJsonFromResult("")).toBeNull();
      expect(adapter.extractJsonFromResult("   ")).toBeNull();
    });
  });

  describe("applySuccessGate", () => {
    it("passes when gate output is true", () => {
      const result = adapter.applySuccessGate({ approved: true, review: "lgtm" }, "approved");
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("fails when gate output is false", () => {
      const result = adapter.applySuccessGate({ approved: false, review: "issues found" }, "approved");
      expect(result.success).toBe(false);
      expect(result.error).toContain("approved");
      expect(result.error).toContain("false");
    });

    it("fails when gate output is missing", () => {
      const result = adapter.applySuccessGate({ review: "issues found" }, "approved");
      expect(result.success).toBe(false);
      expect(result.error).toContain("approved");
    });

    it("fails when gate output is a truthy non-boolean string", () => {
      const result = adapter.applySuccessGate({ approved: "true" }, "approved");
      expect(result.success).toBe(false);
    });

    it("fails when gate output is a truthy number", () => {
      const result = adapter.applySuccessGate({ approved: 1 }, "approved");
      expect(result.success).toBe(false);
    });
  });
});
