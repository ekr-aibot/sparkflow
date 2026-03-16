import { describe, it, expect } from "vitest";
import { WorkflowEngine } from "../src/engine/engine.js";
import type { SparkflowWorkflow } from "../src/schema/types.js";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "../src/runtime/types.js";

// Silent logger for tests
const silentLogger = {
  info: () => {},
  error: () => {},
};

class MockAdapter implements RuntimeAdapter {
  private handler: (ctx: RuntimeContext) => Promise<RuntimeResult>;

  constructor(handler?: (ctx: RuntimeContext) => Promise<RuntimeResult>) {
    this.handler = handler ?? (async () => ({ success: true, outputs: {} }));
  }

  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    return this.handler(ctx);
  }
}

function makeAdapters(
  handler?: (ctx: RuntimeContext) => Promise<RuntimeResult>
): Map<string, RuntimeAdapter> {
  const adapter = new MockAdapter(handler);
  return new Map([
    ["shell", adapter],
    ["claude-code", adapter],
    ["custom", adapter],
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
      start: {
        name: "Start",
        interactive: false,
      },
    },
    ...overrides,
  };
}

describe("WorkflowEngine", () => {
  it("runs a single step workflow", async () => {
    const workflow = makeWorkflow();
    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, makeAdapters());
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(result.stepResults.get("start")?.state).toBe("succeeded");
  });

  it("runs linear execution (A → B → C)", async () => {
    const executionOrder: string[] = [];
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b" }],
        },
        b: {
          name: "B",
          interactive: false,
          on_success: [{ step: "c" }],
        },
        c: {
          name: "C",
          interactive: false,
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      executionOrder.push(ctx.stepId);
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(executionOrder).toEqual(["a", "b", "c"]);
  });

  it("runs fan-out (A → [B, C])", async () => {
    const executed = new Set<string>();
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b" }, { step: "c" }],
        },
        b: {
          name: "B",
          interactive: false,
        },
        c: {
          name: "C",
          interactive: false,
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      executed.add(ctx.stepId);
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(executed).toEqual(new Set(["a", "b", "c"]));
  });

  it("runs fan-in with join (A → [B, C] → D)", async () => {
    const executionOrder: string[] = [];
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b" }, { step: "c" }],
        },
        b: {
          name: "B",
          interactive: false,
          on_success: [{ step: "d" }],
        },
        c: {
          name: "C",
          interactive: false,
          on_success: [{ step: "d" }],
        },
        d: {
          name: "D",
          interactive: false,
          join: ["b", "c"],
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      executionOrder.push(ctx.stepId);
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(executionOrder).toContain("d");
    // D must be last
    expect(executionOrder[executionOrder.length - 1]).toBe("d");
  });

  it("handles feedback loop (A → B fails → A retry → B succeeds)", async () => {
    let bAttempts = 0;
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "Author",
          interactive: false,
          on_success: [{ step: "b" }],
        },
        b: {
          name: "Reviewer",
          interactive: false,
          on_failure: [{ step: "a", message: "Please fix the issues" }],
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      if (ctx.stepId === "b") {
        bAttempts++;
        if (bAttempts === 1) {
          return { success: false, outputs: {}, error: "Review failed" };
        }
      }
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(bAttempts).toBe(2);
  });

  it("aborts when max retries exceeded", async () => {
    const workflow = makeWorkflow({
      defaults: {
        runtime: { type: "shell", command: "echo" },
        max_retries: 1,
      },
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b" }],
          on_failure: [{ step: "a" }],
        },
        b: {
          name: "B",
          interactive: false,
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async () => {
      return { success: false, outputs: {}, error: "always fails" };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(false);
    expect(result.error).toContain("max retries");
  });

  it("fails workflow when step fails with no on_failure", async () => {
    const workflow = makeWorkflow({
      steps: {
        start: {
          name: "Start",
          interactive: false,
          // No on_failure
        },
      },
      entry: "start",
    });

    const adapters = makeAdapters(async () => {
      return { success: false, outputs: {}, error: "boom" };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    const result = await engine.run();

    expect(result.success).toBe(false);
    expect(result.error).toContain("no on_failure transition");
  });

  it("passes transition message to target step", async () => {
    const receivedMessages: (string | undefined)[] = [];
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b", message: "hello from a" }],
        },
        b: {
          name: "B",
          interactive: false,
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      receivedMessages.push(ctx.transitionMessage);
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    await engine.run();

    expect(receivedMessages).toEqual([undefined, "hello from a"]);
  });

  it("resolves templates in transition messages", async () => {
    const receivedMessages: (string | undefined)[] = [];
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          outputs: { result: { type: "text" } },
          on_success: [
            { step: "b", message: "Got: ${steps.a.output.result}" },
          ],
        },
        b: {
          name: "B",
          interactive: false,
        },
      },
      entry: "a",
    });

    const adapters = makeAdapters(async (ctx) => {
      receivedMessages.push(ctx.transitionMessage);
      if (ctx.stepId === "a") {
        return { success: true, outputs: { result: "42" } };
      }
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, adapters);
    await engine.run();

    expect(receivedMessages[1]).toBe("Got: 42");
  });

  it("concurrent failure queuing (B and C both fail → A)", async () => {
    let aRunCount = 0;
    const workflow = makeWorkflow({
      steps: {
        a: {
          name: "A",
          interactive: false,
          on_success: [{ step: "b" }, { step: "c" }],
        },
        b: {
          name: "B",
          interactive: false,
          on_failure: [{ step: "a", message: "B failed" }],
        },
        c: {
          name: "C",
          interactive: false,
          on_failure: [{ step: "a", message: "C failed" }],
        },
      },
      entry: "a",
    });

    let bFailCount = 0;
    let cFailCount = 0;
    const adapters = makeAdapters(async (ctx) => {
      if (ctx.stepId === "a") {
        aRunCount++;
        return { success: true, outputs: {} };
      }
      // B and C each fail once, then succeed
      if (ctx.stepId === "b" && bFailCount < 1) {
        bFailCount++;
        return { success: false, outputs: {}, error: "B failed" };
      }
      if (ctx.stepId === "c" && cFailCount < 1) {
        cFailCount++;
        return { success: false, outputs: {}, error: "C failed" };
      }
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger },
      adapters
    );
    const result = await engine.run();

    expect(result.success).toBe(true);
    // A should have run multiple times (initial + retries from failures)
    expect(aRunCount).toBeGreaterThanOrEqual(2);
  });

  it("dry-run does not execute adapters", async () => {
    let adapterCalled = false;
    const workflow = makeWorkflow();

    const adapters = makeAdapters(async () => {
      adapterCalled = true;
      return { success: true, outputs: {} };
    });

    const engine = new WorkflowEngine(
      workflow,
      { logger: silentLogger, dryRun: true },
      adapters
    );
    const result = await engine.run();

    expect(result.success).toBe(true);
    expect(adapterCalled).toBe(false);
  });
});
