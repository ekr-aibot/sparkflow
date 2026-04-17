import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrWatcherAdapter } from "../../src/runtime/pr-watcher.js";
import type { RuntimeContext } from "../../src/runtime/types.js";
import * as child_process from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(child_process.execFileSync);

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    stepId: "pr-step",
    step: {
      name: "PR Watcher",
      interactive: false,
      outputs: {
        feedback: { type: "text" },
        pr_url: { type: "text" },
      },
    },
    runtime: { type: "pr-watcher" as const, poll_interval: 1 },
    cwd: "/fake/repo",
    env: {},
    interactive: false,
    timeout: 5,
    ...overrides,
  };
}

function mockGh(responses: Map<string, unknown>) {
  mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
    const argsArr = args as string[];

    // git rev-parse --abbrev-ref HEAD: pr-watcher passes the branch name
    // explicitly to `gh pr view` so it works when the branch isn't tracking origin.
    if (cmd === "git" && argsArr?.[0] === "rev-parse") {
      return Buffer.from("test-branch\n");
    }
    if (cmd === "git" && argsArr?.[0] === "remote") {
      return Buffer.from("git@github.com:test-owner/test-repo.git\n");
    }

    // gh commands — match on the subcommand pattern
    if (cmd === "gh") {
      const key = argsArr.join(" ");
      for (const [pattern, response] of responses) {
        if (key.includes(pattern)) {
          return Buffer.from(JSON.stringify(response) + "\n");
        }
      }
    }

    throw new Error(`Unexpected command: ${cmd} ${argsArr?.join(" ")}`);
  });
}

describe("PrWatcherAdapter", () => {
  const adapter = new PrWatcherAdapter();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds immediately when PR is already merged", async () => {
    mockGh(new Map([
      ["pr view", { number: 42, url: "https://github.com/o/r/pull/42", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }],
    ]));

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(true);
    expect(result.outputs.pr_url).toBe("https://github.com/o/r/pull/42");
  });

  it("fails immediately when no PR exists", async () => {
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === "gh") throw new Error("no pull requests found");
      throw new Error(`Unexpected: ${cmd}`);
    });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("No PR found");
  });

  it("detects new CI failure and returns feedback", async () => {
    let pollCount = 0;

    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];

      if (cmd === "git" && argsArr?.[0] === "rev-parse") {
        return Buffer.from("test-branch\n");
      }
      if (cmd === "git" && argsArr?.[0] === "remote") {
        return Buffer.from("https://github.com/test-owner/test-repo.git\n");
      }

      if (cmd !== "gh") throw new Error(`Unexpected: ${cmd}`);
      const key = argsArr.join(" ");

      // Initial pr view (discovery)
      if (key.includes("pr view") && key.includes("number,url,state,mergedAt")) {
        return Buffer.from(JSON.stringify({ number: 10, url: "https://github.com/o/r/pull/10", state: "OPEN", mergedAt: null }) + "\n");
      }

      // Poll pr view
      if (key.includes("pr view") && key.includes("state,mergedAt,url")) {
        return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null, url: "https://github.com/o/r/pull/10" }) + "\n");
      }

      // Checks - initially passing, then failing
      if (key.includes("pr checks")) {
        pollCount++;
        if (pollCount <= 1) {
          return Buffer.from(JSON.stringify([]) + "\n");
        }
        return Buffer.from(JSON.stringify([
          { name: "build", state: "completed", conclusion: "failure" },
        ]) + "\n");
      }

      // Reviews and comments - empty
      if (key.includes("/reviews") || key.includes("/comments")) {
        return Buffer.from(JSON.stringify([]) + "\n");
      }

      throw new Error(`Unexpected gh command: ${key}`);
    });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(false);
    expect(result.outputs.feedback).toContain("CI Failure");
    expect(result.outputs.feedback).toContain("build");
  });

  it("detects new review requesting changes", async () => {
    let pollCount = 0;

    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];

      if (cmd === "git" && argsArr?.[0] === "rev-parse") {
        return Buffer.from("test-branch\n");
      }
      if (cmd === "git" && argsArr?.[0] === "remote") {
        return Buffer.from("https://github.com/test-owner/test-repo.git\n");
      }

      if (cmd !== "gh") throw new Error(`Unexpected: ${cmd}`);
      const key = argsArr.join(" ");

      if (key.includes("pr view") && key.includes("number,url,state,mergedAt")) {
        return Buffer.from(JSON.stringify({ number: 10, url: "https://github.com/o/r/pull/10", state: "OPEN", mergedAt: null }) + "\n");
      }

      if (key.includes("pr view") && key.includes("state,mergedAt,url")) {
        return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null, url: "https://github.com/o/r/pull/10" }) + "\n");
      }

      if (key.includes("pr checks")) {
        return Buffer.from(JSON.stringify([]) + "\n");
      }

      if (key.includes("/reviews")) {
        pollCount++;
        if (pollCount <= 1) {
          return Buffer.from(JSON.stringify([]) + "\n");
        }
        return Buffer.from(JSON.stringify([
          { state: "CHANGES_REQUESTED", body: "Please fix the error handling", user: { login: "reviewer1" } },
        ]) + "\n");
      }

      if (key.includes("/comments")) {
        return Buffer.from(JSON.stringify([]) + "\n");
      }

      throw new Error(`Unexpected gh command: ${key}`);
    });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(false);
    expect(result.outputs.feedback).toContain("Changes Requested");
    expect(result.outputs.feedback).toContain("reviewer1");
  });

  it("times out when no activity occurs", async () => {
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];

      if (cmd === "git" && argsArr?.[0] === "rev-parse") {
        return Buffer.from("test-branch\n");
      }
      if (cmd === "git" && argsArr?.[0] === "remote") {
        return Buffer.from("https://github.com/test-owner/test-repo.git\n");
      }

      if (cmd !== "gh") throw new Error(`Unexpected: ${cmd}`);
      const key = argsArr.join(" ");

      if (key.includes("pr view") && key.includes("number,url,state,mergedAt")) {
        return Buffer.from(JSON.stringify({ number: 10, url: "https://github.com/o/r/pull/10", state: "OPEN", mergedAt: null }) + "\n");
      }

      if (key.includes("pr view")) {
        return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null, url: "https://github.com/o/r/pull/10" }) + "\n");
      }

      if (key.includes("pr checks")) {
        return Buffer.from(JSON.stringify([]) + "\n");
      }

      if (key.includes("/reviews") || key.includes("/comments")) {
        return Buffer.from(JSON.stringify([]) + "\n");
      }

      throw new Error(`Unexpected: ${key}`);
    });

    const result = await adapter.run(makeCtx({ timeout: 2 }));
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timed out");
  }, 10000);
});
