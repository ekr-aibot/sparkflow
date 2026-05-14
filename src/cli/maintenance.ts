#!/usr/bin/env node

/**
 * sparkflow-maintenance — maintenance state management for the auto-develop workflow.
 *
 * Subcommands:
 *   decide [--cwd <dir>]
 *     Reads config and state, decides whether a maintenance pass is due.
 *     Prints JSON { run, reason, pmEnabled, architectEnabled } to stdout.
 *     Exits 0 when a pass should run; exits 1 otherwise.
 *
 *   record-task-completed [--cwd <dir>]
 *     Increments tasksCompletedSinceLastMaintenance. Idempotent on missing file.
 *
 *   record-maintenance-done [--cwd <dir>] [--pm-added N] [--architect-added N]
 *     Resets cycle counter, updates lastMaintenanceAt, persists task-added counts,
 *     and commits ROADMAP.md if it has unstaged changes.
 *
 *   is-enabled <pm|architect> [--cwd <dir>]
 *     Exits 0 if the named agent is enabled in config; 1 if not.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseTasks } from "./dashboard.js";
import { loadProjectConfig, resolveMaintenanceConfig } from "../config/project-config.js";

interface MaintenanceState {
  tasksCompletedSinceLastMaintenance: number;
  lastMaintenanceAt: string;
  /** null means maintenance has never run (queue-low trigger is not suppressed). */
  lastMaintenanceTasksAdded: { pm: number; architect: number } | null;
}

const STATE_PATH = ".sparkflow/state/auto-develop-maintenance.json";

function parseCwd(argv: string[]): string {
  const idx = argv.indexOf("--cwd");
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : process.cwd();
}

function readState(cwd: string): MaintenanceState {
  const path = join(cwd, STATE_PATH);
  if (!existsSync(path)) {
    return {
      tasksCompletedSinceLastMaintenance: 0,
      lastMaintenanceAt: "1970-01-01T00:00:00.000Z",
      lastMaintenanceTasksAdded: null,
    };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MaintenanceState>;
    return {
      tasksCompletedSinceLastMaintenance: parsed.tasksCompletedSinceLastMaintenance ?? 0,
      lastMaintenanceAt: parsed.lastMaintenanceAt ?? "1970-01-01T00:00:00.000Z",
      lastMaintenanceTasksAdded: parsed.lastMaintenanceTasksAdded ?? null,
    };
  } catch {
    return {
      tasksCompletedSinceLastMaintenance: 0,
      lastMaintenanceAt: "1970-01-01T00:00:00.000Z",
      lastMaintenanceTasksAdded: null,
    };
  }
}

function writeState(cwd: string, state: MaintenanceState): void {
  const dir = join(cwd, ".sparkflow/state");
  mkdirSync(dir, { recursive: true });
  const path = join(cwd, STATE_PATH);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, path);
}

function countPendingTasks(cwd: string): number {
  try {
    const md = readFileSync(join(cwd, "ROADMAP.md"), "utf-8");
    return parseTasks(md).filter((t) => t.status === "pending").length;
  } catch {
    return 0;
  }
}

function loadConfig(cwd: string) {
  try {
    return loadProjectConfig(cwd);
  } catch {
    return {};
  }
}

function cmdDecide(argv: string[]): never {
  const cwd = parseCwd(argv);
  const config = loadConfig(cwd);
  const maint = resolveMaintenanceConfig(config);
  const { pm: pmEnabled, architect: architectEnabled } = maint;

  if (!pmEnabled && !architectEnabled) {
    process.stdout.write(
      JSON.stringify({ run: "none", reason: "both agents disabled", pmEnabled, architectEnabled }) + "\n",
    );
    process.exit(1);
  }

  const state = readState(cwd);
  const pending = countPendingTasks(cwd);

  // null means maintenance never ran — treat as "previous run added tasks" to allow first-run trigger.
  const lastAdded =
    state.lastMaintenanceTasksAdded === null
      ? 1
      : state.lastMaintenanceTasksAdded.pm + state.lastMaintenanceTasksAdded.architect;

  const queueLow = pending < maint.queueThreshold && lastAdded !== 0;
  const cycleDue = state.tasksCompletedSinceLastMaintenance >= maint.cycleInterval;

  if (queueLow || cycleDue) {
    const reason = cycleDue
      ? `cycle due (${state.tasksCompletedSinceLastMaintenance} tasks completed since last maintenance)`
      : `queue low (${pending} pending < threshold ${maint.queueThreshold})`;
    process.stdout.write(
      JSON.stringify({ run: "pm-then-architect", reason, pmEnabled, architectEnabled }) + "\n",
    );
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({ run: "none", reason: "no trigger condition met", pmEnabled, architectEnabled }) + "\n",
  );
  process.exit(1);
}

function cmdRecordTaskCompleted(argv: string[]): void {
  const cwd = parseCwd(argv);
  const state = readState(cwd);
  state.tasksCompletedSinceLastMaintenance++;
  writeState(cwd, state);
}

function parseCount(val: string | undefined): number {
  if (!val) return 0;
  const n = parseInt(val, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

function cmdRecordMaintenanceDone(argv: string[]): void {
  const cwd = parseCwd(argv);

  const pmAddedIdx = argv.indexOf("--pm-added");
  const architectAddedIdx = argv.indexOf("--architect-added");
  const pmAdded = parseCount(pmAddedIdx !== -1 ? argv[pmAddedIdx + 1] : undefined);
  const architectAdded = parseCount(architectAddedIdx !== -1 ? argv[architectAddedIdx + 1] : undefined);

  const state = readState(cwd);
  state.tasksCompletedSinceLastMaintenance = 0;
  state.lastMaintenanceAt = new Date().toISOString();
  state.lastMaintenanceTasksAdded = { pm: pmAdded, architect: architectAdded };
  writeState(cwd, state);

  // Commit ROADMAP.md if it has unstaged changes.
  try {
    const statusOut = execFileSync("git", ["status", "--porcelain", "ROADMAP.md"], {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    if (statusOut.trim()) {
      execFileSync("git", ["add", "ROADMAP.md"], { cwd, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "chore: maintenance pass (PM/architect)"], {
        cwd,
        stdio: "pipe",
      });
    }
  } catch {
    // Non-fatal: git may not be available or working tree may be clean.
  }
}

function cmdIsEnabled(argv: string[]): never {
  const agent = argv[0];
  const cwd = parseCwd(argv.slice(1));
  const config = loadConfig(cwd);
  const maint = resolveMaintenanceConfig(config);

  if (agent === "pm") {
    process.exit(maint.pm ? 0 : 1);
  } else if (agent === "architect") {
    process.exit(maint.architect ? 0 : 1);
  } else {
    process.stderr.write(
      `sparkflow-maintenance is-enabled: unknown agent "${agent ?? "(none)"}". Use "pm" or "architect".\n`,
    );
    process.exit(2);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const sub = args[0];

  switch (sub) {
    case "decide":
      cmdDecide(args.slice(1));
      break;
    case "record-task-completed":
      cmdRecordTaskCompleted(args.slice(1));
      break;
    case "record-maintenance-done":
      cmdRecordMaintenanceDone(args.slice(1));
      break;
    case "is-enabled":
      cmdIsEnabled(args.slice(1));
      break;
    default:
      process.stderr.write(
        `sparkflow-maintenance: unknown subcommand "${sub ?? "(none)"}"\n` +
          "Usage: sparkflow-maintenance <decide|record-task-completed|record-maintenance-done|is-enabled> [options]\n",
      );
      process.exit(1);
  }
}

main();
