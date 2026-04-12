import { describe, it, expect } from "vitest";
import { ShellAdapter } from "../../src/runtime/shell.js";
import type { RuntimeContext } from "../../src/runtime/types.js";
import { LocalBackend } from "../../src/sandbox/local.js";

async function makeCtx(overrides: Partial<RuntimeContext> = {}): Promise<RuntimeContext> {
  const base = {
    stepId: "test-step",
    step: {
      name: "Test",
      interactive: false,
    },
    runtime: { type: "shell" as const, command: "echo", args: ["hello"] },
    cwd: process.cwd(),
    env: {},
    interactive: false,
    ...overrides,
  };
  const sandbox = await new LocalBackend().create({
    stepId: base.stepId,
    step: base.step,
    workspaceHostPath: base.cwd,
    env: base.env,
    config: { type: "local" },
  });
  return { ...base, sandbox } as RuntimeContext;
}

describe("ShellAdapter", () => {
  const adapter = new ShellAdapter();

  it("runs a successful command", async () => {
    const result = await adapter.run(await makeCtx());
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("captures stdout for text outputs", async () => {
    const ctx = await makeCtx({
      step: {
        name: "Test",
        interactive: false,
        outputs: { greeting: { type: "text" } },
      },
      runtime: { type: "shell", command: "echo", args: ["hello world"] },
    });

    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);
    expect(result.outputs.greeting).toBe("hello world");
  });

  it("reports failure for non-zero exit code", async () => {
    const ctx = await makeCtx({
      runtime: { type: "shell", command: "false" },
    });

    const result = await adapter.run(ctx);
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("parses JSON output", async () => {
    const ctx = await makeCtx({
      step: {
        name: "Test",
        interactive: false,
        outputs: { data: { type: "json" } },
      },
      runtime: {
        type: "shell",
        command: "echo",
        args: ["'{\"key\":\"value\"}'"],
      },
    });

    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);
    expect(result.outputs.data).toEqual({ key: "value" });
  });

  it("passes SPARKFLOW_PROMPT env var when prompt is set", async () => {
    const ctx = await makeCtx({
      step: {
        name: "Test",
        interactive: false,
        outputs: { prompt: { type: "text" } },
      },
      runtime: { type: "shell", command: "echo", args: ["$SPARKFLOW_PROMPT"] },
      prompt: "my prompt",
    });

    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);
    expect(result.outputs.prompt).toBe("my prompt");
  });

  it("handles command timeout", async () => {
    const ctx = await makeCtx({
      runtime: { type: "shell", command: "sleep", args: ["10"] },
      timeout: 1,
    });

    const result = await adapter.run(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timed out");
  }, 10000);
});
