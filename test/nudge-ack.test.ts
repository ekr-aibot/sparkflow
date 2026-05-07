import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NudgeQueue } from "../src/runtime/types.js";
import { WorkflowEngine } from "../src/engine/engine.js";
import { ClaudeCodeAdapter } from "../src/runtime/claude-code.js";
import { JobManager } from "../src/tui/job-manager.js";
import { handleIpcRequest } from "../src/tui/ipc-handler.js";
import type { SparkflowWorkflow } from "../src/schema/types.js";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "../src/runtime/types.js";
import type { NudgeRecord } from "../src/tui/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = { info: () => {}, error: () => {} };

async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

class MockAdapter implements RuntimeAdapter {
  constructor(private handler: (ctx: RuntimeContext) => Promise<RuntimeResult> = async () => ({ success: true, outputs: {} })) {}
  async run(ctx: RuntimeContext): Promise<RuntimeResult> { return this.handler(ctx); }
}

function makeWorkflow(overrides: Partial<SparkflowWorkflow> = {}): SparkflowWorkflow {
  return {
    version: "1", name: "test-workflow", entry: "start",
    defaults: { runtime: { type: "shell", command: "echo" }, max_retries: 3 },
    steps: { start: { name: "Start", interactive: false } },
    ...overrides,
  };
}

/** Direct-call the private handleStatusLine on a JobManager, same as LogTailer does. */
function injectLogLine(manager: JobManager, jobId: string, event: object): void {
  (manager as unknown as { handleStatusLine: (id: string, line: string) => void })
    .handleStatusLine(jobId, JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// 1. NudgeQueue — updated API stores {id, message} items
// ---------------------------------------------------------------------------

describe("NudgeQueue", () => {
  it("push and shift work FIFO with id+message", () => {
    const q = new NudgeQueue();
    q.push("first", "id-1");
    q.push("second", "id-2");
    expect(q.shift()).toEqual({ id: "id-1", message: "first" });
    expect(q.shift()).toEqual({ id: "id-2", message: "second" });
    expect(q.shift()).toBeUndefined();
  });

  it("drain empties queue and returns all items in order", () => {
    const q = new NudgeQueue();
    q.push("a", "x");
    q.push("b", "y");
    q.push("c", "z");
    expect(q.drain()).toEqual([
      { id: "x", message: "a" },
      { id: "y", message: "b" },
      { id: "z", message: "c" },
    ]);
    expect(q.shift()).toBeUndefined();
  });

  it("drain on empty queue returns empty array", () => {
    expect(new NudgeQueue().drain()).toEqual([]);
  });

  it("preserves ordering through N pushes", () => {
    const q = new NudgeQueue();
    for (let i = 0; i < 5; i++) q.push(`msg${i}`, `id${i}`);
    const out: string[] = [];
    let item;
    while ((item = q.shift())) out.push(item.id);
    expect(out).toEqual(["id0", "id1", "id2", "id3", "id4"]);
  });
});

// ---------------------------------------------------------------------------
// 2. engine.pushNudge — emits received event on stderr
// ---------------------------------------------------------------------------

describe("WorkflowEngine.pushNudge", () => {
  let stderrOutput: string;
  let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    stderrOutput = "";
    stderrSpy = vi.spyOn(process.stderr, "write" as never).mockImplementation(((chunk: unknown) => {
      stderrOutput += String(chunk);
      return true;
    }) as never);
  });

  afterEach(() => {
    stderrSpy?.mockRestore();
  });

  it("emits nudge_event received on stderr for a claude-code step (nudgeQueue path)", async () => {
    let capturedCtx: RuntimeContext | undefined;
    let unblock!: () => void;
    const blockP = new Promise<void>((r) => (unblock = r));

    const adapter = new MockAdapter(async (ctx) => {
      capturedCtx = ctx;
      await blockP;
      return { success: true, outputs: {} };
    });

    // received is only emitted when the nudge enters the nudgeQueue,
    // which is only created for claude-code steps.
    const workflow = makeWorkflow({
      steps: { start: { name: "Start", interactive: false, runtime: { type: "claude-code" } } },
    });
    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, new Map([["shell", adapter], ["claude-code", adapter]]));
    const runP = engine.run();

    await waitFor(() => capturedCtx !== undefined);

    engine.pushNudge("start", "redirect now", "nudge-abc-123");

    const events = stderrOutput.split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
    });

    const received = events.find((e) => e.type === "nudge_event" && e.phase === "received");
    expect(received).toBeDefined();
    expect(received?.nudge_id).toBe("nudge-abc-123");
    expect(received?.step).toBe("start");
    expect(typeof received?.at).toBe("number");

    unblock();
    await runP;
  });

  it("does NOT emit nudge_event received for shell steps (pendingMessages path)", async () => {
    let capturedCtx: RuntimeContext | undefined;
    let unblock!: () => void;
    const blockP = new Promise<void>((r) => (unblock = r));
    const adapter = new MockAdapter(async (ctx) => { capturedCtx = ctx; await blockP; return { success: true, outputs: {} }; });
    const workflow = makeWorkflow(); // shell step (default) — no nudgeQueue
    const engine = new WorkflowEngine(workflow, { logger: silentLogger }, new Map([["shell", adapter], ["claude-code", adapter]]));
    const runP = engine.run();
    await waitFor(() => capturedCtx !== undefined);
    stderrOutput = ""; // clear any startup events
    engine.pushNudge("start", "redirect", "nudge-shell-999");
    const events = stderrOutput.split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
    });
    expect(events.find((e) => e.type === "nudge_event" && e.phase === "received")).toBeUndefined();
    unblock();
    await runP;
  });

  it("returns error for unknown step without emitting any event", () => {
    const engine = new WorkflowEngine(makeWorkflow(), { logger: silentLogger }, new Map());
    const before = stderrOutput;
    const result = engine.pushNudge("no-such-step", "hello", "nid");
    expect(result).toEqual({ ok: false, error: "unknown step: no-such-step" });
    expect(stderrOutput).toBe(before); // no event emitted
  });
});

// ---------------------------------------------------------------------------
// 3. JobManager nudge lifecycle via direct handleStatusLine invocation
//
// handleStatusLine is the same callback the LogTailer calls for each new line
// it reads from the log file. Calling it directly (via type cast) exercises the
// production path without relying on fs.watch timing or child-process startup.
// ---------------------------------------------------------------------------

describe("JobManager nudge lifecycle — handleStatusLine path", () => {
  let manager: JobManager;
  let tmpDir: string;
  let wfPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-nudge-"));
    wfPath = join(tmpDir, "wf.json");
    writeFileSync(wfPath, JSON.stringify({
      version: "1", name: "nudge-test", entry: "s",
      steps: { s: { name: "S", runtime: { type: "shell", command: "sleep", args: ["30"] } } },
    }));
    manager = new JobManager(tmpDir);
  });

  afterEach(() => {
    manager.killAll();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("nudgeJob creates a pending NudgeRecord immediately", () => {
    const id = manager.startJob(wfPath);
    // State is set to "running" synchronously inside startJob
    expect(manager.getJobs().find((j) => j.id === id)?.state).toBe("running");

    const nudgeId = "pend-" + Date.now();
    const result = manager.nudgeJob(id, "s", "please refocus", nudgeId);
    expect(result.ok).toBe(true);

    const nudge = manager.getJobs().find((j) => j.id === id)?.nudges?.[0];
    expect(nudge?.id).toBe(nudgeId);
    expect(nudge?.status).toBe("pending");
    expect(nudge?.message).toBe("please refocus");
    expect(nudge?.stepId).toBe("s");
    expect(typeof nudge?.sentAt).toBe("number");
  });

  it("handleStatusLine updates NudgeRecord to delivered", () => {
    const id = manager.startJob(wfPath);
    const nudgeId = "del-" + Date.now();
    manager.nudgeJob(id, "s", "redirect", nudgeId);

    expect(manager.getJobs().find((j) => j.id === id)?.nudges?.[0]?.status).toBe("pending");

    injectLogLine(manager, id, {
      type: "nudge_event", nudge_id: nudgeId, phase: "delivered", step: "s", at: Date.now() + 100,
    });

    const nudge = manager.getJobs().find((j) => j.id === id)?.nudges?.[0];
    expect(nudge?.status).toBe("delivered");
    expect(typeof nudge?.deliveredAt).toBe("number");
  });

  it("waitForNudgeAck resolves with full acked NudgeRecord when acked event arrives", async () => {
    const id = manager.startJob(wfPath);
    const nudgeId = "ack-" + Date.now();
    manager.nudgeJob(id, "s", "redirect", nudgeId);

    const ackPromise = manager.waitForNudgeAck(nudgeId, 5000);

    // Inject delivered then acked — only acked triggers the waiter
    injectLogLine(manager, id, {
      type: "nudge_event", nudge_id: nudgeId, phase: "delivered", step: "s", at: Date.now(),
    });
    injectLogLine(manager, id, {
      type: "nudge_event", nudge_id: nudgeId, phase: "acked", step: "s",
      at: Date.now() + 500, duration_ms: 2345, turn_count: 2,
    });

    const ackResult = await ackPromise;
    expect(ackResult).toMatchObject({
      id: nudgeId,
      status: "acked",
      durationMs: 2345,
      turnCount: 2,
    });
  });

  it("delivered event alone does not resolve the ack waiter", async () => {
    // Use a fake job entry so the test is not sensitive to child-process exit timing.
    // This is the same private-map injection approach used in other job-manager tests.
    const fakeId = "fake-" + Date.now();
    const nudgeId = "del-only-" + Date.now();
    const fakeJob = {
      info: { id: fakeId, workflowPath: "", workflowName: "", state: "running", summary: "", startTime: Date.now(), nudges: [] },
      pid: -1,
      child: { stdin: { write: () => true } },
      logPath: "",
      tailer: { bytesRead: 0, start: () => {}, stop: () => {} },
      outputBuffer: [],
      stepStates: new Map(),
    };
    (manager as unknown as { jobs: Map<string, unknown> }).jobs.set(fakeId, fakeJob);

    const nudgeResult = manager.nudgeJob(fakeId, "s", "redirect", nudgeId);
    expect(nudgeResult.ok).toBe(true);

    let waiterResolved = false;
    const ackPromise = manager.waitForNudgeAck(nudgeId, 5000);
    void ackPromise.then(() => { waiterResolved = true; });

    // Inject only delivered — must NOT resolve the waiter
    injectLogLine(manager, fakeId, {
      type: "nudge_event", nudge_id: nudgeId, phase: "delivered", step: "s", at: Date.now(),
    });

    // Drain microtasks: Promise .then callbacks are microtasks
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(waiterResolved).toBe(false);

    // Clean up: inject acked to resolve the pending waiter so no timer leak
    injectLogLine(manager, fakeId, {
      type: "nudge_event", nudge_id: nudgeId, phase: "acked", step: "s",
      at: Date.now(), duration_ms: 0, turn_count: 0,
    });
    await ackPromise;
  });

  it("waitForNudgeAck resolves with abandoned when worker dies mid-flight", async () => {
    const id = manager.startJob(wfPath);
    // State is "running" immediately
    expect(manager.getJobs().find((j) => j.id === id)?.state).toBe("running");

    const nudgeId = "abandon-" + Date.now();
    const nudgeResult = manager.nudgeJob(id, "s", "hello", nudgeId);
    expect(nudgeResult.ok).toBe(true);

    // Mark as delivered so the abandoned check path includes delivered records
    injectLogLine(manager, id, {
      type: "nudge_event", nudge_id: nudgeId, phase: "delivered", step: "s", at: Date.now(),
    });
    const nudge = manager.getJobs().find((j) => j.id === id)?.nudges?.[0];
    expect(nudge?.status).toBe("delivered");

    const ackPromise = manager.waitForNudgeAck(nudgeId, 5000);

    // Kill the job — child.on("close") handler abandons in-flight waiters
    manager.killJob(id);

    // Wait for the close event to propagate
    await waitFor(
      () => manager.getJobs().find((j) => j.id === id)?.state === "failed",
      5000,
    );

    const ackResult = await ackPromise;
    expect(ackResult.status).toBe("abandoned");
    expect((ackResult as NudgeRecord).reason).toMatch(/worker exited/);
  }, 15000);

  it("waitForNudgeAck times out and returns pending when no event arrives", async () => {
    const start = Date.now();
    const result = await manager.waitForNudgeAck("nonexistent-nudge-id", 80);
    expect(Date.now() - start).toBeGreaterThanOrEqual(70);
    expect(result).toMatchObject({ status: "timeout", nudgeId: "nonexistent-nudge-id" });
  });

  it("multiple nudges are tracked independently in order", () => {
    const id = manager.startJob(wfPath);
    const id1 = "multi-1-" + Date.now();
    const id2 = "multi-2-" + Date.now();
    manager.nudgeJob(id, "s", "first nudge", id1);
    manager.nudgeJob(id, "s", "second nudge", id2);

    injectLogLine(manager, id, { type: "nudge_event", nudge_id: id1, phase: "acked", step: "s", at: Date.now(), duration_ms: 100, turn_count: 1 });
    injectLogLine(manager, id, { type: "nudge_event", nudge_id: id2, phase: "delivered", step: "s", at: Date.now() });

    const nudges = manager.getJobs().find((j) => j.id === id)?.nudges ?? [];
    expect(nudges[0]?.id).toBe(id1);
    expect(nudges[0]?.status).toBe("acked");
    expect(nudges[1]?.id).toBe(id2);
    expect(nudges[1]?.status).toBe("delivered");
  });
});

// ---------------------------------------------------------------------------
// 4. handleIpcRequest — correct ok:true / ok:false per ack status
//
// Mock the JobManager so we control exactly what waitForNudgeAck returns,
// then verify the IPC response payload matches spec.
// ---------------------------------------------------------------------------

describe("handleIpcRequest nudge_job — ok field per ack status", () => {
  function makeMockManager(ackResult: NudgeRecord | { status: "timeout"; nudgeId: string }) {
    return {
      nudgeJob: (_jobId: string, _stepId: string, _msg: string, _nudgeId: string) => ({ ok: true }),
      waitForNudgeAck: (_nudgeId: string, _timeoutMs: number) => Promise.resolve(ackResult),
      getJobDetail: (_jobId: string) => ({ info: { nudges: [] }, output: [] }),
    } as unknown as JobManager;
  }

  const baseMsg = {
    type: "nudge_job",
    id: "req-1",
    payload: { jobId: "j1", stepId: "s1", message: "redirect" },
  };

  it("returns ok:true for acked NudgeRecord with nudgeId alias per spec", async () => {
    const record: NudgeRecord = {
      id: "abc", stepId: "s1", message: "redirect", sentAt: 1000,
      deliveredAt: 1100, ackedAt: 1500, durationMs: 400, turnCount: 1, status: "acked",
    };
    const resp = await handleIpcRequest(baseMsg, makeMockManager(record), "/tmp");
    expect(resp.type).toBe("response");
    expect(resp.payload.ok).toBe(true);
    expect(resp.payload.status).toBe("acked");
    expect(resp.payload.durationMs).toBe(400);
    expect(resp.payload.turnCount).toBe(1);
    expect(resp.payload.id).toBe("abc");         // NudgeRecord.id (backward compat)
    expect(resp.payload.nudgeId).toBe("abc");    // alias per plan spec
  });

  it("returns ok:false for abandoned NudgeRecord with nudgeId alias", async () => {
    const record: NudgeRecord = {
      id: "abc", stepId: "s1", message: "redirect", sentAt: 1000,
      deliveredAt: 1100, status: "abandoned", reason: "worker exited (code=1)",
    };
    const resp = await handleIpcRequest(baseMsg, makeMockManager(record), "/tmp");
    expect(resp.type).toBe("response");
    expect(resp.payload.ok).toBe(false);
    expect(resp.payload.status).toBe("abandoned");
    expect(resp.payload.nudgeId).toBe("abc");
    expect(String(resp.payload.reason)).toMatch(/worker exited/);
  });

  it("returns ok:false with status:pending on timeout — nudgeId is a hex string", async () => {
    const timeoutResult = { status: "timeout" as const, nudgeId: "irrelevant" };
    const resp = await handleIpcRequest(baseMsg, makeMockManager(timeoutResult), "/tmp");
    expect(resp.type).toBe("response");
    expect(resp.payload.ok).toBe(false);
    expect(resp.payload.status).toBe("pending");
    // The ipc-handler uses its own internally-generated nudgeId in the response
    expect(typeof resp.payload.nudgeId).toBe("string");
    expect((resp.payload.nudgeId as string).length).toBeGreaterThan(0);
  });

  it("returns error when nudgeJob fails (no live stdin)", async () => {
    const manager = {
      nudgeJob: () => ({ ok: false, error: "nudges unavailable after reload" }),
    } as unknown as JobManager;
    const resp = await handleIpcRequest(baseMsg, manager, "/tmp");
    expect(resp.type).toBe("error");
    expect(String(resp.payload.error)).toMatch(/unavailable after reload/);
  });

  it("rejects empty-whitespace message before calling nudgeJob", async () => {
    const manager = { nudgeJob: vi.fn() } as unknown as JobManager;
    const msg = { type: "nudge_job", id: "req-2", payload: { jobId: "j1", stepId: "s1", message: "   " } };
    const resp = await handleIpcRequest(msg, manager, "/tmp");
    expect(resp.type).toBe("error");
    expect(String(resp.payload.error)).toMatch(/non-empty/);
    expect((manager.nudgeJob as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. ClaudeCodeAdapter runtime nudge event emission
//
// These tests verify that claude-code.ts actually emits the nudge lifecycle
// events on process.stderr. A fake "claude" binary simulates the LLM CLI,
// allowing the real adapter to run its turn loop.
// ---------------------------------------------------------------------------

describe("ClaudeCodeAdapter nudge event emission", () => {
  const adapter = new ClaudeCodeAdapter();
  let stderrOutput: string;
  let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;
  let fakeClaudeDir: string | null = null;
  let origPath: string | undefined;

  beforeEach(() => {
    stderrOutput = "";
    stderrSpy = vi.spyOn(process.stderr, "write" as never).mockImplementation(((chunk: unknown) => {
      stderrOutput += String(chunk);
      return true;
    }) as never);
  });

  afterEach(() => {
    stderrSpy?.mockRestore();
    if (fakeClaudeDir) {
      process.env.PATH = origPath;
      try { rmSync(fakeClaudeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      fakeClaudeDir = null;
    }
  });

  function installFakeClaude(script: string): void {
    fakeClaudeDir = mkdtempSync(join(tmpdir(), "fake-claude-nak-"));
    origPath = process.env.PATH;
    const bin = join(fakeClaudeDir, "claude");
    writeFileSync(bin, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
    process.env.PATH = `${fakeClaudeDir}:${origPath ?? ""}`;
  }

  function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
    return {
      stepId: "step1",
      step: { name: "Test", interactive: false },
      runtime: { type: "claude-code" },
      cwd: process.cwd(),
      env: {},
      interactive: false,
      ...overrides,
    };
  }

  function nudgeEvents(): Array<Record<string, unknown>> {
    return stderrOutput.split("\n").filter(Boolean).flatMap((l) => {
      try {
        const e = JSON.parse(l) as Record<string, unknown>;
        return e.type === "nudge_event" ? [e] : [];
      } catch { return []; }
    });
  }

  it("emits delivered then acked (with correct turnCount) when nudge is processed", async () => {
    // Fake claude: turn 1 (initial prompt) → result; turn 2 (nudge) → assistant + result
    installFakeClaude(`
const rl = require('readline').createInterface({ input: process.stdin });
let n = 0;
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === 'user') {
      n++;
      if (n === 1) {
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'initial done' }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'nudge handled' }) + '\\n');
      }
    }
  } catch {}
});
rl.on('close', () => process.exit(0));
`);

    const q = new NudgeQueue();
    q.push("please focus on tests", "rt-nudge-001");

    await adapter.run(makeCtx({ prompt: "initial prompt", nudgeQueue: q }));

    const events = nudgeEvents();
    const delivered = events.find((e) => e.phase === "delivered");
    const acked = events.find((e) => e.phase === "acked");

    expect(delivered).toBeDefined();
    expect(delivered?.nudge_id).toBe("rt-nudge-001");
    expect(delivered?.step).toBe("step1");

    expect(acked).toBeDefined();
    expect(acked?.nudge_id).toBe("rt-nudge-001");
    expect(acked?.turn_count).toBe(1);   // one assistant event counted between delivered and acked
    expect(typeof acked?.duration_ms).toBe("number");

    expect(events.find((e) => e.phase === "abandoned")).toBeUndefined();
  }, 15000);

  it("emits delivered then abandoned when child exits before responding to nudge", async () => {
    // Fake claude: turn 1 → result; turn 2 (nudge) → exit(0) without responding
    installFakeClaude(`
const rl = require('readline').createInterface({ input: process.stdin });
let n = 0;
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === 'user') {
      n++;
      if (n === 1) {
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }) + '\\n');
      } else {
        process.exit(0);
      }
    }
  } catch {}
});
rl.on('close', () => process.exit(0));
`);

    const q = new NudgeQueue();
    q.push("redirect this", "rt-abandon-001");

    await adapter.run(makeCtx({ prompt: "initial prompt", nudgeQueue: q }));

    const events = nudgeEvents();
    const delivered = events.find((e) => e.phase === "delivered");
    const abandoned = events.find((e) => e.phase === "abandoned");

    expect(delivered).toBeDefined();
    expect(delivered?.nudge_id).toBe("rt-abandon-001");

    expect(abandoned).toBeDefined();
    expect(abandoned?.nudge_id).toBe("rt-abandon-001");
    expect(String(abandoned?.reason)).toMatch(/child exited/);

    expect(events.find((e) => e.phase === "acked")).toBeUndefined();
  }, 15000);
});
