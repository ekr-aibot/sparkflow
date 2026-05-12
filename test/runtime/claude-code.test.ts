import { describe, it, expect, vi } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter, buildWorktreeReminder } from "../../src/runtime/claude-code.js";
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
    q.push("first", "id1");
    q.push("second", "id2");
    expect(q.shift()).toEqual({ id: "id1", message: "first" });
    expect(q.shift()).toEqual({ id: "id2", message: "second" });
    expect(q.shift()).toBeUndefined();
  });

  it("drain empties the queue and returns all messages in order", () => {
    const q = new NudgeQueue();
    q.push("a", "x");
    q.push("b", "y");
    q.push("c", "z");
    const drained = q.drain();
    expect(drained).toEqual([{ id: "x", message: "a" }, { id: "y", message: "b" }, { id: "z", message: "c" }]);
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

    it("detects developer plan limit in result text", () => {
      const parsed = { is_error: true, subtype: "other", result: "You've hit your limit · resets 11:30am (America/Los_Angeles)" };
      expect(adapter.isQuotaError(parsed, "")).toBe(true);
    });

    it("detects developer plan limit in stderr", () => {
      expect(adapter.isQuotaError(null, "[developer] You've hit your limit · resets 11:30am (America/Los_Angeles)")).toBe(true);
    });

    it("detects developer plan limit in stdout", () => {
      expect(adapter.isQuotaError(null, "", "You've hit your limit · resets 11:30am")).toBe(true);
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

  describe("extractQuotaResetSeconds", () => {
    it("parses retry after N seconds", () => {
      expect(adapter.extractQuotaResetSeconds("Rate limit exceeded. Retry after 30 seconds.")).toBe(30);
    });

    it("parses retry after N minutes", () => {
      expect(adapter.extractQuotaResetSeconds("Too many requests. Retry after 5 minutes.")).toBe(300);
    });

    it("returns null for messages with no reset info", () => {
      expect(adapter.extractQuotaResetSeconds("You've hit your limit")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(adapter.extractQuotaResetSeconds("")).toBeNull();
    });

    it("parses resets time with timezone", () => {
      // The reset time is in the future: we fake the current time to 10:00am UTC
      // and check that "resets 11:30am (UTC)" returns roughly 5400s.
      // We test the timezone-aware path by picking UTC so there's no offset ambiguity.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T10:00:00Z"));
      const seconds = adapter.extractQuotaResetSeconds("You've hit your limit · resets 11:30am (UTC)");
      vi.useRealTimers();
      // Should be ~5400s (1h30m). Allow ±5s for timing.
      expect(seconds).toBeGreaterThanOrEqual(5395);
      expect(seconds).toBeLessThanOrEqual(5405);
    });

    it("wraps to next day when reset time is in the past", () => {
      // Current time 11:00am UTC, reset at 10:00am UTC → should be ~23h from now
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T11:00:00Z"));
      const seconds = adapter.extractQuotaResetSeconds("resets 10:00am (UTC)");
      vi.useRealTimers();
      expect(seconds).toBeGreaterThanOrEqual(82795);
      expect(seconds).toBeLessThanOrEqual(82805);
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

// Fake claude binary helpers for self-nudge integration tests

/**
 * Creates a temp directory with a fake "claude" script that emits one result event
 * per user message received on stdin. `turns` is the ordered list of result text
 * strings to emit; subsequent messages get an empty string.
 */
function mkFakeClaude(turns: string[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const scriptPath = join(dir, "claude");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
const turns = ${JSON.stringify(turns)};
let idx = 0;
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === 'user') {
      const text = turns[idx++] ?? '';
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }) + '\\n');
    }
  } catch {}
});
rl.on('close', () => process.exit(0));
`,
    { mode: 0o755 }
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true }) };
}

async function withFakeClaude<T>(turns: string[], fn: () => Promise<T>): Promise<T> {
  const { dir, cleanup } = mkFakeClaude(turns);
  const origPath = process.env.PATH;
  process.env.PATH = `${dir}:${origPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = origPath;
    cleanup();
  }
}

describe("ClaudeCodeAdapter self-nudge", () => {
  const adapter = new ClaudeCodeAdapter();

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

  it("self-nudges once when gate output is absent in turn 1, succeeds in turn 2", async () => {
    const selfNudgeLogs: string[] = [];
    const result = await withFakeClaude(
      ["I'll review the code.", '{"approved": true, "review": "LGTM"}'],
      () =>
        adapter.run(
          makeCtx({
            step: {
              name: "Reviewer",
              interactive: false,
              success_output: "approved",
              outputs: { approved: { type: "json" }, review: { type: "json" } },
            },
            prompt: "Review the code",
            logger: {
              info: (msg: string) => {
                if (msg.includes("self-nudge")) selfNudgeLogs.push(msg);
              },
            } as any,
          })
        )
    );
    expect(result.success).toBe(true);
    expect(result.outputs.approved).toBe(true);
    expect(selfNudgeLogs).toHaveLength(1);
  }, 15000);

  it("does NOT self-nudge when gate output is false (agent decided no)", async () => {
    const selfNudgeLogs: string[] = [];
    const result = await withFakeClaude(
      ['{"approved": false, "review": "Issues found"}'],
      () =>
        adapter.run(
          makeCtx({
            step: {
              name: "Reviewer",
              interactive: false,
              success_output: "approved",
              outputs: { approved: { type: "json" }, review: { type: "json" } },
            },
            prompt: "Review the code",
            logger: {
              info: (msg: string) => {
                if (msg.includes("self-nudge")) selfNudgeLogs.push(msg);
              },
            } as any,
          })
        )
    );
    expect(result.success).toBe(false);
    expect(result.outputs.approved).toBe(false);
    expect(selfNudgeLogs).toHaveLength(0);
  }, 15000);

  // Regression for Bug 1: text-type outputs embedded in the result JSON must be
  // extracted even when the success_output gate fails. Previously only "json"-typed
  // outputs were pulled from parsedResultJson; "text" type fell through to the
  // event top-level lookup and missed fields that only appear in the result text.
  it("extracts text-type output from result JSON even when success_output gate fails", async () => {
    const result = await withFakeClaude(
      ['{"done": false, "task": "Fix the login bug"}'],
      () =>
        adapter.run(
          makeCtx({
            step: {
              name: "Pick next",
              interactive: false,
              success_output: "done",
              outputs: {
                done: { type: "json" },
                task: { type: "text" },
              },
            },
            prompt: "Pick a task",
          })
        )
    );
    // Gate failed because done is false
    expect(result.success).toBe(false);
    // But both outputs must still be extracted for on_failure interpolation
    expect(result.outputs.done).toBe(false);
    expect(result.outputs.task).toBe("Fix the login bug");
  }, 15000);

  // Regression: outputs must be extracted even when the step genuinely fails
  // (non-zero exit), as long as a result event was captured.
  it("extracts outputs from a result event even on non-zero exit", async () => {
    // Build a fake claude that emits a result event with is_error: true
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-error-"));
    const scriptPath = join(dir, "claude");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === 'user') {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: '{"task": "Build auth", "reason": "tool failed"}' }) + '\\n');
    }
  } catch {}
});
rl.on('close', () => process.exit(1));
`,
      { mode: 0o755 }
    );
    const origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath ?? ""}`;
    try {
      const result = await adapter.run(
        makeCtx({
          step: {
            name: "Worker",
            interactive: false,
            outputs: {
              task: { type: "text" },
              reason: { type: "text" },
            },
          },
          prompt: "Do work",
        })
      );
      expect(result.success).toBe(false);
      // Outputs must be extracted from the result event even on failure
      expect(result.outputs.task).toBe("Build auth");
      expect(result.outputs.reason).toBe("tool failed");
    } finally {
      process.env.PATH = origPath;
      rmSync(dir, { recursive: true });
    }
  }, 15000);

  it("self-nudges at most once even if turn 2 also misses the output", async () => {
    const selfNudgeLogs: string[] = [];
    const result = await withFakeClaude(
      ["Prose only.", "Still prose, no JSON."],
      () =>
        adapter.run(
          makeCtx({
            step: {
              name: "Reviewer",
              interactive: false,
              success_output: "approved",
              outputs: { approved: { type: "json" } },
            },
            prompt: "Review the code",
            logger: {
              info: (msg: string) => {
                if (msg.includes("self-nudge")) selfNudgeLogs.push(msg);
              },
            } as any,
          })
        )
    );
    expect(result.success).toBe(false);
    expect(selfNudgeLogs).toHaveLength(1);
  }, 15000);

  it("does NOT self-nudge when step has no success_output", async () => {
    const selfNudgeLogs: string[] = [];
    const result = await withFakeClaude(
      ["Just prose output."],
      () =>
        adapter.run(
          makeCtx({
            step: { name: "Plain step", interactive: false },
            prompt: "Do something",
            logger: {
              info: (msg: string) => {
                if (msg.includes("self-nudge")) selfNudgeLogs.push(msg);
              },
            } as any,
          })
        )
    );
    expect(result.success).toBe(true);
    expect(selfNudgeLogs).toHaveLength(0);
  }, 15000);

  it("user-pushed nudges work alongside self-nudge", async () => {
    const selfNudgeLogs: string[] = [];
    const q = new NudgeQueue();
    q.push("Also confirm the architecture is clean.", "nudge-arch-check");
    const result = await withFakeClaude(
      [
        "Let me think about this.",
        '{"approved": true, "review": "LGTM"}',
        '{"approved": true, "review": "Architecture looks good"}',
      ],
      () =>
        adapter.run(
          makeCtx({
            step: {
              name: "Reviewer",
              interactive: false,
              success_output: "approved",
              outputs: { approved: { type: "json" }, review: { type: "json" } },
            },
            prompt: "Review the code",
            nudgeQueue: q,
            logger: {
              info: (msg: string) => {
                if (msg.includes("self-nudge")) selfNudgeLogs.push(msg);
              },
            } as any,
          })
        )
    );
    expect(result.success).toBe(true);
    expect(result.outputs.approved).toBe(true);
    expect(selfNudgeLogs).toHaveLength(1);
  }, 15000);
});

describe("buildWorktreeReminder", () => {
  it("returns empty string when repoRoot is not set", () => {
    const ctx = makeCtx({ cwd: "/repo/worktree" });
    expect(buildWorktreeReminder(ctx)).toBe("");
  });

  it("returns empty string when cwd equals repoRoot", () => {
    const ctx = makeCtx({ cwd: "/repo", repoRoot: "/repo" });
    expect(buildWorktreeReminder(ctx)).toBe("");
  });

  it("returns reminder text when cwd differs from repoRoot", () => {
    const ctx = makeCtx({ cwd: "/repo/.sparkflow-worktrees/abc/develop", repoRoot: "/repo" });
    const reminder = buildWorktreeReminder(ctx);
    expect(reminder).toContain("/repo/.sparkflow-worktrees/abc/develop");
    expect(reminder).toContain("/repo");
    expect(reminder).toBeTruthy();
  });

  it("reminder mentions not to cd outside the worktree", () => {
    const ctx = makeCtx({ cwd: "/repo/wt", repoRoot: "/repo" });
    const reminder = buildWorktreeReminder(ctx);
    expect(reminder).toMatch(/cd/i);
  });
});

describe("ClaudeCodeAdapter worktree reminder injection", () => {
  const adapter = new ClaudeCodeAdapter();

  it("logs reminder injection when cwd differs from repoRoot", async () => {
    const infoLogs: string[] = [];
    const cwd = process.cwd();
    const repoRoot = "/some/other/root";
    await withFakeClaude(["done"], () =>
      adapter.run(
        makeCtx({
          prompt: "do something",
          cwd,
          repoRoot,
          logger: { info: (msg: string) => infoLogs.push(msg) } as any,
        })
      )
    );
    expect(infoLogs.some((m) => m.includes("injected worktree confinement reminder"))).toBe(true);
  }, 15000);

  it("does NOT log reminder injection when cwd equals repoRoot", async () => {
    const infoLogs: string[] = [];
    const cwd = process.cwd();
    await withFakeClaude(["done"], () =>
      adapter.run(
        makeCtx({
          prompt: "do something",
          cwd,
          repoRoot: cwd,
          logger: { info: (msg: string) => infoLogs.push(msg) } as any,
        })
      )
    );
    expect(infoLogs.some((m) => m.includes("injected worktree confinement reminder"))).toBe(false);
  }, 15000);

  it("does NOT log reminder injection when repoRoot is absent", async () => {
    const infoLogs: string[] = [];
    await withFakeClaude(["done"], () =>
      adapter.run(
        makeCtx({
          prompt: "do something",
          logger: { info: (msg: string) => infoLogs.push(msg) } as any,
        })
      )
    );
    expect(infoLogs.some((m) => m.includes("injected worktree confinement reminder"))).toBe(false);
  }, 15000);
});
