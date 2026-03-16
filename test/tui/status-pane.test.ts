import { describe, it, expect, beforeEach, vi } from "vitest";
import { StatusPane } from "../../src/tui/status-pane.js";
import type { JobInfo } from "../../src/tui/types.js";

function makeJob(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "abc123",
    workflowPath: "/tmp/workflow.json",
    workflowName: "test-workflow",
    state: "running",
    summary: "developer: running",
    startTime: Date.now() - 5000,
    ...overrides,
  };
}

describe("StatusPane", () => {
  let pane: StatusPane;
  let written: string;

  beforeEach(() => {
    pane = new StatusPane();
    written = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written += String(chunk);
      return true;
    });
  });

  it("renders nothing when height is 0", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(0);
    pane.render([makeJob()]);
    expect(written).toBe("");
  });

  it("renders nothing when dimensions are not set", () => {
    pane.setHeight(3);
    pane.render([makeJob()]);
    expect(written).toBe("");
  });

  it("renders header line", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(3);
    pane.render([]);

    // Should contain the header separator
    expect(written).toContain("sparkflow jobs");
    // Should save and restore cursor
    expect(written).toContain("\x1b7"); // save
    expect(written).toContain("\x1b8"); // restore
  });

  it("renders a running job in yellow", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(3);
    pane.render([makeJob({ state: "running" })]);

    expect(written).toContain("RUNNING");
    expect(written).toContain("\x1b[33m"); // yellow
    expect(written).toContain("test-workflow");
  });

  it("renders a succeeded job in green", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(3);
    pane.render([makeJob({ state: "succeeded", summary: "completed" })]);

    expect(written).toContain("SUCCEEDED");
    expect(written).toContain("\x1b[32m"); // green
  });

  it("renders a failed job in red", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(3);
    pane.render([makeJob({ state: "failed", summary: "exit code 1" })]);

    expect(written).toContain("FAILED");
    expect(written).toContain("\x1b[31m"); // red
  });

  it("renders a blocked job in magenta with pending question", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(3);
    pane.render([makeJob({
      state: "blocked",
      summary: "waiting for answer",
      pendingQuestion: "Which framework?",
    })]);

    expect(written).toContain("BLOCKED");
    expect(written).toContain("\x1b[35m"); // magenta
    expect(written).toContain("Which framework?");
  });

  it("shows current step in bracket notation", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(3);
    pane.render([makeJob({ currentStep: "developer" })]);

    expect(written).toContain("[test-workflow/developer]");
  });

  it("renders elapsed time", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(3);
    // Job started 65 seconds ago
    pane.render([makeJob({ startTime: Date.now() - 65000 })]);

    expect(written).toContain("1m5s");
  });

  it("renders multiple jobs", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(4); // header + 3 job lines
    pane.render([
      makeJob({ id: "1", workflowName: "wf-1", state: "running" }),
      makeJob({ id: "2", workflowName: "wf-2", state: "succeeded" }),
      makeJob({ id: "3", workflowName: "wf-3", state: "failed" }),
    ]);

    expect(written).toContain("wf-1");
    expect(written).toContain("wf-2");
    expect(written).toContain("wf-3");
  });

  it("truncates jobs that exceed available lines", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(2); // header + 1 job line
    pane.render([
      makeJob({ id: "1", workflowName: "wf-1" }),
      makeJob({ id: "2", workflowName: "wf-2" }),
    ]);

    expect(written).toContain("wf-1");
    expect(written).not.toContain("wf-2");
  });

  it("positions at correct terminal rows", () => {
    pane.setDimensions(80, 24);
    pane.setHeight(3);
    pane.render([makeJob()]);

    // Status starts at row 24 - 3 + 1 = 22
    expect(written).toContain("\x1b[22;1H"); // header row
    expect(written).toContain("\x1b[23;1H"); // first job row
  });

  it("getHeight returns current height", () => {
    expect(pane.getHeight()).toBe(0);
    pane.setHeight(5);
    expect(pane.getHeight()).toBe(5);
  });
});
