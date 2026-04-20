import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrWatcherAdapter } from "../../src/runtime/pr-watcher.js";
import type { RuntimeContext } from "../../src/runtime/types.js";
import * as child_process from "node:child_process";
import * as fs from "node:fs";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs") as any;
  return {
    ...actual,
    statSync: vi.fn(),
  };
});

const mockExecFileSync = vi.mocked(child_process.execFileSync);
const mockStatSync = vi.mocked(fs.statSync);

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
    mockStatSync.mockImplementation((path) => {
      if (path === "/fake/repo") {
        return { isDirectory: () => true } as any;
      }
      return { isDirectory: () => false } as any;
    });
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
      if (cmd === "git") return Buffer.from("test-branch\n");
      throw new Error(`Unexpected: ${cmd}`);
    });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("No PR found");
  });

  it("uses upstream step's pr_url instead of branch lookup (cross-fork PR)", async () => {
    // Simulate the cross-fork case where `gh pr view <branch>` fails but
    // `gh pr view <number>` works — pr-create emitted pr_url, pr-watch
    // should consume it via stepOutputs.
    const seenArgs: string[][] = [];
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];
      if (cmd === "git" && argsArr?.[0] === "rev-parse") {
        // Should NOT be called — we skip branch discovery when upstream URL is present.
        throw new Error("unexpected rev-parse call");
      }
      if (cmd === "gh") {
        seenArgs.push([...argsArr]);
        const key = argsArr.join(" ");
        // Discovery call by PR number — succeeds and returns merged PR.
        if (key.startsWith("pr view 60 ") && key.includes("number,url,state,mergedAt")) {
          return Buffer.from(JSON.stringify({
            number: 60,
            url: "https://github.com/ekr/runner-up/pull/60",
            state: "MERGED",
            mergedAt: "2026-01-02T12:00:00Z",
          }) + "\n");
        }
      }
      throw new Error(`Unexpected: ${cmd} ${argsArr?.join(" ")}`);
    });

    const stepOutputs = new Map<string, Record<string, unknown>>([
      ["pr-create", { pr_url: "https://github.com/ekr/runner-up/pull/60" }],
    ]);

    const result = await adapter.run(makeCtx({ stepOutputs }));
    expect(result.success).toBe(true);
    expect(result.outputs.pr_url).toBe("https://github.com/ekr/runner-up/pull/60");
    // Exactly one gh call: the initial by-number discovery. No branch fallback.
    expect(seenArgs.length).toBe(1);
    expect(seenArgs[0][0]).toBe("pr");
    expect(seenArgs[0][1]).toBe("view");
    expect(seenArgs[0][2]).toBe("60");
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
    expect(result.outputs.feedback as string).toContain("CI Failure");
    expect(result.outputs.feedback as string).toContain("build");
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
    expect(result.outputs.feedback as string).toContain("Changes Requested");
    expect(result.outputs.feedback as string).toContain("reviewer1");
  });

  it("detects cancelled/timed_out check as CI failure", async () => {
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
        pollCount++;
        if (pollCount <= 1) {
          return Buffer.from(JSON.stringify([]) + "\n");
        }
        return Buffer.from(JSON.stringify([
          { name: "ci/test", state: "completed", conclusion: "timed_out" },
        ]) + "\n");
      }

      if (key.includes("/reviews") || key.includes("/comments")) {
        return Buffer.from(JSON.stringify([]) + "\n");
      }

      throw new Error(`Unexpected gh command: ${key}`);
    });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(false);
    expect(result.outputs.feedback as string).toContain("CI Failure");
    expect(result.outputs.feedback as string).toContain("ci/test");
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
