#!/usr/bin/env node

import { resolve } from "node:path";
import { runKillAll, formatSummary } from "./kill-all.js";

function usage(exitCode = 0): never {
  console.log(`Usage: sparkflow-kill [--cwd <dir>] [--all] [--force]

Kills every sparkflow process for the given repo (cwd defaults to $PWD):
  - All non-terminal jobs recorded in <cwd>/.sparkflow/state/jobs/
  - The engine daemon for this repo (discovered via per-repo PID file)

With --all, also kills the user-global frontend daemon
(~/.sparkflow/dashboard.json).

With --force, SIGKILLs anything still alive after a 5s grace period.`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    usage(0);
  }

  // Validate unknown flags.
  const known = new Set(["--cwd", "--all", "--force"]);
  for (const arg of args) {
    if (arg.startsWith("--") && !known.has(arg)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
  }

  let cwd = process.cwd();
  const cwdIndex = args.indexOf("--cwd");
  if (cwdIndex !== -1) {
    const dir = args[cwdIndex + 1];
    if (!dir || dir.startsWith("--")) {
      console.error("--cwd requires a directory argument");
      process.exit(1);
    }
    cwd = resolve(dir);
  }

  const force = args.includes("--force");
  const all = args.includes("--all");

  const result = await runKillAll({ cwd, force, all });
  console.log(formatSummary(result, force));
  for (const e of result.errors) {
    console.error(`  ${e.jobId} (pid ${e.pid}): ${e.error}`);
  }
  const failed = result.stillAlive > 0 || result.errors.length > 0;
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
