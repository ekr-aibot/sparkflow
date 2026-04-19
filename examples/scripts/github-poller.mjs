#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const repoArgs = process.env.SPARKFLOW_PR_REPO
  ? ["--repo", process.env.SPARKFLOW_PR_REPO]
  : [];

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf-8" });
}

const candidates = JSON.parse(gh([
  "issue", "list", ...repoArgs,
  "--label", "ready-for-claude", "--state", "open",
  "--json", "number,title,body,labels",
]));

const toDispatch = candidates
  .filter((issue) => !(issue.labels ?? []).some((l) => l.name === "in-progress"))
  .map((issue) => ({
    issue_number: issue.number,
    title: issue.title,
    body: (issue.body ?? "").slice(0, 2000),
  }));

for (const item of toDispatch) {
  process.stderr.write(`[github-poller] claiming #${item.issue_number}\n`);
  execFileSync(
    "gh",
    ["issue", "edit", String(item.issue_number), ...repoArgs, "--add-label", "in-progress"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
}

process.stdout.write(JSON.stringify(toDispatch));
