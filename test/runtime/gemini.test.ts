import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { GeminiAdapter } from "../../src/runtime/gemini.js";
import type { RuntimeContext } from "../../src/runtime/types.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process") as any;
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_GEMINI = resolve(__dirname, "fake-gemini.mjs");

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    stepId: "test-step",
    step: { name: "Test", interactive: false },
    runtime: { type: "gemini", command: FAKE_GEMINI },
    cwd: process.cwd(),
    env: {},
    interactive: false,
    ...overrides,
  };
}

describe("GeminiAdapter", () => {
  const adapter = new GeminiAdapter();

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs a successful prompt and captures stdout as _response", async () => {
    const ctx = makeCtx({ prompt: "hello world" });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.outputs._response).toMatch(/GEMINI:.*hello world/s);
  });

  it("populates named text outputs with the full stdout", async () => {
    const ctx = makeCtx({
      prompt: "the prompt",
      step: {
        name: "Test",
        interactive: false,
        outputs: { greeting: { type: "text" } },
      },
    });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);
    expect(result.outputs.greeting).toMatch(/GEMINI:.*the prompt/s);
  });

  it("extracts named JSON outputs when the model returns JSON", async () => {
    const ctx = makeCtx({
      runtime: { type: "gemini", command: FAKE_GEMINI, args: ["--emit-json"] },
      step: {
        name: "Test",
        interactive: false,
        outputs: { answer: { type: "text" }, confidence: { type: "text" } },
      },
    });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);
    expect(result.outputs.answer).toBe("forty-two");
    expect(result.outputs.confidence).toBe(0.9);
  });

  it("reports failure with stderr on non-zero exit", async () => {
    const ctx = makeCtx({
      runtime: { type: "gemini", command: FAKE_GEMINI, args: ["--exit-code", "1", "--emit-stderr", "bang"] },
      prompt: "anything",
    });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("bang");
  });

  it("times out and reports the timeout message", async () => {
    const ctx = makeCtx({
      runtime: { type: "gemini", command: FAKE_GEMINI, args: ["--sleep", "5"] },
      prompt: "slow",
      timeout: 1,
    });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Timed out/);
  });

  it("writes .gemini/settings.json for interactive steps with an IPC socket, then cleans up", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-gemini-test-"));
    try {
      const ctx = makeCtx({
        cwd: tmp,
        interactive: true,
        ipcSocketPath: "/tmp/sparkflow-fake.sock",
        prompt: "hi",
      });
      const result = await adapter.run(ctx);
      expect(result.success).toBe(true);
      // After run, settings.json and the .gemini dir are cleaned up.
      expect(existsSync(join(tmp, ".gemini", "settings.json"))).toBe(false);
      expect(existsSync(join(tmp, ".gemini"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("backs up and restores a pre-existing .gemini/settings.json", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-gemini-test-"));
    try {
      mkdirSync(join(tmp, ".gemini"));
      const original = JSON.stringify({ existingConfig: true });
      writeFileSync(join(tmp, ".gemini", "settings.json"), original);

      const ctx = makeCtx({
        cwd: tmp,
        interactive: true,
        ipcSocketPath: "/tmp/sparkflow-fake.sock",
        prompt: "hi",
      });
      await adapter.run(ctx);

      // The user's original settings.json is restored.
      const restored = readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8");
      expect(restored).toBe(original);
      // No stale backup file remains.
      expect(existsSync(join(tmp, ".gemini", "settings.json.sparkflow-backup"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("logs the resolved cwd", async () => {
    const info = vi.fn();
    const ctx = makeCtx({ logger: { info } as any });
    await adapter.run(ctx);
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`cwd=${ctx.cwd}`));
  });

  it("prepends an orientation preamble to the prompt", async () => {
    const ctx = makeCtx({ prompt: "actual prompt" });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);
    expect(result.outputs._response).toContain("[sparkflow] Your working directory is");
    expect(result.outputs._response).toContain("actual prompt");
  });

  it("fails if the cwd does not exist", async () => {
    const ctx = makeCtx({ cwd: "/tmp/this-path-should-not-exist-hopefully" });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cwd does not exist/);
  });

  it("passes --include-directories to the command line", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-gemini-argv-"));
    try {
      const ctx = makeCtx({ cwd: tmp, prompt: "test" });
      const result = await adapter.run(ctx);
      expect(result.success).toBe(true);

      const spawnMock = vi.mocked(spawn);
      const call = spawnMock.mock.calls.find(c => c[0] === FAKE_GEMINI);
      expect(call).toBeDefined();
      const args = call![1] as string[];
      expect(args).toContain("--include-directories");
      expect(args[args.indexOf("--include-directories") + 1]).toBe(tmp);

      expect(result.outputs._response).toContain(`Your working directory is ${tmp}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
