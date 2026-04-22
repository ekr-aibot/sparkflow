#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const issuesRepo = process.env.SPARKFLOW_ISSUES_REPO ?? process.env.SPARKFLOW_PR_REPO;
const repoArgs = issuesRepo ? ["--repo", issuesRepo] : [];

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf-8" });
}

let toDispatch;
try {
  const candidates = JSON.parse(gh([
    "issue", "list", ...repoArgs,
    "--label", "ready-for-sparkflow", "--state", "open",
    "--json", "number,title,body,labels",
  ]));

  toDispatch = candidates
    .filter((issue) => !(issue.labels ?? []).some((l) => l.name === "in-progress"))
    .map((issue) => ({
      issue_number: issue.number,
      title: issue.title,
      body: (issue.body ?? "").slice(0, 2000),
    }));
} catch (err) {
  process.stderr.write(`[github-poller] network error, skipping poll: ${err.message}\n`);
  process.stdout.write("[]");
  process.exit(0);
}

for (const item of toDispatch) {
  process.stderr.write(`[github-poller] claiming #${item.issue_number}\n`);
  try {
    execFileSync(
      "gh",
      ["issue", "edit", String(item.issue_number), ...repoArgs, "--add-label", "in-progress"],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  } catch (err) {
    process.stderr.write(`[github-poller] failed to claim #${item.issue_number}: ${err.message}\n`);
  }
}

process.stdout.write(JSON.stringify(toDispatch));
