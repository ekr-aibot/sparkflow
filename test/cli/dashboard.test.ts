import { describe, it, expect } from "vitest";
import { parseTasks, buildDashboardHtml } from "../../src/cli/dashboard.js";

describe("parseTasks", () => {
  it("parses a pending task", () => {
    const tasks = parseTasks("- [ ] do something");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ line: 1, status: "pending", text: "do something" });
  });

  it("parses a done task", () => {
    const tasks = parseTasks("- [x] already done");
    expect(tasks[0]).toMatchObject({ line: 1, status: "done", text: "already done" });
  });

  it("parses a blocked task", () => {
    const tasks = parseTasks("- [!] stuck here");
    expect(tasks[0]).toMatchObject({ line: 1, status: "blocked", text: "stuck here" });
  });

  it("extracts blocked reason from HTML comment", () => {
    const tasks = parseTasks("- [!] stuck <!-- blocked: waiting on PR #42 -->");
    expect(tasks[0].blockedReason).toBe("waiting on PR #42");
    expect(tasks[0].text).toBe("stuck");
  });

  it("ignores non-task lines", () => {
    const md = ["# ROADMAP", "", "Prose.", "- [ ] actual task", "  - not a task"].join("\n");
    expect(parseTasks(md)).toHaveLength(1);
    expect(parseTasks(md)[0].text).toBe("actual task");
  });

  it("returns empty array for empty input", () => {
    expect(parseTasks("")).toEqual([]);
  });

  it("preserves order and line numbers", () => {
    const md = ["- [x] first", "# heading", "- [ ] second"].join("\n");
    const tasks = parseTasks(md);
    expect(tasks[0]).toMatchObject({ line: 1, status: "done" });
    expect(tasks[1]).toMatchObject({ line: 3, status: "pending" });
  });
});

describe("buildDashboardHtml", () => {
  const now = new Date("2025-01-15T12:00:00Z");

  it("produces valid HTML with a title", () => {
    const tasks = parseTasks(["- [x] done", "- [ ] pending", "- [!] blocked"].join("\n"));
    const html = buildDashboardHtml(tasks, now, true);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>");
    expect(html).toContain("1/3");
  });

  it("includes done/blocked/pending counts in summary", () => {
    const tasks = parseTasks(["- [x] done one", "- [x] done two", "- [!] blocked", "- [ ] pending"].join("\n"));
    const html = buildDashboardHtml(tasks, now, true);
    expect(html).toContain("2 done");
    expect(html).toContain("1 blocked");
    expect(html).toContain("1 pending");
  });

  it("shows 'no roadmap' message when roadmapExists is false", () => {
    const html = buildDashboardHtml([], now, false);
    expect(html).toContain("no roadmap");
    expect(html).not.toContain("<ul");
  });

  it("escapes HTML special characters in task text", () => {
    const tasks = parseTasks('- [ ] use <b>bold</b> & "quotes"');
    const html = buildDashboardHtml(tasks, now, true);
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });

  it("renders blocked reason as muted subtext", () => {
    const tasks = parseTasks("- [!] blocked task <!-- blocked: needs design -->");
    const html = buildDashboardHtml(tasks, now, true);
    expect(html).toContain("needs design");
    expect(html).toContain("reason");
  });

  it("includes a timestamp", () => {
    const html = buildDashboardHtml([], now, false);
    expect(html).toContain("updated");
  });

  it("renders no task list when tasks array is empty but roadmap exists", () => {
    const html = buildDashboardHtml([], now, true);
    expect(html).toContain("0 done");
    expect(html).not.toContain("<li");
  });
});
