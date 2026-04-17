import { execFileSync } from "node:child_process";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";
import type { PrWatcherRuntime } from "../schema/types.js";

const DEFAULT_POLL_INTERVAL = 30;

interface PrInfo {
  number: number;
  url: string;
  state: string;
  mergedAt: string | null;
}

interface CheckResult {
  name: string;
  state: string;
  conclusion: string;
}

interface Review {
  state: string;
  body: string;
  user: { login: string };
}

interface Comment {
  body: string;
  user: { login: string };
}

function gh(args: string[], cwd: string): string {
  return execFileSync("gh", args, {
    cwd,
    stdio: "pipe",
    timeout: 30_000,
  }).toString().trim();
}

function ghJson<T>(args: string[], cwd: string): T {
  const raw = gh(args, cwd);
  return JSON.parse(raw) as T;
}

function parseOwnerRepo(spec: string): { owner: string; repo: string } {
  const parts = spec.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid pr_repo "${spec}" — expected OWNER/NAME`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function getOwnerRepo(cwd: string): { owner: string; repo: string } {
  const url = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd,
    stdio: "pipe",
  }).toString().trim();

  // Handles both SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git)
  const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Cannot parse owner/repo from remote URL: ${url}`);
  }
  return { owner: match[1], repo: match[2] };
}

function currentBranch(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    stdio: "pipe",
  }).toString().trim();
}

/**
 * Discover the PR for the current branch. Passing the branch name explicitly
 * matters when the branch isn't tracking origin — e.g. pr-create pushed to
 * an `aibot` remote on a fork. `gh pr view` without an argument looks up the
 * PR via branch tracking, which returns "No PR found" in that setup.
 */
function getPrInfo(cwd: string, repoArgs: string[]): PrInfo {
  const branch = currentBranch(cwd);
  return ghJson<PrInfo>(
    ["pr", "view", branch, ...repoArgs, "--json", "number,url,state,mergedAt"],
    cwd,
  );
}

function getChecks(num: number, cwd: string, repoArgs: string[]): CheckResult[] {
  try {
    return ghJson<CheckResult[]>(
      ["pr", "checks", String(num), ...repoArgs, "--json", "name,state,conclusion"],
      cwd,
    );
  } catch {
    return [];
  }
}

function getReviews(owner: string, repo: string, num: number, cwd: string): Review[] {
  try {
    return ghJson<Review[]>(
      ["api", `repos/${owner}/${repo}/pulls/${num}/reviews`],
      cwd,
    );
  } catch {
    return [];
  }
}

function getComments(owner: string, repo: string, num: number, cwd: string): Comment[] {
  try {
    return ghJson<Comment[]>(
      ["api", `repos/${owner}/${repo}/issues/${num}/comments`],
      cwd,
    );
  } catch {
    return [];
  }
}

function getReviewComments(owner: string, repo: string, num: number, cwd: string): Comment[] {
  try {
    return ghJson<Comment[]>(
      ["api", `repos/${owner}/${repo}/pulls/${num}/comments`],
      cwd,
    );
  } catch {
    return [];
  }
}

function formatFeedback(type: string, details: string): string {
  return `[${type}]\n${details}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PrWatcherAdapter implements RuntimeAdapter {
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const runtime = ctx.runtime as PrWatcherRuntime;
    if (runtime.type !== "pr-watcher") {
      throw new Error(`PrWatcherAdapter received non-pr-watcher runtime: ${runtime.type}`);
    }

    const pollInterval = (runtime.poll_interval ?? DEFAULT_POLL_INTERVAL) * 1000;
    const timeoutMs = ctx.timeout ? ctx.timeout * 1000 : undefined;
    const startTime = Date.now();
    const targetRepo = ctx.git?.pr_repo;
    const repoArgs = targetRepo ? ["--repo", targetRepo] : [];

    // Discover PR from current branch
    let pr: PrInfo;
    try {
      pr = getPrInfo(ctx.cwd, repoArgs);
    } catch {
      return {
        success: false,
        outputs: {},
        error: "No PR found for the current branch",
      };
    }

    ctx.logger?.info(`[${ctx.stepId}] watching PR #${pr.number}: ${pr.url}`);

    // Already merged
    if (pr.state === "MERGED" || pr.mergedAt) {
      ctx.logger?.info(`[${ctx.stepId}] PR already merged`);
      return {
        success: true,
        outputs: { pr_url: pr.url },
      };
    }

    // Snapshot initial state. Prefer the configured pr_repo over parsing origin.
    const { owner, repo } = targetRepo
      ? parseOwnerRepo(targetRepo)
      : getOwnerRepo(ctx.cwd);

    const initialChecks = getChecks(pr.number, ctx.cwd, repoArgs);
    const initialFailedChecks = new Set(
      initialChecks
        .filter((c) => c.conclusion === "failure" || c.conclusion === "FAILURE")
        .map((c) => c.name),
    );

    const initialReviews = getReviews(owner, repo, pr.number, ctx.cwd);
    const initialReviewCount = initialReviews.length;

    const initialComments = getComments(owner, repo, pr.number, ctx.cwd);
    const initialCommentCount = initialComments.length;

    const initialReviewComments = getReviewComments(owner, repo, pr.number, ctx.cwd);
    const initialReviewCommentCount = initialReviewComments.length;

    // Poll loop
    while (true) {
      // Check timeout
      if (timeoutMs && Date.now() - startTime > timeoutMs) {
        return {
          success: false,
          outputs: { feedback: "PR watcher timed out waiting for merge or new activity" },
          error: `Timed out after ${ctx.timeout}s`,
        };
      }

      await sleep(pollInterval);

      // Re-check PR state
      let current: PrInfo;
      try {
        current = ghJson<PrInfo>(
          ["pr", "view", String(pr.number), ...repoArgs, "--json", "state,mergedAt,url"],
          ctx.cwd,
        );
      } catch (err) {
        ctx.logger?.info(`[${ctx.stepId}] failed to fetch PR state, retrying...`);
        continue;
      }

      // Merged
      if (current.state === "MERGED" || current.mergedAt) {
        ctx.logger?.info(`[${ctx.stepId}] PR merged`);
        return {
          success: true,
          outputs: { pr_url: current.url },
        };
      }

      // Closed without merge
      if (current.state === "CLOSED") {
        return {
          success: false,
          outputs: { feedback: "PR was closed without merging" },
          error: "PR closed",
        };
      }

      // Check for new CI failures
      const checks = getChecks(pr.number, ctx.cwd, repoArgs);
      const newFailures = checks.filter(
        (c) =>
          (c.conclusion === "failure" || c.conclusion === "FAILURE") &&
          !initialFailedChecks.has(c.name),
      );

      if (newFailures.length > 0) {
        const details = newFailures
          .map((c) => `- ${c.name}: ${c.conclusion}`)
          .join("\n");
        ctx.logger?.info(`[${ctx.stepId}] new CI failures detected`);
        return {
          success: false,
          outputs: {
            feedback: formatFeedback("CI Failure", details),
            pr_url: current.url,
          },
          error: "New CI failures detected",
        };
      }

      // Check for new reviews requesting changes
      const reviews = getReviews(owner, repo, pr.number, ctx.cwd);
      if (reviews.length > initialReviewCount) {
        const newReviews = reviews.slice(initialReviewCount);
        const changesRequested = newReviews.filter(
          (r) => r.state === "CHANGES_REQUESTED",
        );

        if (changesRequested.length > 0) {
          const details = changesRequested
            .map((r) => `- @${r.user.login}: ${r.body}`)
            .join("\n");
          ctx.logger?.info(`[${ctx.stepId}] changes requested on PR`);
          return {
            success: false,
            outputs: {
              feedback: formatFeedback("Changes Requested", details),
              pr_url: current.url,
            },
            error: "Reviewer requested changes",
          };
        }
      }

      // Check for new issue comments
      const comments = getComments(owner, repo, pr.number, ctx.cwd);
      if (comments.length > initialCommentCount) {
        const newComments = comments.slice(initialCommentCount);
        const details = newComments
          .map((c) => `- @${c.user.login}: ${c.body}`)
          .join("\n");
        ctx.logger?.info(`[${ctx.stepId}] new comments on PR`);
        return {
          success: false,
          outputs: {
            feedback: formatFeedback("New Comments", details),
            pr_url: current.url,
          },
          error: "New comments on PR",
        };
      }

      // Check for new PR review comments (inline code comments)
      const reviewComments = getReviewComments(owner, repo, pr.number, ctx.cwd);
      if (reviewComments.length > initialReviewCommentCount) {
        const newReviewComments = reviewComments.slice(initialReviewCommentCount);
        const details = newReviewComments
          .map((c) => `- @${c.user.login}: ${c.body}`)
          .join("\n");
        ctx.logger?.info(`[${ctx.stepId}] new review comments on PR`);
        return {
          success: false,
          outputs: {
            feedback: formatFeedback("Review Comments", details),
            pr_url: current.url,
          },
          error: "New review comments on PR",
        };
      }

      // All checks passed and no blocking reviews → success
      if (checks.length > 0) {
        const allCompleted = checks.every(
          (c) => c.state === "completed" || c.state === "COMPLETED",
        );
        const noneFailed = checks.every(
          (c) => c.conclusion !== "failure" && c.conclusion !== "FAILURE",
        );
        if (allCompleted && noneFailed) {
          ctx.logger?.info(`[${ctx.stepId}] all checks passed`);
          return {
            success: true,
            outputs: { pr_url: current.url },
          };
        }
      }

      ctx.logger?.info(`[${ctx.stepId}] no changes, polling again in ${runtime.poll_interval ?? DEFAULT_POLL_INTERVAL}s...`);
    }
  }
}
