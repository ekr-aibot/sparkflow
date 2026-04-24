import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { statSync } from "node:fs";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "./types.js";
import type { PrCreatorRuntime } from "../schema/types.js";

const DEFAULT_MODEL = "sonnet";

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

interface RepoView {
  defaultBranchRef: { name: string };
}

interface PrView {
  url: string;
}

function generateTitleSummary(
  diffContext: string,
  model: string,
  cwd: string,
): Promise<{ title: string; summary: string }> {
  return new Promise((resolve, reject) => {
    const prompt = `You are generating a pull request title and summary. Based on the following git diff context, produce a JSON object with exactly two keys: "title" (a concise PR title under 70 characters) and "summary" (a markdown summary of the changes, 2-5 bullet points).

Respond with ONLY the JSON object, no other text.

${diffContext}`;

    const child = nodeSpawn(
      "claude",
      ["--print", "--output-format", "json", "--model", model],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        // claude --output-format json wraps the response; extract the text content
        const outer = JSON.parse(stdout);
        let text: string;
        if (typeof outer === "string") {
          text = outer;
        } else if (Array.isArray(outer)) {
          // [{type:"text", text:"..."}]
          const textBlock = outer.find((b: { type: string }) => b.type === "text");
          text = textBlock?.text ?? stdout;
        } else if (typeof outer === "object" && outer.result) {
          text = typeof outer.result === "string" ? outer.result : JSON.stringify(outer.result);
        } else if (typeof outer === "object" && outer.title) {
          // Already the shape we want
          resolve({ title: outer.title, summary: outer.summary ?? "" });
          return;
        } else {
          text = stdout;
        }

        // Try to extract JSON from the text
        const jsonMatch = text.match(/\{[\s\S]*"title"[\s\S]*"summary"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          resolve({ title: parsed.title, summary: parsed.summary });
        } else {
          const parsed = JSON.parse(text);
          resolve({ title: parsed.title, summary: parsed.summary });
        }
      } catch {
        reject(new Error(`Failed to parse claude response: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function getFallbackTitleSummary(cwd: string, baseBranch: string): { title: string; summary: string } {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    stdio: "pipe",
  }).toString().trim();

  let commitLog: string;
  try {
    commitLog = execFileSync("git", ["log", `${baseBranch}..HEAD`, "--oneline"], {
      cwd,
      stdio: "pipe",
    }).toString().trim();
  } catch {
    commitLog = "";
  }

  const title = branch.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const summary = commitLog
    ? `## Commits\n\n${commitLog.split("\n").map((l) => `- ${l}`).join("\n")}`
    : `Changes from branch \`${branch}\``;

  return { title, summary };
}

export class PrCreatorAdapter implements RuntimeAdapter {
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    const runtime = ctx.runtime as PrCreatorRuntime;
    if (runtime.type !== "pr-creator") {
      throw new Error(`PrCreatorAdapter received non-pr-creator runtime: ${runtime.type}`);
    }

    const cwdStat = (() => { try { return statSync(ctx.cwd); } catch { return null; } })();
    if (!cwdStat || !cwdStat.isDirectory()) {
      return { success: false, outputs: {}, error: `cwd does not exist or is not a directory: ${ctx.cwd}` };
    }
    ctx.logger?.info(`[${ctx.stepId}] cwd=${ctx.cwd}`);

    const model = runtime.model ?? DEFAULT_MODEL;
    const pushRemote = ctx.git?.push_remote ?? "origin";
    const pullRemote = ctx.git?.pull_remote ?? pushRemote;
    const targetRepo = ctx.git?.pr_repo;
    const repoArgs = targetRepo ? ["--repo", targetRepo] : [];

    // Step 1: Get base branch (from configured target repo, or fall back).
    let baseBranch: string;
    if (ctx.git?.base) {
      baseBranch = ctx.git.base;
    } else {
      try {
        const repoInfo = ghJson<RepoView>(
          ["repo", "view", ...repoArgs, "--json", "defaultBranchRef"],
          ctx.cwd,
        );
        baseBranch = repoInfo.defaultBranchRef.name;
      } catch {
        baseBranch = "main";
      }
    }

    // Step 2: Push current branch to the configured remote.
    // Each workflow run uses an isolated worktree with its own branch,
    // so the branch is already unique — just push it.
    // If the branch was rebased the push will be rejected as non-fast-forward;
    // retry with --force-with-lease in that case.
    try {
      execFileSync("git", ["push", "-u", pushRemote, "HEAD"], {
        cwd: ctx.cwd,
        stdio: "pipe",
        timeout: 60_000,
      });
      ctx.logger?.info(`[${ctx.stepId}] pushed branch to ${pushRemote}`);
    } catch (err) {
      const errObj = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
      const combined = [
        errObj.stderr?.toString() ?? "",
        errObj.stdout?.toString() ?? "",
        errObj.message ?? "",
      ].join("\n");

      const alreadyUpToDate =
        combined.includes("Everything up-to-date") ||
        combined.includes("everything up-to-date");

      if (alreadyUpToDate) {
        ctx.logger?.info(`[${ctx.stepId}] branch already pushed, continuing`);
      } else if (
        combined.includes("non-fast-forward") ||
        combined.includes("[rejected]") ||
        combined.includes("fetch first") ||
        combined.includes("Updates were rejected")
      ) {
        // Branch was rebased; force-push with lease so we don't silently
        // overwrite any concurrent push to the same ref.
        ctx.logger?.info(`[${ctx.stepId}] push rejected (rebased branch), retrying with --force-with-lease`);
        try {
          execFileSync("git", ["push", "-u", "--force-with-lease", pushRemote, "HEAD"], {
            cwd: ctx.cwd,
            stdio: "pipe",
            timeout: 60_000,
          });
          ctx.logger?.info(`[${ctx.stepId}] force-pushed branch to ${pushRemote}`);
        } catch (forceErr) {
          const forceObj = forceErr as { stderr?: Buffer; stdout?: Buffer; message?: string };
          const forceMsg = [
            forceObj.stderr?.toString() ?? "",
            forceObj.message ?? "",
          ].filter(Boolean).join(": ");
          return {
            success: false,
            outputs: {},
            error: `Failed to push: ${forceMsg}`,
          };
        }
      } else {
        return {
          success: false,
          outputs: {},
          error: `Failed to push: ${errObj.message ?? combined}`,
        };
      }
    }

    // Step 3: Gather diff context
    // Fetch from pull_remote best-effort so the remote ref is up to date for diffing.
    try {
      execFileSync("git", ["fetch", pullRemote, baseBranch], {
        cwd: ctx.cwd,
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch (fetchErr) {
      const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      ctx.logger?.info(`[${ctx.stepId}] fetch from ${pullRemote} failed (offline?): ${fetchMsg}`);
    }

    // Use <pullRemote>/<baseBranch> as diff base if available, else fall back to bare branch.
    let diffBase = baseBranch;
    try {
      execFileSync("git", ["rev-parse", "--verify", `${pullRemote}/${baseBranch}`], {
        cwd: ctx.cwd,
        stdio: "pipe",
      });
      diffBase = `${pullRemote}/${baseBranch}`;
    } catch {
      // Remote ref doesn't exist locally; use bare branch name.
    }

    let diffContext: string;
    try {
      const log = execFileSync("git", ["log", `${diffBase}..HEAD`, "--oneline"], {
        cwd: ctx.cwd,
        stdio: "pipe",
      }).toString().trim();

      const stat = execFileSync("git", ["diff", `${diffBase}...HEAD`, "--stat"], {
        cwd: ctx.cwd,
        stdio: "pipe",
      }).toString().trim();

      diffContext = `## Commits\n${log}\n\n## Changed files\n${stat}`;
    } catch {
      diffContext = "Unable to gather diff context";
    }

    // Step 4: Generate title and summary
    let title: string;
    let summary: string;
    try {
      const result = await generateTitleSummary(diffContext, model, ctx.cwd);
      title = result.title;
      summary = result.summary;
      ctx.logger?.info(`[${ctx.stepId}] generated PR title: ${title}`);
    } catch (err) {
      ctx.logger?.info(`[${ctx.stepId}] claude summarization failed, using fallback`);
      const fallback = getFallbackTitleSummary(ctx.cwd, baseBranch);
      title = fallback.title;
      summary = fallback.summary;
    }

    // Step 5: Append "Fixes #N" if the plan references a GitHub issue.
    const issueMatch = ctx.prompt?.match(/Work GitHub Issue #(\d+)/i);
    const body = issueMatch ? `${summary}\n\nFixes #${issueMatch[1]}` : summary;

    // Step 6: Create PR (or adopt an existing one for this branch).
    // `gh pr create` prints the new PR URL to stdout — capture it directly
    // so we don't need a follow-up `gh pr view`, which is brittle when the
    // branch isn't yet tracked.
    let prUrl: string | undefined;
    try {
      const out = gh(
        [
          "pr",
          "create",
          ...repoArgs,
          "--base",
          baseBranch,
          "--title",
          title,
          "--body",
          body,
        ],
        ctx.cwd,
      );
      const match = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      if (!match) {
        return {
          success: false,
          outputs: {},
          error: `Could not parse PR URL from gh output: ${out}`,
        };
      }
      prUrl = match[0];
    } catch (err) {
      // execFileSync throws with stderr/stdout buffers attached; pull them all
      // so we can grep for both the "already exists" marker and, critically,
      // the existing PR URL that gh embeds in that error message. Parsing the
      // URL directly avoids a follow-up `gh pr view`, which is unreliable for
      // cross-fork PRs (head on one remote, base on another — `gh pr view
      // <branch> --repo X/Y` returns "no pull requests found" even though the
      // PR exists).
      const errObj = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
      const combined = [
        errObj.stderr?.toString() ?? "",
        errObj.stdout?.toString() ?? "",
        errObj.message ?? "",
      ].join("\n");

      const alreadyExists = /already exists|A pull request already exists/i.test(combined);
      if (!alreadyExists) {
        return {
          success: false,
          outputs: {},
          error: `Failed to create PR: ${errObj.message ?? String(err)}`,
        };
      }

      ctx.logger?.info(`[${ctx.stepId}] PR already exists for this branch, using it`);
      const urlMatch = combined.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      if (urlMatch) {
        prUrl = urlMatch[0];
      } else {
        // Fallback: ask gh. `gh pr view <branch> --repo X/Y` works for same-repo
        // PRs. If the PR is cross-fork this still won't find it, and we surface
        // the real error; the user can wire the PR URL through manually.
        try {
          const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: ctx.cwd,
            stdio: "pipe",
          }).toString().trim();
          const pr = ghJson<PrView>(
            ["pr", "view", branch, ...repoArgs, "--json", "url"],
            ctx.cwd,
          );
          prUrl = pr.url;
        } catch (viewErr) {
          const viewMsg = viewErr instanceof Error ? viewErr.message : String(viewErr);
          return {
            success: false,
            outputs: {},
            error: `PR exists but no URL found in gh output and fallback view failed: ${viewMsg}`,
          };
        }
      }
    }

    ctx.logger?.info(`[${ctx.stepId}] PR ready: ${prUrl}`);
    return {
      success: true,
      outputs: { pr_url: prUrl },
    };
  }
}
