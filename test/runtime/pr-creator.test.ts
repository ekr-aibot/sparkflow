import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrCreatorAdapter } from "../../src/runtime/pr-creator.js";
import type { RuntimeContext } from "../../src/runtime/types.js";
import * as child_process from "node:child_process";
import * as fs from "node:fs";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs") as any;
  return {
    ...actual,
    statSync: vi.fn(),
  };
});

const mockExecFileSync = vi.mocked(child_process.execFileSync);
const mockSpawn = vi.mocked(child_process.spawn);
const mockStatSync = vi.mocked(fs.statSync);

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

    // git push -u origin HEAD
    if (cmd === "git" && argsArr?.[0] === "push") {
      return Buffer.from("");
    }

    // git rev-parse --abbrev-ref HEAD (for fallback title)
    if (cmd === "git" && argsArr?.[0] === "rev-parse") {
      return Buffer.from("sparkflow/developer\n");
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

    throw new Error(`Unexpected gh command: ${key}`);
  });
}

describe("PrCreatorAdapter", () => {
  const adapter = new PrCreatorAdapter();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockStatSync.mockImplementation((path) => {
      if (path === "/fake/repo") {
        return { isDirectory: () => true } as any;
      }
      return { isDirectory: () => false } as any;
    });
  });

  it("pushes current branch and creates a new PR", async () => {
    setupBaseMocks();
    mockSpawnClaude({ title: "Add feature and fix bug", summary: "- Added feature\n- Fixed bug" });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(true);
    expect(result.outputs.pr_url).toBe("https://github.com/o/r/pull/99");

    // Should push HEAD (the worktree's unique branch), not create a new branch
    const pushCall = mockExecFileSync.mock.calls.find(
      (c) => c[0] === "git" && (c[1] as string[])?.[0] === "push",
    );
    expect(pushCall).toBeDefined();
    expect((pushCall![1] as string[]).includes("HEAD")).toBe(true);

    // Should NOT have called git checkout -b
    const checkoutCall = mockExecFileSync.mock.calls.find(
      (c) => c[0] === "git" && (c[1] as string[])?.[0] === "checkout",
    );
    expect(checkoutCall).toBeUndefined();
  });

  it("fails immediately on push failure", async () => {
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];
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

  it("uses fallback title/summary when claude fails", async () => {
    let capturedTitle = "";
    setupBaseMocks({ prCreateTitle: (t) => { capturedTitle = t; } });
    mockSpawnClaudeFailure();

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(true);
    expect(result.outputs.pr_url).toBe("https://github.com/o/r/pull/99");
    // Fallback title derived from branch name "sparkflow/developer"
    expect(capturedTitle).toBe("Sparkflow/Developer");
  });

  it("fails when gh pr create stdout has no PR URL", async () => {
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];
      if (cmd === "git" && argsArr?.[0] === "push") return Buffer.from("");
      if (cmd === "git" && argsArr?.[0] === "rev-parse") return Buffer.from("sparkflow/dev\n");
      if (cmd === "git" && argsArr?.[0] === "log") return Buffer.from("abc\n");
      if (cmd === "git" && argsArr?.[0] === "diff") return Buffer.from(" f.ts | 1 +\n");
      if (cmd !== "gh") throw new Error(`Unexpected: ${cmd}`);
      const key = argsArr.join(" ");
      if (key.includes("repo view")) {
        return Buffer.from(JSON.stringify({ defaultBranchRef: { name: "main" } }) + "\n");
      }
      if (key.includes("pr create")) return Buffer.from("Creating pull request... done\n");
      throw new Error(`Unexpected gh: ${key}`);
    });
    mockSpawnClaude({ title: "T", summary: "S" });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not parse PR URL");
  });

  it("parses the existing PR URL from gh's 'already exists' error (cross-fork safe)", async () => {
    // Mimic execFileSync's thrown-error shape: Error with .stderr/.stdout Buffers.
    const ghError = Object.assign(
      new Error("Command failed: gh pr create ..."),
      {
        stderr: Buffer.from(
          'a pull request for branch "sparkflow/_run-16" into branch "main" already exists:\n' +
          'https://github.com/ekr/runner-up/pull/58\n',
        ),
        stdout: Buffer.from(""),
        status: 1,
      },
    );

    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];
      if (cmd === "git" && argsArr?.[0] === "push") return Buffer.from("");
      if (cmd === "git" && argsArr?.[0] === "rev-parse") return Buffer.from("sparkflow/_run-16\n");
      if (cmd === "git" && argsArr?.[0] === "log") return Buffer.from("abc\n");
      if (cmd === "git" && argsArr?.[0] === "diff") return Buffer.from(" f.ts | 1 +\n");
      if (cmd !== "gh") throw new Error(`Unexpected: ${cmd}`);
      const key = argsArr.join(" ");
      if (key.includes("repo view")) {
        return Buffer.from(JSON.stringify({ defaultBranchRef: { name: "main" } }) + "\n");
      }
      if (key.includes("pr create")) throw ghError;
      throw new Error(`Unexpected gh: ${key}`);
    });
    mockSpawnClaude({ title: "T", summary: "S" });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(true);
    expect(result.outputs.pr_url).toBe("https://github.com/ekr/runner-up/pull/58");
  });

  it("appends 'Fixes #N' when prompt contains a GitHub issue reference", async () => {
    let capturedBody = "";
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];
      if (cmd === "git" && argsArr?.[0] === "push") return Buffer.from("");
      if (cmd === "git" && argsArr?.[0] === "rev-parse") return Buffer.from("sparkflow/_run-25\n");
      if (cmd === "git" && argsArr?.[0] === "log") return Buffer.from("abc1234 Add feature\n");
      if (cmd === "git" && argsArr?.[0] === "diff") return Buffer.from(" src/foo.ts | 5 +++++\n");
      if (cmd !== "gh") throw new Error(`Unexpected: ${cmd}`);
      const key = argsArr.join(" ");
      if (key.includes("repo view")) {
        return Buffer.from(JSON.stringify({ defaultBranchRef: { name: "main" } }) + "\n");
      }
      if (key.includes("pr create")) {
        const bodyIdx = argsArr.indexOf("--body");
        if (bodyIdx !== -1) capturedBody = argsArr[bodyIdx + 1];
        return Buffer.from("https://github.com/o/r/pull/99\n");
      }
      throw new Error(`Unexpected gh: ${key}`);
    });
    mockSpawnClaude({ title: "Fix the thing", summary: "- Fixed the thing" });

    const ctx = makeCtx({
      prompt: "# Project Plan\n\n# Work GitHub Issue #42\n\n**Title:** Fix the thing",
    });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);
    expect(capturedBody).toContain("Fixes #42");
    expect(capturedBody).toContain("- Fixed the thing");
  });

  it("does not append 'Fixes' when prompt has no issue reference", async () => {
    let capturedBody = "";
    setupBaseMocks();
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];
      if (cmd === "git" && argsArr?.[0] === "push") return Buffer.from("");
      if (cmd === "git" && argsArr?.[0] === "rev-parse") return Buffer.from("sparkflow/_run-25\n");
      if (cmd === "git" && argsArr?.[0] === "log") return Buffer.from("abc1234 Add feature\n");
      if (cmd === "git" && argsArr?.[0] === "diff") return Buffer.from(" src/foo.ts | 5 +++++\n");
      if (cmd !== "gh") throw new Error(`Unexpected: ${cmd}`);
      const key = argsArr.join(" ");
      if (key.includes("repo view")) {
        return Buffer.from(JSON.stringify({ defaultBranchRef: { name: "main" } }) + "\n");
      }
      if (key.includes("pr create")) {
        const bodyIdx = argsArr.indexOf("--body");
        if (bodyIdx !== -1) capturedBody = argsArr[bodyIdx + 1];
        return Buffer.from("https://github.com/o/r/pull/99\n");
      }
      throw new Error(`Unexpected gh: ${key}`);
    });
    mockSpawnClaude({ title: "Some change", summary: "- Some change" });

    const ctx = makeCtx({ prompt: "Do something without an issue number" });
    const result = await adapter.run(ctx);
    expect(result.success).toBe(true);
    expect(capturedBody).not.toContain("Fixes #");
    expect(capturedBody).toBe("- Some change");
  });

  it("handles gh pr create failure", async () => {
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[];

      if (cmd === "git" && argsArr?.[0] === "push") return Buffer.from("");
      if (cmd === "git" && argsArr?.[0] === "rev-parse") return Buffer.from("sparkflow/dev\n");
      if (cmd === "git" && argsArr?.[0] === "log") return Buffer.from("abc Add thing\n");
      if (cmd === "git" && argsArr?.[0] === "diff") return Buffer.from(" f.ts | 1 +\n");

      if (cmd !== "gh") throw new Error(`Unexpected: ${cmd}`);
      const key = argsArr.join(" ");

      if (key.includes("repo view")) {
        return Buffer.from(JSON.stringify({ defaultBranchRef: { name: "main" } }) + "\n");
      }
      if (key.includes("pr create")) {
        throw new Error("GraphQL: branch already has a PR");
      }

      throw new Error(`Unexpected gh command: ${key}`);
    });

    mockSpawnClaude({ title: "Title", summary: "Summary" });

    const result = await adapter.run(makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to create PR");
  });
});
