#!/usr/bin/env node

/**
 * sparkflow-dashboard — generates .sparkflow/dashboard.html from ROADMAP.md.
 *
 * Usage: sparkflow-dashboard [projectDir]
 *
 * Reads ROADMAP.md from projectDir (default: cwd), parses task lines, and
 * writes a self-contained HTML dashboard to <projectDir>/.sparkflow/dashboard.html.
 *
 * Exit 0 on success. Non-zero if the output file cannot be written.
 * A missing ROADMAP.md is not an error — it writes a minimal "no roadmap" page.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type TaskStatus = "done" | "pending" | "blocked";

interface Task {
  line: number;
  status: TaskStatus;
  text: string;
  blockedReason?: string;
}

const TASK_RE = /^- \[( |x|!)\] (.+?)(?:\s*<!--\s*blocked:\s*(.+?)\s*-->)?$/;

export function parseTasks(md: string): Task[] {
  const tasks: Task[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_RE);
    if (!m) continue;
    const [, marker, rawText, blockedReason] = m;
    const status: TaskStatus =
      marker === "x" ? "done" : marker === "!" ? "blocked" : "pending";
    const t: Task = { line: i + 1, status, text: rawText.trim() };
    if (blockedReason) t.blockedReason = blockedReason.trim();
    tasks.push(t);
  }
  return tasks;
}

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

function main(): void {
  const projectDir = process.argv[2] ?? process.cwd();

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

main();
