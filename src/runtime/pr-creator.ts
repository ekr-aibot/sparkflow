import { execFileSync, spawn as nodeSpawn } from "node:child_process";
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

interface PrView {
  number: number;
  url: string;
}

interface RepoView {
  defaultBranchRef: { name: string };
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

    const model = runtime.model ?? DEFAULT_MODEL;
    const pushRemote = ctx.git?.push_remote ?? "origin";
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
    // If the developer already pushed, warn but continue.
    try {
      execFileSync("git", ["push", "-u", pushRemote, "HEAD"], {
        cwd: ctx.cwd,
        stdio: "pipe",
        timeout: 60_000,
      });
      ctx.logger?.info(`[${ctx.stepId}] pushed branch to ${pushRemote}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // If the remote already has this branch with the same commits, that's fine
      const alreadyUpToDate =
        errMsg.includes("Everything up-to-date") ||
        errMsg.includes("everything up-to-date");
      if (alreadyUpToDate) {
        ctx.logger?.info(`[${ctx.stepId}] branch already pushed, continuing`);
      } else {
        // Try force-free push — maybe the developer pushed earlier commits
        // and we just need to update. Attempt a regular push (non-force)
        // one more time to surface the real error if it persists.
        ctx.logger?.info(`[${ctx.stepId}] push failed (${errMsg}), retrying...`);
        try {
          execFileSync("git", ["push", "-u", "origin", "HEAD"], {
            cwd: ctx.cwd,
            stdio: "pipe",
            timeout: 60_000,
          });
          ctx.logger?.info(`[${ctx.stepId}] pushed branch to remote on retry`);
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return {
            success: false,
            outputs: {},
            error: `Failed to push: ${retryMsg}`,
          };
        }
      }
    }

    // Step 3: Gather diff context
    let diffContext: string;
    try {
      const log = execFileSync("git", ["log", `${baseBranch}..HEAD`, "--oneline"], {
        cwd: ctx.cwd,
        stdio: "pipe",
      }).toString().trim();

      const stat = execFileSync("git", ["diff", `${baseBranch}...HEAD`, "--stat"], {
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

    // Step 5: Create PR (or adopt an existing one for this branch)
    try {
      const createArgs = [
        "pr",
        "create",
        ...repoArgs,
        "--base",
        baseBranch,
        "--title",
        title,
        "--body",
        summary,
      ];
      gh(createArgs, ctx.cwd);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const alreadyExists =
        errMsg.includes("already exists") ||
        errMsg.includes("A pull request already exists");
      if (alreadyExists) {
        ctx.logger?.info(`[${ctx.stepId}] PR already exists for this branch, using it`);
      } else {
        return {
          success: false,
          outputs: {},
          error: `Failed to create PR: ${errMsg}`,
        };
      }
    }

    // Step 6: Get PR info
    try {
      const pr = ghJson<PrView>(
        ["pr", "view", ...repoArgs, "--json", "number,url"],
        ctx.cwd,
      );
      ctx.logger?.info(`[${ctx.stepId}] PR ready: ${pr.url}`);
      return {
        success: true,
        outputs: { pr_url: pr.url },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        outputs: {},
        error: `PR created but failed to retrieve info: ${errMsg}`,
      };
    }
  }
}
