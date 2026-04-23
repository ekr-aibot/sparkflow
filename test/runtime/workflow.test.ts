import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowAdapter, drainActiveChildren } from "../../src/runtime/workflow.js";
import type { RuntimeContext } from "../../src/runtime/types.js";
import type { SparkflowWorkflow } from "../../src/schema/types.js";

function makeChildWorkflow(command: string, args: string[] = []): SparkflowWorkflow {
  return {
    version: "1",
    name: "child",
    entry: "only",
    steps: {
      only: {
        name: "Only",
        interactive: false,
        runtime: { type: "shell", command, args },
      },
    },
  };
}

function makeCtx(
  tmp: string,
  childFile: string,
  overrides: Partial<RuntimeContext> = {}
): RuntimeContext {
  return {
    stepId: "dispatch",
    step: { name: "Dispatch", interactive: false },
    runtime: {
      type: "workflow",
      workflow: childFile,
    },
    cwd: tmp,
    env: {},
    interactive: false,
    workflowDir: tmp,
    stepOutputs: new Map(),
    ...overrides,
  };
}

describe("WorkflowAdapter", () => {
  const adapter = new WorkflowAdapter();
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sparkflow-workflow-test-"));
  });

  afterEach(async () => {
    await drainActiveChildren();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads and dispatches a single child workflow", async () => {
    const child = makeChildWorkflow("true");
    const childPath = join(tmp, "child.json");
    writeFileSync(childPath, JSON.stringify(child));

    const ctx = makeCtx(tmp, "./child.json");
    const result = await adapter.run(ctx);

    expect(result.success).toBe(true);
    expect(result.outputs.dispatched).toBe(1);
    await drainActiveChildren();
  });

  it("returns failure when sub-workflow is invalid", async () => {
    const childPath = join(tmp, "bad.json");
    writeFileSync(childPath, JSON.stringify({ version: "1", name: "bad" })); // missing entry/steps

    const ctx = makeCtx(tmp, "./bad.json");
    const result = await adapter.run(ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid/);
  });

  it("runs foreach for each array item", async () => {
    const child = makeChildWorkflow("true");
    const childPath = join(tmp, "child.json");
    writeFileSync(childPath, JSON.stringify(child));

    const stepOutputs = new Map([
      ["poll", { items: [{ id: 1 }, { id: 2 }, { id: 3 }] }],
    ]);

    const ctx = makeCtx(tmp, "./child.json", {
      runtime: {
        type: "workflow",
        workflow: "./child.json",
        foreach: "${steps.poll.output.items}",
        pool: "test-foreach",
        max_concurrency: 10,
      },
      stepOutputs,
    });

    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);
    expect(result.outputs.dispatched).toBe(3);
    await drainActiveChildren();
  });

  it("stalls dispatch when the pool is full (max_concurrency: 1)", async () => {
    // Child sleeps 300ms. With concurrency 1, dispatching 2 items should take
    // at least ~600ms because the second dispatch waits for the first to free the slot.
    const child = makeChildWorkflow("sleep", ["0.3"]);
    const childPath = join(tmp, "child.json");
    writeFileSync(childPath, JSON.stringify(child));

    const stepOutputs = new Map([["poll", { items: [1, 2] }]]);

    const ctx = makeCtx(tmp, "./child.json", {
      runtime: {
        type: "workflow",
        workflow: "./child.json",
        foreach: "${steps.poll.output.items}",
        pool: `stall-${Date.now()}`,
        max_concurrency: 1,
      },
      stepOutputs,
    });

    const start = Date.now();
    const result = await adapter.run(ctx);
    const elapsedUntilReturn = Date.now() - start;

    // adapter.run returns after all items dispatched (not after children finish).
    // With cap=1 and 2 items that each sleep 300ms, the second dispatch waits
    // for the first child to finish before acquiring the slot. So run()
    // returns at roughly 300ms — definitely >=300ms and <600ms.
    expect(result.success).toBe(true);
    expect(elapsedUntilReturn).toBeGreaterThanOrEqual(250);

    await drainActiveChildren();
    const elapsedTotal = Date.now() - start;
    expect(elapsedTotal).toBeGreaterThanOrEqual(550);
  }, 10000);

  it("child workflows do not emit workflow_start or workflow_complete via the parent logger", async () => {
    // This verifies the fix for the process-pile-up bug: child WorkflowEngines
    // must use ConsoleLogger (not the parent's StatusJsonLogger) so that a
    // child completing does not emit a workflow_complete JSON event that would
    // mark the parent job as "succeeded" in the dashboard.
    const child = makeChildWorkflow("true");
    const childPath = join(tmp, "child.json");
    writeFileSync(childPath, JSON.stringify(child));

    const loggedMessages: string[] = [];
    const captureLogger = {
      info: (msg: string) => { loggedMessages.push(msg); },
      error: (msg: string) => { loggedMessages.push(`ERROR:${msg}`); },
    };

    const ctx = makeCtx(tmp, "./child.json", { logger: captureLogger });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);

    await drainActiveChildren();

    // The parent logger should NOT have received any workflow-lifecycle
    // messages from the child engine.
    const lifecycleMessages = loggedMessages.filter(
      (m) => /\[sparkflow\] (Starting workflow|Workflow .+ (completed|failed|aborted))/.test(m),
    );
    expect(lifecycleMessages).toHaveLength(0);
  });

  it("passes inputs as SPARKFLOW_INPUT_* env vars with per-item template values", async () => {
    // Child is a shell step that writes its ISSUE_NUMBER env var to a file.
    const outFile = join(tmp, "captured.txt");
    const child: SparkflowWorkflow = {
      version: "1",
      name: "capture",
      entry: "only",
      steps: {
        only: {
          name: "Capture",
          interactive: false,
          runtime: {
            type: "shell",
            command: `echo "$SPARKFLOW_INPUT_ISSUE_NUMBER" >> ${outFile}`,
          },
        },
      },
    };
    const childPath = join(tmp, "child.json");
    writeFileSync(childPath, JSON.stringify(child));

    const stepOutputs = new Map([
      ["poll", { items: [{ issue_number: 7 }, { issue_number: 42 }] }],
    ]);

    const ctx = makeCtx(tmp, "./child.json", {
      runtime: {
        type: "workflow",
        workflow: "./child.json",
        foreach: "${steps.poll.output.items}",
        pool: `inputs-${Date.now()}`,
        max_concurrency: 1,
        inputs: { ISSUE_NUMBER: "${item.issue_number}" },
      },
      stepOutputs,
    });

    await adapter.run(ctx);
    await drainActiveChildren();

    const { readFileSync } = await import("node:fs");
    const captured = readFileSync(outFile, "utf-8").trim().split("\n").sort();
    expect(captured).toEqual(["42", "7"]);
  }, 10000);
});
