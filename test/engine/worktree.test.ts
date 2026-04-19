import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorktreeManager } from "../../src/engine/worktree.js";
import type { Step, SparkflowWorkflow } from "../../src/schema/types.js";

// Mock child_process and fs so no real git/fs calls happen
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  rmSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const mockExec = vi.mocked(execFileSync);
const mockRmSync = vi.mocked(rmSync);

function makeSharedStep(): Step {
  return { name: "step", interactive: false, worktree: { mode: "shared" } };
}

function makeIsolatedStep(branch?: string): Step {
  return { name: "step", interactive: false, worktree: { mode: "isolated", branch } };
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

describe("WorktreeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: branch doesn't exist (so findAvailableBranch returns base)
    mockExec.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "rev-parse" && argsArr[1] === "--verify") {
        throw new Error("branch not found");
      }
      return Buffer.from("");
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("path isolation", () => {
    it("two managers with different runIds resolve the same stepId to non-overlapping paths", () => {
      const managerA = new WorktreeManager("/repo", "aaaa1111");
      const managerB = new WorktreeManager("/repo", "bbbb2222");

      const pathA = managerA.resolve("developer", makeIsolatedStep(), makeWorkflow());
      const pathB = managerB.resolve("developer", makeIsolatedStep(), makeWorkflow());

      expect(pathA).toContain("aaaa1111");
      expect(pathB).toContain("bbbb2222");
      expect(pathA).not.toBe(pathB);
      expect(pathA).toMatch(/\.sparkflow-worktrees[/\\]aaaa1111[/\\]developer/);
      expect(pathB).toMatch(/\.sparkflow-worktrees[/\\]bbbb2222[/\\]developer/);
    });

    it("includes runId as a directory segment under WORKTREE_DIR", () => {
      const manager = new WorktreeManager("/repo", "deadbeef");
      const path = manager.resolve("my-step", makeIsolatedStep(), makeWorkflow());
      expect(path).toMatch(/\.sparkflow-worktrees[/\\]deadbeef[/\\]my-step$/);
    });
  });

  describe("shared mode", () => {
    it("returns repoRoot unchanged", () => {
      const manager = new WorktreeManager("/repo", "abc12345");
      const path = manager.resolve("step1", makeSharedStep(), makeWorkflow());
      expect(path).toBe("/repo");
      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe("hasWorktree", () => {
    it("returns false before resolve", () => {
      const manager = new WorktreeManager("/repo", "abc12345");
      expect(manager.hasWorktree("step1")).toBe(false);
    });

    it("returns true after resolving an isolated worktree", () => {
      const manager = new WorktreeManager("/repo", "abc12345");
      manager.resolve("step1", makeIsolatedStep(), makeWorkflow());
      expect(manager.hasWorktree("step1")).toBe(true);
    });

    it("returns false after cleanup", () => {
      const manager = new WorktreeManager("/repo", "abc12345");
      manager.resolve("step1", makeIsolatedStep(), makeWorkflow());
      manager.cleanup("step1");
      expect(manager.hasWorktree("step1")).toBe(false);
    });
  });

  describe("cleanupRunDir", () => {
    it("removes registered worktrees and then rmSyncs the per-run dir", () => {
      const manager = new WorktreeManager("/repo", "cafef00d");
      manager.resolve("step1", makeIsolatedStep(), makeWorkflow());
      manager.resolve("step2", makeIsolatedStep(), makeWorkflow());

      vi.clearAllMocks();
      manager.cleanupRunDir();

      // Should have called git worktree remove for each step
      const removeCalls = mockExec.mock.calls.filter(
        (c) => (c[1] as string[]).includes("remove")
      );
      expect(removeCalls.length).toBe(2);

      // Should have called rmSync on the per-run directory
      expect(mockRmSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.sparkflow-worktrees[/\\]cafef00d$/),
        { recursive: true, force: true }
      );
    });

    it("calls rmSync even when there are no registered worktrees", () => {
      const manager = new WorktreeManager("/repo", "00000001");
      manager.cleanupRunDir();
      expect(mockRmSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.sparkflow-worktrees[/\\]00000001$/),
        { recursive: true, force: true }
      );
    });

    it("does not throw if rmSync fails", () => {
      const manager = new WorktreeManager("/repo", "failcase");
      mockRmSync.mockImplementation(() => { throw new Error("permission denied"); });
      expect(() => manager.cleanupRunDir()).not.toThrow();
    });
  });

  describe("fork mode", () => {
    it("calls git worktree add --detach with the run-scoped path", () => {
      const manager = new WorktreeManager("/repo", "fork1234");
      manager.resolve("review", makeForkStep(), makeWorkflow());

      const addCall = mockExec.mock.calls.find(
        (c) => (c[1] as string[]).includes("add") && (c[1] as string[]).includes("--detach")
      );
      expect(addCall).toBeDefined();
      expect((addCall![1] as string[]).join(" ")).toContain("fork1234");
      expect((addCall![1] as string[]).join(" ")).toContain("review");
    });
  });
});
