#!/usr/bin/env node
/**
 * github-poller-dispatch.mjs
 *
 * Reads polled GitHub issues from SPARKFLOW_POLLED_ITEMS (JSON array), builds
 * a plan for each, and writes one dispatch-queue request file per issue so the
 * dashboard watcher picks it up and launches a top-level feature-development job.
 *
 * Stdout is unused. Diagnostics go to stderr.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const itemsJson = process.env.SPARKFLOW_POLLED_ITEMS ?? "[]";
let items;
try {
  items = JSON.parse(itemsJson);
} catch (err) {
  process.stderr.write(`[github-poller-dispatch] failed to parse SPARKFLOW_POLLED_ITEMS: ${err.message}\n`);
  process.exit(1);
}

if (!Array.isArray(items) || items.length === 0) {
  process.stderr.write("[github-poller-dispatch] no items to dispatch\n");
  process.exit(0);
}

const queueDir = join(process.cwd(), ".sparkflow", "dispatch-queue");
mkdirSync(queueDir, { recursive: true });

for (const item of items) {
  const plan = buildPlan(item);
  const slug = `issue ${item.issue_number}`;
  const description = item.title ? `#${item.issue_number}: ${item.title}` : undefined;
  const nonce = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const req = { workflow_path: "feature-development", plan_text: plan, slug, description };
  const reqPath = join(queueDir, `${nonce}-issue-${item.issue_number}.json`);
  writeFileSync(reqPath, JSON.stringify(req));
  process.stderr.write(`[github-poller-dispatch] queued #${item.issue_number} → ${reqPath}\n`);
}

function buildPlan(item) {
  return [
    `# Work GitHub Issue #${item.issue_number}`,
    "",
    `**Title:** ${item.title}`,
    "",
    `## Issue body`,
    "",
    item.body || "_(no body)_",
    "",
    `## Your task`,
    "",
    `Read the issue carefully and implement/fix the behavior described. Follow the repo's conventions. When done, commit and let downstream steps (reviewer, test, pr-create) run.`,
  ].join("\n");
}
