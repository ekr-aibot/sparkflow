import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkflowEngine } from "../../src/engine/engine.js";
import type { SparkflowWorkflow } from "../../src/schema/types.js";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "../../src/runtime/types.js";

class MockAdapter implements RuntimeAdapter {
  private handler: (ctx: RuntimeContext) => Promise<RuntimeResult>;
  constructor(handler?: (ctx: RuntimeContext) => Promise<RuntimeResult>) {
    this.handler = handler ?? (async () => ({ success: true, outputs: {} }));
  }
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    return this.handler(ctx);
  }
}

function makeAdapters(handler?: (ctx: RuntimeContext) => Promise<RuntimeResult>): Map<string, RuntimeAdapter> {
  const adapter = new MockAdapter(handler);
  return new Map([
    ["shell", adapter],
    ["claude-code", adapter],
  ]);
}

function makeWorkflow(overrides: Partial<SparkflowWorkflow> = {}): SparkflowWorkflow {
  return {
    version: "1",
    name: "test-workflow",
    entry: "start",
    defaults: {
      runtime: { type: "shell", command: "echo" },
      max_retries: 3,
    },
    steps: {
      start: { name: "Start", interactive: false },
    },
    ...overrides,
  };
}

describe("WorkflowEngine with statusJson", () => {
  let stderrOutput: string;
  let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    stderrOutput = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stderrSpy = vi.spyOn(process.stderr, "write" as any).mockImplementation(((chunk: unknown) => {
      stderrOutput += String(chunk);
      return true;
    }) as any);
  });

  afterEach(() => {
    stderrSpy?.mockRestore();
  });

  it("emits step_status events on stderr when statusJson is true", async () => {
    const workflow = makeWorkflow({
      steps: {
        a: { name: "A", interactive: false, on_success: [{ step: "b" }] },
        b: { name: "B", interactive: false },
      },
      entry: "a",
    });

    // Use a logger that writes JSON to stderr (mimics StatusJsonLogger)
    const logger = {
      info(message: string): void {
        const stepMatch = message.match(/^\[(\S+)\] (running|succeeded|failed)/);
        if (stepMatch) {
          process.stderr.write(JSON.stringify({ type: "step_status", step: stepMatch[1], state: stepMatch[2] }) + "\n");
        }
        const startMatch = message.match(/^\[sparkflow\] Starting workflow "(.+)"/);
        if (startMatch) {
          process.stderr.write(JSON.stringify({ type: "workflow_start", name: startMatch[1] }) + "\n");
        }
        const completeMatch = message.match(/^\[sparkflow\] Workflow .+ completed successfully/);
        if (completeMatch) {
          process.stderr.write(JSON.stringify({ type: "workflow_complete", success: true }) + "\n");
        }
      },
      error(): void {},
    };

    const engine = new WorkflowEngine(
      workflow,
      { logger, statusJson: true },
      makeAdapters()
    );
    const result = await engine.run();

    expect(result.success).toBe(true);

    // Parse the stderr output into events
    const events = stderrOutput
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    // Should have workflow_start
    expect(events.some((e: { type: string }) => e.type === "workflow_start")).toBe(true);

    // Should have step_status events for both steps
    const stepEvents = events.filter((e: { type: string }) => e.type === "step_status");
    expect(stepEvents.some((e: { step: string; state: string }) => e.step === "a" && e.state === "running")).toBe(true);
    expect(stepEvents.some((e: { step: string; state: string }) => e.step === "a" && e.state === "succeeded")).toBe(true);
    expect(stepEvents.some((e: { step: string; state: string }) => e.step === "b" && e.state === "running")).toBe(true);
    expect(stepEvents.some((e: { step: string; state: string }) => e.step === "b" && e.state === "succeeded")).toBe(true);

    // Should have workflow_complete
    expect(events.some((e: { type: string; success?: boolean }) => e.type === "workflow_complete" && e.success === true)).toBe(true);
  });

  it("answerPendingQuestion resolves a pending answer", async () => {
    const workflow = makeWorkflow();

    const engine = new WorkflowEngine(
      workflow,
      { statusJson: true, logger: { info() {}, error() {} } },
      makeAdapters()
    );

    // Test the mechanism directly: register a pending answer and resolve it
    let resolved = false;
    const promise = new Promise<string>((resolve) => {
      // Access via the public method
      (engine as unknown as { pendingAnswers: Map<string, (v: string) => void> })
        .pendingAnswers.set("req-123", (answer: string) => {
          resolved = true;
          resolve(answer);
        });
    });

    engine.answerPendingQuestion("req-123", "Use React");
    const answer = await promise;

    expect(resolved).toBe(true);
    expect(answer).toBe("Use React");
  });

  it("answerPendingQuestion ignores unknown request IDs", () => {
    const workflow = makeWorkflow();
    const engine = new WorkflowEngine(
      workflow,
      { statusJson: true, logger: { info() {}, error() {} } },
      makeAdapters()
    );

    // Should not throw
    engine.answerPendingQuestion("nonexistent", "answer");
  });
});
