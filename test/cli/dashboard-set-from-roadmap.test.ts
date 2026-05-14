import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSections,
  buildStateFromRoadmap,
  cmdSetFromRoadmap,
  type DashboardState,
} from "../../src/cli/dashboard.js";

describe("parseSections", () => {
  it("parses a ROADMAP without section headings as a single null-title section", () => {
    const md = "- [x] done\n- [ ] pending\n- [!] blocked <!-- blocked: needs design -->";
    const sections = parseSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBeNull();
    expect(sections[0].tasks).toHaveLength(3);
  });

  it("parses ## headings as section titles", () => {
    const md = [
      "## Phase 1",
      "- [x] first task",
      "- [ ] second task",
      "## Phase 2",
      "- [ ] third task",
    ].join("\n");
    const sections = parseSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("Phase 1");
    expect(sections[0].tasks).toHaveLength(2);
    expect(sections[1].title).toBe("Phase 2");
    expect(sections[1].tasks).toHaveLength(1);
  });

  it("collects top-level tasks (before first ##) into a null-title section", () => {
    const md = [
      "- [ ] toplevel",
      "## Section A",
      "- [x] in section",
    ].join("\n");
    const sections = parseSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBeNull();
    expect(sections[0].tasks[0].text).toBe("toplevel");
    expect(sections[1].title).toBe("Section A");
  });

  it("ignores non-task lines inside sections", () => {
    const md = ["## S", "prose", "- [ ] task", "  indented"].join("\n");
    const sections = parseSections(md);
    expect(sections[0].tasks).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(parseSections("")).toEqual([]);
  });

  it("preserves line numbers", () => {
    const md = ["## S", "- [ ] task one", "- [x] task two"].join("\n");
    const sections = parseSections(md);
    expect(sections[0].tasks[0].line).toBe(2);
    expect(sections[0].tasks[1].line).toBe(3);
  });

  it("extracts blocked reason from HTML comment", () => {
    const md = "- [!] blocked <!-- blocked: waiting on dep -->";
    const sections = parseSections(md);
    expect(sections[0].tasks[0].blockedReason).toBe("waiting on dep");
  });

  it("generates stable ids for tasks with same text", () => {
    const md = "- [ ] my task\n- [ ] my task";
    const sections = parseSections(md);
    expect(sections[0].tasks[0].id).toBe(sections[0].tasks[1].id);
  });
});

describe("buildStateFromRoadmap", () => {
  const now = new Date("2025-06-01T12:00:00Z");

  it("builds state from ROADMAP with sections", () => {
    const md = ["## Alpha", "- [x] done", "- [ ] pending", "## Beta", "- [!] blocked"].join("\n");
    const state = buildStateFromRoadmap(md, null, now);
    expect(state.workflow).toBe("auto-develop");
    expect(state.sections).toHaveLength(2);
    expect(state.summary.done).toBe(1);
    expect(state.summary.pending).toBe(1);
    expect(state.summary.blocked).toBe(1);
    expect(state.summary.total).toBe(3);
    expect(state.recent).toEqual([]);
  });

  it("returns empty sections for null md", () => {
    const state = buildStateFromRoadmap(null, null, now);
    expect(state.sections).toHaveLength(0);
    expect(state.summary.total).toBe(0);
  });

  it("produces recent activity when a task transitions to done", () => {
    const md1 = "- [ ] implement auth";
    const prevState = buildStateFromRoadmap(md1, null, now);

    const md2 = "- [x] implement auth";
    const state2 = buildStateFromRoadmap(md2, prevState, new Date("2025-06-01T13:00:00Z"));
    expect(state2.recent).toHaveLength(1);
    expect(state2.recent[0].event).toBe("completed");
    expect(state2.recent[0].task).toBe("implement auth");
  });

  it("produces recent activity when a task transitions to blocked", () => {
    const prevState = buildStateFromRoadmap("- [ ] foo", null, now);
    const state2 = buildStateFromRoadmap("- [!] foo <!-- blocked: reason -->", prevState, now);
    expect(state2.recent[0].event).toBe("blocked");
  });

  it("caps recent activity at 20 entries", () => {
    const bigHistory: DashboardState = {
      workflow: "auto-develop",
      sections: [{ title: null, tasks: [{ id: "x", line: 1, status: "pending", text: "t" }] }],
      summary: { done: 0, pending: 1, blocked: 0, in_progress: 0, total: 1 },
      recent: Array.from({ length: 20 }, (_, i) => ({
        event: "completed" as const,
        task: `task-${i}`,
        at: now.toISOString(),
      })),
      updatedAt: now.toISOString(),
    };
    const state2 = buildStateFromRoadmap("- [x] t", bigHistory, now);
    expect(state2.recent.length).toBeLessThanOrEqual(20);
  });

  it("includes updatedAt timestamp", () => {
    const state = buildStateFromRoadmap("- [ ] x", null, now);
    expect(state.updatedAt).toBe("2025-06-01T12:00:00.000Z");
  });
});

describe("cmdSetFromRoadmap integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sf-sfr-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes state.json and .last-state.json from ROADMAP.md", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), [
      "## Alpha",
      "- [x] task one",
      "- [ ] task two",
    ].join("\n"));

    cmdSetFromRoadmap(tmpDir);

    const statePath = join(tmpDir, ".sparkflow", "dashboard", "state.json");
    const lastStatePath = join(tmpDir, ".sparkflow", "dashboard", ".last-state.json");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.workflow).toBe("auto-develop");
    expect(state.sections[0].title).toBe("Alpha");
    expect(state.summary.done).toBe(1);
    expect(state.summary.pending).toBe(1);

    expect(() => readFileSync(lastStatePath)).not.toThrow();
  });

  it("generates recent activity on second run", () => {
    writeFileSync(join(tmpDir, "ROADMAP.md"), "- [ ] implement auth");
    cmdSetFromRoadmap(tmpDir);

    writeFileSync(join(tmpDir, "ROADMAP.md"), "- [x] implement auth");
    cmdSetFromRoadmap(tmpDir);

    const statePath = join(tmpDir, ".sparkflow", "dashboard", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.recent).toHaveLength(1);
    expect(state.recent[0].event).toBe("completed");
  });

  it("handles missing ROADMAP.md gracefully", () => {
    cmdSetFromRoadmap(tmpDir);
    const statePath = join(tmpDir, ".sparkflow", "dashboard", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.sections).toHaveLength(0);
    expect(state.summary.total).toBe(0);
  });
});
