import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore, type PersistedJob } from "../../src/tui/state-store.js";

function sampleJob(id: string, overrides: Partial<PersistedJob> = {}): PersistedJob {
  return {
    info: {
      id,
      workflowPath: "/tmp/wf.json",
      workflowName: "test",
      state: "running",
      summary: "ok",
      startTime: Date.now(),
    },
    pid: 12345,
    logPath: "/tmp/log",
    logOffset: 0,
    ...overrides,
  };
}

describe("StateStore", () => {
  let tmpDir: string;
  let store: StateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sparkflow-ss-"));
    store = new StateStore(tmpDir);
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("round-trips a saved job", () => {
    const job = sampleJob("abc");
    store.saveJob(job);
    const loaded = store.loadJobs();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(job);
  });

  it("returns empty when nothing has been saved", () => {
    expect(store.loadJobs()).toEqual([]);
  });

  it("removes a saved job", () => {
    store.saveJob(sampleJob("a"));
    store.saveJob(sampleJob("b"));
    store.removeJob("a");
    const loaded = store.loadJobs();
    expect(loaded.map((j) => j.info.id)).toEqual(["b"]);
  });

  it("overwrites on duplicate save (atomic rename)", () => {
    store.saveJob(sampleJob("abc", { logOffset: 10 }));
    store.saveJob(sampleJob("abc", { logOffset: 99 }));
    const loaded = store.loadJobs();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].logOffset).toBe(99);
  });

  it("skips corrupt entries silently", () => {
    store.saveJob(sampleJob("good"));
    writeFileSync(join(tmpDir, ".sparkflow", "state", "jobs", "bad.json"), "{ not json");
    const loaded = store.loadJobs();
    expect(loaded.map((j) => j.info.id)).toEqual(["good"]);
  });
});
