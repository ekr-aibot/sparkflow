#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { validate } from "../schema/validate.js";
import { WorkflowEngine } from "../engine/engine.js";
import type { SparkflowWorkflow } from "../schema/types.js";

function usage(): never {
  console.log(`Usage:
  sparkflow validate <workflow.json>
  sparkflow run <workflow.json> [--dry-run] [--cwd <dir>] [--plan <plan.md>] [--verbose]`);
  process.exit(1);
}

function loadWorkflow(path: string): unknown {
  const resolved = resolve(path);
  const content = readFileSync(resolved, "utf-8");
  return JSON.parse(content);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !["validate", "run"].includes(command)) {
    usage();
  }

  const workflowPath = args[1];
  if (!workflowPath) {
    console.error("Error: workflow file path is required");
    usage();
  }

  const data = loadWorkflow(workflowPath);
  const result = validate(data);

  if (command === "validate") {
    for (const err of result.errors) {
      console.error(`ERROR: ${err.message}${err.path ? ` (at ${err.path})` : ""}`);
    }
    for (const warn of result.warnings) {
      console.warn(`WARN: ${warn.message}${warn.path ? ` (at ${warn.path})` : ""}`);
    }

    if (result.valid) {
      console.log("Workflow is valid.");
      process.exit(0);
    } else {
      console.error("Workflow has errors.");
      process.exit(1);
    }
  }

  if (command === "run") {
    if (!result.valid) {
      for (const err of result.errors) {
        console.error(`ERROR: ${err.message}${err.path ? ` (at ${err.path})` : ""}`);
      }
      console.error("Workflow validation failed. Cannot run.");
      process.exit(1);
    }

    const dryRun = args.includes("--dry-run");
    let cwd: string | undefined;
    const cwdIndex = args.indexOf("--cwd");
    if (cwdIndex !== -1 && args[cwdIndex + 1]) {
      cwd = resolve(args[cwdIndex + 1]);
    }

    let plan: string | undefined;
    const planIndex = args.indexOf("--plan");
    if (planIndex !== -1 && args[planIndex + 1]) {
      const planPath = resolve(args[planIndex + 1]);
      plan = readFileSync(planPath, "utf-8");
    }

    const verbose = args.includes("--verbose");

    const workflowDir = dirname(resolve(workflowPath));
    const engine = new WorkflowEngine(data as SparkflowWorkflow, {
      cwd,
      workflowDir,
      dryRun,
      plan,
      verbose,
    });

    const runResult = await engine.run();
    process.exit(runResult.success ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
