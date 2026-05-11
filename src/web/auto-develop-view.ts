import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedJob } from "../tui/state-store.js";

export interface RoadmapTask {
  line: number;
  status: "done" | "pending" | "blocked";
  text: string;
  blockedReason?: string;
}

const TASK_RE = /^- \[( |x|!)\] (.+?)(?:\s*<!--\s*blocked:\s*(.+?)\s*-->)?$/;

export function parseRoadmap(markdown: string): RoadmapTask[] {
  const tasks: RoadmapTask[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_RE);
    if (!m) continue;
    const [, marker, rawText, blockedReason] = m;
    const status: RoadmapTask["status"] =
      marker === "x" ? "done" :
      marker === "!" ? "blocked" :
      "pending";
    const task: RoadmapTask = { line: i + 1, status, text: rawText.trim() };
    if (blockedReason) task.blockedReason = blockedReason.trim();
    tasks.push(task);
  }
  return tasks;
}

const PICK_NEXT_META_RE = /\[pick-next:meta\] result:\s*(\{.+\})/;

function extractCurrentTaskLine(logPath: string): number | null {
  let buf: Buffer;
  try {
    buf = readFileSync(logPath);
  } catch {
    return null;
  }
  const slice = buf.length > 32768 ? buf.subarray(buf.length - 32768) : buf;
  const lines = slice.toString("utf-8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(PICK_NEXT_META_RE);
    if (!m) continue;
    try {
      const payload = JSON.parse(m[1]) as { line?: string | number };
      if (payload.line !== undefined) {
        const n = typeof payload.line === "string" ? parseInt(payload.line, 10) : payload.line;
        if (Number.isFinite(n)) return n;
      }
    } catch { /* skip malformed */ }
  }
  return null;
}

export interface ActiveAutoDevJob {
  jobId: string;
  currentStep: string | null;
  currentTaskLine: number | null;
  startTime: number;
}

export interface AutoDevelopResult {
  primary: ActiveAutoDevJob;
  otherRunningCount: number;
}

export function findActiveAutoDevelop(projectDir: string): AutoDevelopResult | null {
  const stateDir = join(projectDir, ".sparkflow", "state", "jobs");
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return null;
  }

  const running: PersistedJob[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(stateDir, name), "utf-8");
      const job = JSON.parse(raw) as PersistedJob;
      if (job.info.workflowName === "auto-develop" && job.info.state === "running") {
        running.push(job);
      }
    } catch { /* skip corrupt */ }
  }

  if (running.length === 0) return null;

  running.sort((a, b) => b.info.startTime - a.info.startTime);
  const primary = running[0];

  return {
    primary: {
      jobId: primary.info.id,
      currentStep: primary.info.currentStep ?? null,
      currentTaskLine: extractCurrentTaskLine(primary.logPath),
      startTime: primary.info.startTime,
    },
    otherRunningCount: running.length - 1,
  };
}

export interface AutoDevelopResponse {
  roadmap_exists: boolean;
  tasks: RoadmapTask[];
  current_job: { id: string; currentStep: string | null; currentTaskLine: number | null; startTime: number } | null;
  other_running_count: number;
  generated_at: string;
}

export function buildAutoDevelopResponse(projectDir: string): AutoDevelopResponse {
  let roadmapExists = false;
  let tasks: RoadmapTask[] = [];
  try {
    const content = readFileSync(join(projectDir, "ROADMAP.md"), "utf-8");
    roadmapExists = true;
    tasks = parseRoadmap(content);
  } catch { /* missing */ }

  const result = findActiveAutoDevelop(projectDir);
  const current_job = result ? {
    id: result.primary.jobId,
    currentStep: result.primary.currentStep,
    currentTaskLine: result.primary.currentTaskLine,
    startTime: result.primary.startTime,
  } : null;

  return {
    roadmap_exists: roadmapExists,
    tasks,
    current_job,
    other_running_count: result?.otherRunningCount ?? 0,
    generated_at: new Date().toISOString(),
  };
}
