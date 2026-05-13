import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorktreeManager } from "../../src/engine/worktree.js";
import type { Step, SparkflowWorkflow } from "../../src/schema/types.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  rmSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

import { execFileSync } from "node:child_process";

const mockExec = vi.mocked(execFileSync);

function makeIsolatedStep(): Step {
  return { name: "step", interactive: false, worktree: { mode: "isolated" } };
}

function makeForkStep(): Step {
  return { name: "step", interactive: false, worktree: { mode: "fork" } };
}

function makeWorkflow(): SparkflowWorkflow {
  return {
    version: "1",
    name: "test",
    entry: "start",
    steps: { start: { name: "start", interactive: false } },
  };
}

describe("isolated worktree persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockReturnValue(Buffer.from(""));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns same path on second resolve without calling git worktree add", () => {
    const manager = new WorktreeManager("/repo", "run1111");

    const path1 = manager.resolve("develop", makeIsolatedStep(), makeWorkflow());

    vi.clearAllMocks();
    mockExec.mockReturnValue(Buffer.from(""));

    const path2 = manager.resolve("develop", makeIsolatedStep(), makeWorkflow());

    expect(path2).toBe(path1);
    const addCalls = mockExec.mock.calls.filter((c) =>
      (c[1] as string[]).includes("add")
    );
    expect(addCalls).toHaveLength(0);
  });

  it("path remains in the manager map after first resolve (hasWorktree true)", () => {
    const manager = new WorktreeManager("/repo", "run2222");

    manager.resolve("develop", makeIsolatedStep(), makeWorkflow());
    expect(manager.hasWorktree("develop")).toBe(true);

    // Second resolve should still report hasWorktree true
    manager.resolve("develop", makeIsolatedStep(), makeWorkflow());
    expect(manager.hasWorktree("develop")).toBe(true);
  });

  it("getPath returns undefined before resolve, path after", () => {
    const manager = new WorktreeManager("/repo", "run3333");

    expect(manager.getPath("develop")).toBeUndefined();

    const path = manager.resolve("develop", makeIsolatedStep(), makeWorkflow());
    expect(manager.getPath("develop")).toBe(path);
  });

  it("getPath returns undefined after cleanup", () => {
    const manager = new WorktreeManager("/repo", "run4444");

    manager.resolve("develop", makeIsolatedStep(), makeWorkflow());
    manager.cleanup("develop");
    expect(manager.getPath("develop")).toBeUndefined();
  });

  it("different stepIds still get different isolated worktree paths", () => {
    const manager = new WorktreeManager("/repo", "run5555");

    const pathA = manager.resolve("develop", makeIsolatedStep(), makeWorkflow());
    const pathB = manager.resolve("review", makeIsolatedStep(), makeWorkflow());

    expect(pathA).not.toBe(pathB);
    expect(pathA).toContain("develop");
    expect(pathB).toContain("review");
  });

  it("fork mode always creates a fresh worktree on each resolve call", () => {
    const manager = new WorktreeManager("/repo", "run6666");

    manager.resolve("test", makeForkStep(), makeWorkflow());

    vi.clearAllMocks();
    mockExec.mockReturnValue(Buffer.from(""));

    manager.resolve("test", makeForkStep(), makeWorkflow());

    const addCalls = mockExec.mock.calls.filter(
      (c) => (c[1] as string[]).includes("add") && (c[1] as string[]).includes("--detach")
    );
    expect(addCalls).toHaveLength(1);
  });
});
