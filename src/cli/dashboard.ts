#!/usr/bin/env node

/**
 * sparkflow-dashboard — dashboard CLI for sparkflow workflows.
 *
 * Subcommands:
 *   state set-from-roadmap [projectDir]   — parse ROADMAP.md and write state.json
 *   state put <json-pointer> <value>      — atomic JSON-pointer write to state.json
 *   scaffold [--force] [projectDir]       — copy SPA assets to .sparkflow/dashboard/
 *
 * Legacy (no subcommand):
 *   sparkflow-dashboard [projectDir]      — writes .sparkflow/dashboard.html (deprecated)
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "done" | "pending" | "blocked" | "in_progress";

export interface Task {
  line: number;
  status: TaskStatus;
  text: string;
  blockedReason?: string;
  id: string;
  currentJobId?: string;
}

export interface TaskSection {
  title: string | null;
  tasks: Task[];
}

export interface TaskSummary {
  done: number;
  pending: number;
  blocked: number;
  in_progress: number;
  total: number;
}

export interface RecentActivity {
  event: "completed" | "blocked" | "started";
  task: string;
  at: string;
}

export interface DashboardState {
  workflow: string;
  sections: TaskSection[];
  summary: TaskSummary;
  recent: RecentActivity[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// ROADMAP parser (section-aware)
// ---------------------------------------------------------------------------

const TASK_RE = /^- \[( |x|!)\] (.+?)(?:\s*<!--\s*blocked:\s*(.+?)\s*-->)?$/;
const SECTION_RE = /^##\s+(.+)$/;

export function parseTasks(md: string): Task[] {
  const sections = parseSections(md);
  const tasks: Task[] = [];
  for (const s of sections) tasks.push(...s.tasks);
  return tasks;
}

export function parseSections(md: string): TaskSection[] {
  const lines = md.split("\n");
  const sections: TaskSection[] = [];
  let currentTitle: string | null = null;
  let currentTasks: Task[] = [];

  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = lines[i].match(SECTION_RE);
    if (sectionMatch) {
      if (currentTasks.length > 0 || currentTitle !== null) {
        sections.push({ title: currentTitle, tasks: currentTasks });
      }
      currentTitle = sectionMatch[1].trim();
      currentTasks = [];
      continue;
    }

    const m = lines[i].match(TASK_RE);
    if (!m) continue;
    const [, marker, rawText, blockedReason] = m;
    const status: TaskStatus =
      marker === "x" ? "done" : marker === "!" ? "blocked" : "pending";
    const text = rawText.trim();
    const id = stableId(text);
    const t: Task = { line: i + 1, status, text, id };
    if (blockedReason) t.blockedReason = blockedReason.trim();
    currentTasks.push(t);
  }

  if (currentTasks.length > 0 || currentTitle !== null) {
    sections.push({ title: currentTitle, tasks: currentTasks });
  }

  // If nothing parsed at all, return empty
  if (sections.length === 0) return [];

  // If the only section has null title and no tasks, drop it
  if (sections.length === 1 && sections[0].title === null && sections[0].tasks.length === 0) {
    return [];
  }

  return sections;
}

// IDs are hashed from task text; two tasks with identical wording in different
// sections share the same ID. The recent-diff uses prevById.get(id) and will
// attribute a status change to whichever task it finds first, which is the
// correct one in practice (ROADMAP tasks are rarely duplicated verbatim).
function stableId(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Build state.json from ROADMAP.md
// ---------------------------------------------------------------------------

export function buildStateFromRoadmap(
  md: string | null,
  prevState: DashboardState | null,
  now: Date,
): DashboardState {
  const sections = md ? parseSections(md) : [];

  const allTasks = sections.flatMap((s) => s.tasks);
  const done = allTasks.filter((t) => t.status === "done").length;
  const pending = allTasks.filter((t) => t.status === "pending").length;
  const blocked = allTasks.filter((t) => t.status === "blocked").length;
  const in_progress = allTasks.filter((t) => t.status === "in_progress").length;
  const total = allTasks.length;

  const summary: TaskSummary = { done, pending, blocked, in_progress, total };

  // Build recent activity by diffing against previous state
  const recent: RecentActivity[] = [...(prevState?.recent ?? [])];

  if (prevState) {
    const prevById = new Map<string, Task>();
    for (const s of prevState.sections) {
      for (const t of s.tasks) prevById.set(t.id, t);
    }

    for (const task of allTasks) {
      const prev = prevById.get(task.id);
      if (!prev) continue;
      if (prev.status !== task.status) {
        if (task.status === "done") {
          recent.unshift({ event: "completed", task: task.text, at: now.toISOString() });
        } else if (task.status === "blocked") {
          recent.unshift({ event: "blocked", task: task.text, at: now.toISOString() });
        } else if (task.status === "in_progress") {
          recent.unshift({ event: "started", task: task.text, at: now.toISOString() });
        }
      }
    }
  }

  // Cap at 20 entries
  recent.splice(20);

  return {
    workflow: "auto-develop",
    sections,
    summary,
    recent,
    updatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Atomic state.json write via .tmp + rename
// ---------------------------------------------------------------------------

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// JSON-pointer-style put (simplified: only supports /key/key/... paths)
// ---------------------------------------------------------------------------

export function applyJsonPointer(obj: unknown, pointer: string, value: unknown): unknown {
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON pointer: ${pointer}`);
  const parts = pointer.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) return value;

  function set(node: unknown, keys: string[]): unknown {
    const [key, ...rest] = keys;
    if (rest.length === 0) {
      // Leaf
      if (Array.isArray(node)) {
        const idx = parseInt(key, 10);
        if (isNaN(idx)) throw new Error(`expected array index, got: ${key}`);
        const copy = [...node];
        copy[idx] = value;
        return copy;
      } else {
        return { ...(node as Record<string, unknown>), [key]: value };
      }
    }
    // Recurse
    if (Array.isArray(node)) {
      const idx = parseInt(key, 10);
      if (isNaN(idx)) throw new Error(`expected array index, got: ${key}`);
      const copy = [...node];
      copy[idx] = set(copy[idx] ?? {}, rest);
      return copy;
    } else {
      const rec = (node ?? {}) as Record<string, unknown>;
      return { ...rec, [key]: set(rec[key] ?? {}, rest) };
    }
  }

  return set(obj, parts);
}

// ---------------------------------------------------------------------------
// Scaffold: copy SPA assets into .sparkflow/dashboard/
// ---------------------------------------------------------------------------

function findSpaAssets(): string | null {
  // In built form: dist/src/cli/dashboard.js → pkg root is 3 up from dir
  // pkg root / src/dashboard/auto-develop-spa
  const candidates = [
    join(__dirname, "..", "dashboard", "auto-develop-spa"),
    join(__dirname, "..", "..", "..", "src", "dashboard", "auto-develop-spa"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function cmdSetFromRoadmap(projectDir: string): void {
  const roadmapPath = join(projectDir, "ROADMAP.md");
  let md: string | null = null;
  try {
    md = readFileSync(roadmapPath, "utf-8");
  } catch { /* ROADMAP.md missing is fine */ }

  const dashDir = join(projectDir, ".sparkflow", "dashboard");
  mkdirSync(dashDir, { recursive: true });

  const statePath = join(dashDir, "state.json");
  const lastStatePath = join(dashDir, ".last-state.json");

  let prevState: DashboardState | null = null;
  try {
    const raw = readFileSync(lastStatePath, "utf-8");
    prevState = JSON.parse(raw) as DashboardState;
  } catch { /* missing or invalid is fine */ }

  const state = buildStateFromRoadmap(md, prevState, new Date());

  atomicWriteJson(statePath, state);
  atomicWriteJson(lastStatePath, state);
}

export function cmdStatePut(pointer: string, rawValue: string, projectDir: string): void {
  const dashDir = join(projectDir, ".sparkflow", "dashboard");
  mkdirSync(dashDir, { recursive: true });

  const statePath = join(dashDir, "state.json");

  let current: unknown = {};
  try {
    current = JSON.parse(readFileSync(statePath, "utf-8"));
  } catch { /* missing or invalid — start fresh */ }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(rawValue);
  } catch {
    parsedValue = rawValue;
  }

  const updated = applyJsonPointer(current, pointer, parsedValue);
  atomicWriteJson(statePath, updated);
}

function cmdScaffold(projectDir: string, force: boolean): void {
  const spaDir = findSpaAssets();
  if (!spaDir) {
    process.stderr.write("sparkflow-dashboard scaffold: SPA assets not found\n");
    process.exit(1);
  }

  const destDir = join(projectDir, ".sparkflow", "dashboard");
  mkdirSync(destDir, { recursive: true });

  const files = readdirSync(spaDir);
  for (const file of files) {
    const dest = join(destDir, file);
    if (!force && existsSync(dest)) continue;
    copyFileSync(join(spaDir, file), dest);
  }
}

// ---------------------------------------------------------------------------
// Legacy HTML generation (backward compat)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildDashboardHtml(tasks: Task[], generatedAt: Date, roadmapExists: boolean): string {
  const done = tasks.filter((t) => t.status === "done").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const pending = tasks.filter((t) => t.status === "pending").length;
  const total = tasks.length;

  const title = roadmapExists
    ? `Auto-develop · ${done}/${total}`
    : "Auto-develop · no roadmap";

  const taskRows = tasks.map((t) => {
    const glyph = t.status === "done" ? "✓" : t.status === "blocked" ? "⊘" : "○";
    const reasonHtml = t.blockedReason
      ? `<div class="reason">${esc(t.blockedReason)}</div>`
      : "";
    return `    <li class="task ${t.status}"><span class="glyph">${glyph}</span><span class="text">${esc(t.text)}</span>${reasonHtml}</li>`;
  }).join("\n");

  const summaryHtml = roadmapExists
    ? `<p class="summary">${done} done · ${blocked} blocked · ${pending} pending</p>`
    : `<p class="summary no-roadmap">ROADMAP.md not found</p>`;

  const listHtml = tasks.length > 0
    ? `<ul class="tasks">\n${taskRows}\n  </ul>`
    : "";

  const ts = generatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #16171f;
    color: #e0e4f5;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    padding: 10px 12px 14px;
  }
  .summary {
    font-size: 12px;
    color: #9ba1c2;
    margin-bottom: 8px;
  }
  .no-roadmap { color: #656b8a; font-style: italic; }
  .tasks {
    list-style: none;
  }
  .task {
    display: flex;
    align-items: baseline;
    gap: 5px;
    padding: 2px 0;
  }
  .glyph {
    flex: none;
    width: 14px;
    text-align: center;
    font-size: 11px;
  }
  .text { flex: 1; }
  .reason {
    font-size: 11px;
    color: #656b8a;
    font-style: italic;
    padding-left: 19px;
  }
  .done .glyph { color: #9ece6a; }
  .done .text { color: #656b8a; text-decoration: line-through; }
  .pending .glyph { color: #656b8a; }
  .pending .text { color: #9ba1c2; }
  .blocked .glyph { color: #bb9af7; }
  .blocked .text { color: #bb9af7; }
  .footer {
    margin-top: 10px;
    font-size: 11px;
    color: #656b8a;
    border-top: 1px solid #2d3047;
    padding-top: 6px;
  }
</style>
</head>
<body>
  ${summaryHtml}
  ${listHtml}
  <div class="footer">updated ${ts}</div>
</body>
</html>
`;
}

function cmdLegacyHtml(projectDir: string): void {
  let tasks: Task[] = [];
  let roadmapExists = false;
  try {
    const md = readFileSync(join(projectDir, "ROADMAP.md"), "utf-8");
    roadmapExists = true;
    tasks = parseTasks(md);
  } catch { /* ROADMAP.md missing is fine */ }

  const outDir = join(projectDir, ".sparkflow");
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err) {
    process.stderr.write(`sparkflow-dashboard: cannot create ${outDir}: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const html = buildDashboardHtml(tasks, new Date(), roadmapExists);
  try {
    writeFileSync(join(outDir, "dashboard.html"), html, "utf-8");
  } catch (err) {
    process.stderr.write(`sparkflow-dashboard: write failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);

  // subcommand: state
  if (args[0] === "state") {
    if (args[1] === "set-from-roadmap") {
      const projectDir = resolve(args[2] ?? process.cwd());
      cmdSetFromRoadmap(projectDir);
      return;
    }
    if (args[1] === "put") {
      const pointer = args[2];
      const value = args[3];
      if (!pointer || value === undefined) {
        process.stderr.write("Usage: sparkflow-dashboard state put <json-pointer> <value> [projectDir]\n");
        process.exit(1);
      }
      const projectDir = resolve(args[4] ?? process.cwd());
      cmdStatePut(pointer, value, projectDir);
      return;
    }
    process.stderr.write("Usage: sparkflow-dashboard state <set-from-roadmap|put> ...\n");
    process.exit(1);
  }

  // subcommand: scaffold
  if (args[0] === "scaffold") {
    let force = false;
    const rest = args.slice(1).filter((a) => {
      if (a === "--force") { force = true; return false; }
      return true;
    });
    const projectDir = resolve(rest[0] ?? process.cwd());
    cmdScaffold(projectDir, force);
    return;
  }

  // Legacy: sparkflow-dashboard [projectDir]
  const projectDir = resolve(args[0] ?? process.cwd());
  cmdLegacyHtml(projectDir);
}

main();
