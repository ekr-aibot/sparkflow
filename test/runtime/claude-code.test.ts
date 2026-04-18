import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter } from "../../src/runtime/claude-code.js";
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
});
