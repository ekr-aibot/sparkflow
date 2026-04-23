import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";
import type { SparkflowWorkflow, WorkflowRuntime } from "../schema/types.js";
import { validate } from "../schema/validate.js";
import { resolveTemplate } from "../engine/template.js";
import { ConsoleLogger } from "../engine/types.js";

// ── Process-wide pool semaphore ─────────────────────────────────────

class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((res) => this.waiters.push(res));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

const pools = new Map<string, Semaphore>();

function getPool(name: string, capacity: number): Semaphore {
  let sem = pools.get(name);
  if (!sem) {
    sem = new Semaphore(capacity);
    pools.set(name, sem);
  }
  return sem;
}

// ── Active children registry ────────────────────────────────────────

const activeChildren = new Set<Promise<void>>();

function trackChild(p: Promise<void>): void {
  activeChildren.add(p);
  p.finally(() => activeChildren.delete(p));
}

/**
 * Wait for all detached child workflows to finish. Call before process exit
 * so spawned sub-workflows aren't orphaned.
 */
export async function drainActiveChildren(): Promise<void> {
  while (activeChildren.size > 0) {
    await Promise.allSettled(Array.from(activeChildren));
  }
}

export function activeChildCount(): number {
  return activeChildren.size;
}

// ── Adapter ─────────────────────────────────────────────────────────

export class WorkflowAdapter implements RuntimeAdapter {
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    if (ctx.runtime.type !== "workflow") {
      return { success: false, outputs: {}, error: "WorkflowAdapter called with non-workflow runtime" };
    }

    const cwdStat = (() => { try { return statSync(ctx.cwd); } catch { return null; } })();
    if (!cwdStat || !cwdStat.isDirectory()) {
      return { success: false, outputs: {}, error: `cwd does not exist or is not a directory: ${ctx.cwd}` };
    }
    ctx.logger?.info(`[${ctx.stepId}] cwd=${ctx.cwd}`);

    const rt = ctx.runtime as WorkflowRuntime;

    const workflowDir = ctx.workflowDir ?? ctx.cwd;
    const childPath = resolve(workflowDir, rt.workflow);

    let childData: unknown;
    try {
      childData = JSON.parse(readFileSync(childPath, "utf-8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, outputs: {}, error: `Failed to load sub-workflow ${childPath}: ${msg}` };
    }

    const validation = validate(childData);
    if (!validation.valid) {
      const errText = validation.errors.map((e) => e.message).join("; ");
      return { success: false, outputs: {}, error: `Sub-workflow ${childPath} is invalid: ${errText}` };
    }
    const childWorkflow = childData as SparkflowWorkflow;

    // Resolve the list of items to dispatch.
    const stepOutputs = ctx.stepOutputs ?? new Map<string, Record<string, unknown>>();
    let items: unknown[];
    if (rt.foreach) {
      const resolved = resolveTemplate(rt.foreach, stepOutputs);
      try {
        const parsed = JSON.parse(resolved);
        if (!Array.isArray(parsed)) {
          return { success: false, outputs: {}, error: `foreach expression did not resolve to an array: ${resolved}` };
        }
        items = parsed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, outputs: {}, error: `foreach value is not valid JSON: ${msg}` };
      }
    } else {
      items = [undefined];
    }

    const capacity = rt.max_concurrency ?? 1;
    const poolName = rt.pool ?? childPath;
    const sem = getPool(poolName, capacity);

    const logger = ctx.logger;
    const stepId = ctx.stepId;
    let dispatched = 0;

    for (const item of items) {
      // Build child env by merging parent env + resolved inputs
      const childEnv: Record<string, string> = { ...ctx.env };
      if (rt.inputs) {
        for (const [key, value] of Object.entries(rt.inputs)) {
          childEnv[`SPARKFLOW_INPUT_${key}`] = resolveTemplate(value, stepOutputs, item);
        }
      }
      if (ctx.transitionMessage) {
        childEnv.SPARKFLOW_MESSAGE = ctx.transitionMessage;
      }

      await sem.acquire();
      const childIndex = dispatched;
      logger?.info(`[${stepId}] dispatching child ${childIndex + 1}/${items.length} → ${childPath}`);

      const childPromise = runChild(childWorkflow, childPath, childEnv, ctx, childIndex)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.error(`[${stepId}] child ${childIndex + 1} errored: ${msg}`);
        })
        .finally(() => {
          sem.release();
          logger?.info(`[${stepId}] child ${childIndex + 1} finished`);
        });

      trackChild(childPromise);
      dispatched++;
    }

    return { success: true, outputs: { dispatched } };
  }
}

async function runChild(
  workflow: SparkflowWorkflow,
  workflowPath: string,
  env: Record<string, string>,
  parentCtx: RuntimeContext,
  childIndex: number
): Promise<void> {
  // Import lazily to avoid a circular import with engine.ts.
  const { WorkflowEngine } = await import("../engine/engine.js");

  // Merge env into process.env just for the duration of the child run.
  // The engine passes env to adapters per-step, but env vars in the child
  // workflow's template expansions etc. can reference these.
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    const engine = new WorkflowEngine(workflow, {
      cwd: parentCtx.cwd,
      workflowDir: dirname(workflowPath),
      // Use ConsoleLogger for child engines so they don't emit JSON events
      // (workflow_start, workflow_complete) that would corrupt the parent
      // job's dashboard state (e.g. marking fixer.json "succeeded" when
      // fixer-one.json finishes).
      logger: new ConsoleLogger(),
      verbose: parentCtx.verbose,
    });
    await engine.run();
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
