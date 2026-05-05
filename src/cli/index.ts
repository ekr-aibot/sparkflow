#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { validate } from "../schema/validate.js";
import { WorkflowEngine } from "../engine/engine.js";
import { loadProjectConfig, resolveWorkflowPath, type ProjectConfig } from "../config/project-config.js";
import type { SparkflowWorkflow } from "../schema/types.js";
import type { Logger } from "../engine/types.js";

class StatusJsonLogger implements Logger {
  info(message: string): void {
    // Parse step status from log messages and emit as JSON events on stderr
    const stepMatch = message.match(/^\[(\S+)\] (running|succeeded|failed)/);
    if (stepMatch) {
      const event = { type: "step_status", step: stepMatch[1], state: stepMatch[2] };
      process.stderr.write(JSON.stringify(event) + "\n");
    }

    const startMatch = message.match(/^\[sparkflow\] Starting workflow "(.+)"/);
    if (startMatch) {
      const event = { type: "workflow_start", name: startMatch[1] };
      process.stderr.write(JSON.stringify(event) + "\n");
    }

    const completeMatch = message.match(/^\[sparkflow\] Workflow .+ completed successfully/);
    if (completeMatch) {
      const event = { type: "workflow_complete", success: true };
      process.stderr.write(JSON.stringify(event) + "\n");
    }

    const failMatch = message.match(/^\[sparkflow\] Workflow .+ (failed|aborted)/);
    if (failMatch) {
      const event = { type: "workflow_complete", success: false };
      process.stderr.write(JSON.stringify(event) + "\n");
    }

    // Also pass through to stdout for verbose output
    console.log(message);
  }

  error(message: string): void {
    console.error(message);
  }
}

function setupStdinAnswerReader(engine: WorkflowEngine): void {
  if (!process.stdin.readable) return;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    try {
      const event = JSON.parse(line) as {
        type: string;
        request_id?: string;
        response?: string;
        step_id?: string;
        message?: string;
      };
      if (event.type === "answer" && event.request_id) {
        engine.answerPendingQuestion(event.request_id, event.response ?? "");
      } else if (event.type === "nudge" && event.step_id && typeof event.message === "string") {
        engine.pushNudge(event.step_id, event.message);
      }
    } catch {
      // ignore non-JSON lines
    }
  });
}

function usage(): never {
  console.log(`Usage:
  sparkflow-run validate [<workflow>]
  sparkflow-run run [<workflow>] [--dry-run] [--cwd <dir>] [--plan <plan.md>] [--verbose] [--status-json]

<workflow> may be a path to a JSON file, or a bare name resolved as
.sparkflow/workflows/<name>.json. If omitted, uses "defaultWorkflow" from
.sparkflow/config.json.`);
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

  // Parse --cwd early so config loads from the right directory.
  let cwd: string | undefined;
  const cwdIndex = args.indexOf("--cwd");
  if (cwdIndex !== -1 && args[cwdIndex + 1]) {
    cwd = resolve(args[cwdIndex + 1]);
  }
  const effectiveCwd = cwd ?? process.cwd();

  // Treat the second positional arg as the workflow name/path if it's not a flag.
  const positional = args[1] && !args[1].startsWith("--") ? args[1] : undefined;

  let projectConfig: ProjectConfig;
  let resolvedWorkflowPath: string;
  try {
    projectConfig = loadProjectConfig(effectiveCwd);
    resolvedWorkflowPath = resolveWorkflowPath(positional, effectiveCwd, projectConfig);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const data = loadWorkflow(resolvedWorkflowPath);
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

    let plan: string | undefined;
    const planIndex = args.indexOf("--plan");
    if (planIndex !== -1 && args[planIndex + 1]) {
      const planPath = resolve(args[planIndex + 1]);
      plan = readFileSync(planPath, "utf-8");
    }

    const verbose = args.includes("--verbose");
    const statusJson = args.includes("--status-json");

    let resumeFromStep: string | undefined;
    const resumeFromIndex = args.indexOf("--resume-from");
    if (resumeFromIndex !== -1 && args[resumeFromIndex + 1]) {
      resumeFromStep = args[resumeFromIndex + 1];
    }

    let existingWorktreePath: string | undefined;
    const existingWorktreeIndex = args.indexOf("--existing-worktree");
    if (existingWorktreeIndex !== -1 && args[existingWorktreeIndex + 1]) {
      existingWorktreePath = resolve(args[existingWorktreeIndex + 1]);
    }

    const workflowDir = dirname(resolvedWorkflowPath);

    // When --status-json is active, use a logger that emits JSON events on stderr
    // and reads answer events from stdin
    let logger: import("../engine/types.js").Logger | undefined;
    if (statusJson) {
      logger = new StatusJsonLogger();
    }

    const engine = new WorkflowEngine(data as SparkflowWorkflow, {
      cwd,
      workflowDir,
      dryRun,
      plan,
      verbose,
      logger,
      statusJson,
      config: projectConfig,
      resumeFromStep,
      existingWorktreePath,
    });

    if (statusJson) {
      // Read stdin for answer events
      setupStdinAnswerReader(engine);
    }

    const runResult = await engine.run();

    // Wait for any detached sub-workflows (spawned by the `workflow` runtime) to
    // finish before exiting, so children aren't orphaned.
    const { drainActiveChildren, activeChildCount } = await import("../runtime/workflow.js");
    if (activeChildCount() > 0) {
      console.log(`[sparkflow] waiting for ${activeChildCount()} detached sub-workflow(s) to finish...`);
      await drainActiveChildren();
      console.log(`[sparkflow] all sub-workflows finished.`);
    }

    process.exit(runResult.success ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
