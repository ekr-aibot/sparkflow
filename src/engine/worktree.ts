import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { Step, SparkflowWorkflow } from "../schema/types.js";

const WORKTREE_DIR = ".sparkflow-worktrees";

export class WorktreeManager {
  private repoRoot: string;
  private worktrees = new Map<string, string>();

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  resolve(stepId: string, step: Step, workflow: SparkflowWorkflow): string {
    const worktreeConfig = step.worktree ?? workflow.defaults?.worktree ?? { mode: "shared" };

    if (worktreeConfig.mode === "shared") {
      return this.repoRoot;
    }

    // Isolated: create a git worktree
    const timestamp = Date.now();
    const branch = worktreeConfig.branch ?? `sparkflow/${stepId}-${timestamp}`;
    const worktreePath = resolve(this.repoRoot, WORKTREE_DIR, stepId);

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

    execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
      cwd: this.repoRoot,
      stdio: "pipe",
    });

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
}
