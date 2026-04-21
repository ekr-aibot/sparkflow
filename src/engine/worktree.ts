import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Step, SparkflowWorkflow } from "../schema/types.js";

const WORKTREE_DIR = ".sparkflow-worktrees";

export class WorktreeManager {
  private repoRoot: string;
  private runId: string;
  private worktrees = new Map<string, string>();

  constructor(repoRoot: string, runId: string) {
    this.repoRoot = repoRoot;
    this.runId = runId;
  }

  /**
   * @param commitish  When provided, fork/isolated worktrees are created at
   *                   this commit instead of at the repo-root HEAD.
   */
  resolve(stepId: string, step: Step, workflow: SparkflowWorkflow, commitish?: string): string {
    const worktreeConfig = step.worktree ?? workflow.defaults?.worktree ?? { mode: "shared" };

    if (worktreeConfig.mode === "shared") {
      return this.repoRoot;
    }

    const worktreePath = resolve(this.repoRoot, WORKTREE_DIR, this.runId, stepId);
    this.prepareWorktreePath(worktreePath);

    if (worktreeConfig.mode === "fork") {
      // New directory, detached HEAD at the given commit (or current HEAD)
      const args = ["worktree", "add", "--detach", worktreePath];
      if (commitish) args.push(commitish);
      execFileSync("git", args, {
        cwd: this.repoRoot,
        stdio: "pipe",
      });
    } else {
      // "isolated": new directory, new named branch
      const branch = worktreeConfig.branch ?? `sparkflow/${stepId}-${this.runId}`;
      execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
        cwd: this.repoRoot,
        stdio: "pipe",
      });
    }

    this.worktrees.set(stepId, worktreePath);
    return worktreePath;
  }

  cleanup(stepId: string): void {
    const worktreePath = this.worktrees.get(stepId);
    if (!worktreePath) return;

    try {
      execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: this.repoRoot,
        stdio: "pipe",
      });
    } catch {
      // Best-effort cleanup
    }

    this.worktrees.delete(stepId);
  }

  hasWorktree(stepId: string): boolean {
    return this.worktrees.has(stepId);
  }

  cleanupRunDir(): void {
    for (const stepId of this.worktrees.keys()) {
      this.cleanup(stepId);
    }
    try {
      rmSync(resolve(this.repoRoot, WORKTREE_DIR, this.runId), { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }

  private prepareWorktreePath(worktreePath: string): void {
    // Prune stale worktree entries (e.g., from a previous crashed run)
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: this.repoRoot,
        stdio: "pipe",
      });
    } catch {
      // Best-effort
    }

    // Remove leftover worktree at this path if it still exists
    try {
      execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: this.repoRoot,
        stdio: "pipe",
      });
    } catch {
      // Doesn't exist, that's fine
    }
  }

}
