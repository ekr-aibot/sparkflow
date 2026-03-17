import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrCreatorAdapter } from "../../src/runtime/pr-creator.js";
import type { RuntimeContext } from "../../src/runtime/types.js";
import * as child_process from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const mockExecFileSync = vi.mocked(child_process.execFileSync);
const mockSpawn = vi.mocked(child_process.spawn);

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    stepId: "pr-create",
    step: {
      name: "PR Creator",
      interactive: false,
      outputs: {
        pr_url: { type: "text" },
      },
    },
    runtime: { type: "pr-creator" as const },
    cwd: "/fake/repo",
    env: {},
    interactive: false,
    ...overrides,
  };
}

function mockSpawnClaude(response: object) {
  const stdin = { write: vi.fn(), end: vi.fn() };
  const stdoutHandlers = new Map<string, (...args: unknown[]) => void>();
  const stderrHandlers = new Map<string, (...args: unknown[]) => void>();
  const closeHandlers = new Map<string, (...args: unknown[]) => void>();

  const child = {
    stdin,
    stdout: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        stdoutHandlers.set(event, handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        stderrHandlers.set(event, handler);
      }),
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      closeHandlers.set(event, handler);
    }),
  };

  mockSpawn.mockReturnValue(child as unknown as child_process.ChildProcess);

  setTimeout(() => {
    stdoutHandlers.get("data")?.(Buffer.from(JSON.stringify(response)));
    closeHandlers.get("close")?.(0);
  }, 0);

  return child;
}

function mockSpawnClaudeFailure() {
  const stdin = { write: vi.fn(), end: vi.fn() };
  const stdoutHandlers = new Map<string, (...args: unknown[]) => void>();
  const stderrHandlers = new Map<string, (...args: unknown[]) => void>();
  const closeHandlers = new Map<string, (...args: unknown[]) => void>();

  const child = {
    stdin,
    stdout: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        stdoutHandlers.set(event, handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        stderrHandlers.set(event, handler);
      }),
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      closeHandlers.set(event, handler);
    }),
  };

  mockSpawn.mockReturnValue(child as unknown as child_process.ChildProcess);

  setTimeout(() => {
    stderrHandlers.get("data")?.(Buffer.from("model error"));
    closeHandlers.get("close")?.(1);
  }, 0);

  return child;
}

/** Standard mock that handles the git + gh commands for the happy path. */
function setupBaseMocks(opts: { prCreateTitle?: (t: string) => void } = {}) {
  mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
    const argsArr = args as string[];

    // git rev-parse --abbrev-ref HEAD
    if (cmd === "git" && argsArr?.[0] === "rev-parse") {
      return Buffer.from("my-feature\n");
    }

    // git checkout -b <branch>
    if (cmd === "git" && argsArr?.[0] === "checkout" && argsArr?.[1] === "-b") {
      return Buffer.from("");
    }

    // git push
    if (cmd === "git" && argsArr?.[0] === "push") {
      return Buffer.from("");
    }

    // git log
    if (cmd === "git" && argsArr?.[0] === "log") {
      return Buffer.from("abc1234 Add feature\ndef5678 Fix bug\n");
    }

    // git diff --stat
    if (cmd === "git" && argsArr?.[0] === "diff") {
      return Buffer.from(" src/foo.ts | 10 ++++\n 1 file changed, 10 insertions(+)\n");
    }

    if (cmd !== "gh") throw new Error(`Unexpected: ${cmd} ${argsArr?.join(" ")}`);

    const key = argsArr.join(" ");

    // repo view → default branch
    if (key.includes("repo view")) {
      return Buffer.from(JSON.stringify({ defaultBranchRef: { name: "main" } }) + "\n");
    }

    // pr create
    if (key.includes("pr create")) {
      const titleIdx = argsArr.indexOf("--title");
      if (titleIdx !== -1) opts.prCreateTitle?.(argsArr[titleIdx + 1]);
      return Buffer.from("https://github.com/o/r/pull/99\n");
    }

    // pr view
    if (key.includes("pr view")) {
      return Buffer.from(JSON.stringify({ number: 99, url: "https://github.com/o/r/pull/99" }) + "\n");
    }

    throw new Error(`Unexpected gh command: ${key}`);
  });
}

describe("PrCreatorAdapter", () => {
  const adapter = new PrCreatorAdapter();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a unique branch and new PR", async () => {
    setupBaseMocks();
    mockSpawnClaude({ title: "Add feature and fix bug", summary: "- Added feature\n- Fixed bug" });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(true);
    expect(result.outputs.pr_url).toBe("https://github.com/o/r/pull/99");

    // Should have created a branch matching my-feature-pr-<hex>
    const checkoutCall = mockExecFileSync.mock.calls.find(
      (c) => c[0] === "git" && (c[1] as string[])?.[0] === "checkout",
    );
    expect(checkoutCall).toBeDefined();
    const branchName = (checkoutCall![1] as string[])[2];
    expect(branchName).toMatch(/^my-feature-pr-[0-9a-f]{6}$/);
  });

  it("pushes the new branch, not the original", async () => {
    setupBaseMocks();
    mockSpawnClaude({ title: "title", summary: "summary" });

    await adapter.run(makeCtx());

    const pushCall = mockExecFileSync.mock.calls.find(
      (c) => c[0] === "git" && (c[1] as string[])?.[0] === "push",
    );
    expect(pushCall).toBeDefined();
    const pushBranch = (pushCall![1] as string[])[3];
    expect(pushBranch).toMatch(/^my-feature-pr-[0-9a-f]{6}$/);
  });

  it("fails immediately on push failure", async () => {
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];

      if (cmd === "git" && argsArr?.[0] === "rev-parse") {
        return Buffer.from("my-feature\n");
      }
      if (cmd === "git" && argsArr?.[0] === "checkout") {
        return Buffer.from("");
      }
      if (cmd === "git" && argsArr?.[0] === "push") {
        throw new Error("remote: Permission denied");
      }
      if (cmd === "gh" && argsArr?.join(" ").includes("repo view")) {
        return Buffer.from(JSON.stringify({ defaultBranchRef: { name: "main" } }) + "\n");
      }
      throw new Error(`Unexpected: ${cmd}`);
    });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to push");
  });

  it("fails on branch creation failure", async () => {
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];

      if (cmd === "git" && argsArr?.[0] === "rev-parse") {
        return Buffer.from("my-feature\n");
      }
      if (cmd === "git" && argsArr?.[0] === "checkout") {
        throw new Error("branch already exists");
      }
      if (cmd === "gh" && argsArr?.join(" ").includes("repo view")) {
        return Buffer.from(JSON.stringify({ defaultBranchRef: { name: "main" } }) + "\n");
      }
      throw new Error(`Unexpected: ${cmd}`);
    });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to create branch");
  });

  it("uses fallback title/summary when claude fails", async () => {
    let capturedTitle = "";
    setupBaseMocks({ prCreateTitle: (t) => { capturedTitle = t; } });
    mockSpawnClaudeFailure();

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(true);
    expect(result.outputs.pr_url).toBe("https://github.com/o/r/pull/99");
    // Fallback title is derived from branch name
    expect(capturedTitle).toBe("My Feature");
  });
});
