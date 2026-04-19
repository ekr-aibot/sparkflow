import { describe, it, expect } from "vitest";
import { suffixFor, formatClaudeEvent, formatGeminiEvent } from "../../src/runtime/log-block.js";

// ── suffixFor ─────────────────────────────────────────────────────────────────

describe("suffixFor", () => {
  it("returns empty string for text", () => expect(suffixFor("text")).toBe(""));
  it("returns :tool for tool", () => expect(suffixFor("tool")).toBe(":tool"));
  it("returns :tool_result for tool_result", () => expect(suffixFor("tool_result")).toBe(":tool_result"));
  it("returns :meta for meta", () => expect(suffixFor("meta")).toBe(":meta"));
});

// ── formatClaudeEvent (regression) ────────────────────────────────────────────

describe("formatClaudeEvent", () => {
  it("emits text blocks from assistant message", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello\nworld" }] },
    };
    const blocks = formatClaudeEvent(event);
    expect(blocks).toEqual([
      { kind: "text", text: "hello" },
      { kind: "text", text: "world" },
    ]);
  });

  it("emits tool block from tool_use content", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }],
      },
    };
    const blocks = formatClaudeEvent(event);
    expect(blocks).toEqual([
      { kind: "tool", text: '[tool: bash] {"command":"ls"}' },
    ]);
  });

  it("emits tool_result block", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "tool_result" }] },
    };
    const blocks = formatClaudeEvent(event);
    expect(blocks).toEqual([{ kind: "tool_result", text: "[tool_result]" }]);
  });

  it("emits meta block from result event", () => {
    const event = { type: "result", result: "success" };
    const blocks = formatClaudeEvent(event);
    expect(blocks).toEqual([{ kind: "meta", text: "result: success" }]);
  });

  it("returns [] for init and other unknown types", () => {
    expect(formatClaudeEvent({ type: "init" })).toEqual([]);
    expect(formatClaudeEvent({ type: "rate_limit_event" })).toEqual([]);
  });
});

// ── formatGeminiEvent ─────────────────────────────────────────────────────────

describe("formatGeminiEvent", () => {
  it("skips init events", () => {
    expect(formatGeminiEvent({ type: "init" })).toEqual([]);
  });

  it("skips user role messages", () => {
    expect(formatGeminiEvent({ type: "message", role: "user", content: "hi" })).toEqual([]);
  });

  it("skips delta assistant messages", () => {
    const event = { type: "message", role: "assistant", delta: true, content: "partial" };
    expect(formatGeminiEvent(event)).toEqual([]);
  });

  it("emits text lines from non-delta assistant message (string content)", () => {
    const event = { type: "message", role: "assistant", content: "line one\nline two" };
    const blocks = formatGeminiEvent(event);
    expect(blocks).toEqual([
      { kind: "text", text: "line one" },
      { kind: "text", text: "line two" },
    ]);
  });

  it("emits text lines from assistant message with array content", () => {
    const event = {
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "part one" },
        { type: "text", text: " part two" },
      ],
    };
    const blocks = formatGeminiEvent(event);
    expect(blocks).toEqual([{ kind: "text", text: "part one part two" }]);
  });

  it("drops non-text parts in array content", () => {
    const event = {
      type: "message",
      role: "assistant",
      content: [{ type: "image", url: "x" }, { type: "text", text: "hi" }],
    };
    const blocks = formatGeminiEvent(event);
    expect(blocks).toEqual([{ kind: "text", text: "hi" }]);
  });

  it("emits tool block with parameters", () => {
    const event = {
      type: "tool_use",
      tool_name: "read_file",
      parameters: { path: "/tmp/foo" },
    };
    const blocks = formatGeminiEvent(event);
    expect(blocks).toEqual([
      { kind: "tool", text: '[tool: read_file] {"path":"/tmp/foo"}' },
    ]);
  });

  it("emits tool block with <unknown> when tool_name is missing", () => {
    const event = { type: "tool_use", parameters: { x: 1 } };
    const blocks = formatGeminiEvent(event);
    expect(blocks).toEqual([{ kind: "tool", text: '[tool: <unknown>] {"x":1}' }]);
  });

  it("emits [tool_result] for ok status", () => {
    expect(formatGeminiEvent({ type: "tool_result", status: "ok" })).toEqual([
      { kind: "tool_result", text: "[tool_result]" },
    ]);
  });

  it("emits [tool_result] for success status", () => {
    expect(formatGeminiEvent({ type: "tool_result", status: "success" })).toEqual([
      { kind: "tool_result", text: "[tool_result]" },
    ]);
  });

  it("emits [tool_result] for missing status", () => {
    expect(formatGeminiEvent({ type: "tool_result" })).toEqual([
      { kind: "tool_result", text: "[tool_result]" },
    ]);
  });

  it("includes status in tool_result for error status", () => {
    expect(formatGeminiEvent({ type: "tool_result", status: "error" })).toEqual([
      { kind: "tool_result", text: "[tool_result status=error]" },
    ]);
  });

  it("emits meta block from result with full stats", () => {
    const event = {
      type: "result",
      status: "completed",
      stats: { total_tokens: 123, duration_ms: 456 },
    };
    const blocks = formatGeminiEvent(event);
    expect(blocks).toEqual([
      { kind: "meta", text: "result: status=completed, tokens=123, duration=456ms" },
    ]);
  });

  it("emits meta block from result with missing stats fields", () => {
    const event = { type: "result", status: "completed", stats: {} };
    const blocks = formatGeminiEvent(event);
    expect(blocks).toEqual([{ kind: "meta", text: "result: status=completed" }]);
  });

  it("returns [] for result with no meaningful fields", () => {
    expect(formatGeminiEvent({ type: "result" })).toEqual([]);
  });

  it("returns [] for unknown event types", () => {
    expect(formatGeminiEvent({ type: "thought", text: "hmm" })).toEqual([]);
    expect(formatGeminiEvent({ type: "plan" })).toEqual([]);
  });

  it("returns [] for events missing type", () => {
    expect(formatGeminiEvent({ role: "assistant" })).toEqual([]);
  });
});
