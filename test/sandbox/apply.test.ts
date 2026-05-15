import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock bwrap module to control availability
vi.mock("../../src/sandbox/bwrap.js", () => ({
  isBwrapAvailable: vi.fn(),
  buildBwrapArgv: vi.fn(),
  SPARKFLOW_ROOT: "/sparkflow",
  resetBwrapAvailableCache: vi.fn(),
  gitWorktreeBinds: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

import { isBwrapAvailable, buildBwrapArgv } from "../../src/sandbox/bwrap.js";
import { applySandbox } from "../../src/sandbox/apply.js";
import type { RuntimeContext } from "../../src/runtime/types.js";

const mockIsBwrapAvailable = vi.mocked(isBwrapAvailable);
const mockBuildBwrapArgv = vi.mocked(buildBwrapArgv);

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    stepId: "test-step",
    step: { name: "Test", interactive: false },
    runtime: { type: "claude-code" },
    cwd: "/worktrees/run1/step1",
    repoRoot: "/repo",
    env: { ANTHROPIC_API_KEY: "sk-test" },
    interactive: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SPARKFLOW_SANDBOX;
  mockBuildBwrapArgv.mockReturnValue(["--unshare-user", "--", "claude", "--print"]);
});

afterEach(() => {
  delete process.env.SPARKFLOW_SANDBOX;
  vi.clearAllMocks();
});

describe("applySandbox", () => {
  describe("global override", () => {
    it("returns original command when SPARKFLOW_SANDBOX=off", () => {
      process.env.SPARKFLOW_SANDBOX = "off";
      mockIsBwrapAvailable.mockReturnValue(true);

      const result = applySandbox({
        command: "claude",
        args: ["--print"],
        cwd: "/worktrees/run1/step1",
        env: {},
        ctx: makeCtx(),
      });

      expect(result.command).toBe("claude");
      expect(result.args).toEqual(["--print"]);
      expect(mockBuildBwrapArgv).not.toHaveBeenCalled();
    });
  });

  describe("sandbox disabled via config", () => {
    it("returns original command when sandbox.enabled=false", () => {
      mockIsBwrapAvailable.mockReturnValue(true);

      const result = applySandbox({
        command: "claude",
        args: ["--print"],
        cwd: "/worktrees/run1/step1",
        env: {},
        ctx: makeCtx({ sandbox: { enabled: false } }),
      });

      expect(result.command).toBe("claude");
      expect(mockBuildBwrapArgv).not.toHaveBeenCalled();
    });
  });

  describe("bwrap unavailable", () => {
    it("returns original command when bwrap unavailable and required=false", () => {
      mockIsBwrapAvailable.mockReturnValue(false);

      const result = applySandbox({
        command: "claude",
        args: ["--print"],
        cwd: "/worktrees/run1/step1",
        env: {},
        ctx: makeCtx(),
      });

      expect(result.command).toBe("claude");
      expect(mockBuildBwrapArgv).not.toHaveBeenCalled();
    });

    it("logs a warning when bwrap unavailable and required=false", () => {
      mockIsBwrapAvailable.mockReturnValue(false);
      const info = vi.fn();

      applySandbox({
        command: "claude",
        args: ["--print"],
        cwd: "/worktrees/run1/step1",
        env: {},
        ctx: makeCtx({ logger: { info, error: vi.fn() } }),
      });

      expect(info).toHaveBeenCalledWith(expect.stringContaining("bwrap not available"));
      expect(info).toHaveBeenCalledWith(expect.stringContaining("unsandboxed"));
    });

    it("throws when bwrap unavailable and required=true", () => {
      mockIsBwrapAvailable.mockReturnValue(false);

      expect(() =>
        applySandbox({
          command: "claude",
          args: [],
          cwd: "/worktrees/run1/step1",
          env: {},
          ctx: makeCtx({ sandbox: { required: true } }),
        })
      ).toThrow(/bwrap is not available/);
    });

    it("throw message mentions the step id", () => {
      mockIsBwrapAvailable.mockReturnValue(false);

      expect(() =>
        applySandbox({
          command: "claude",
          args: [],
          cwd: "/worktrees/run1/step1",
          env: {},
          ctx: makeCtx({ stepId: "my-step", sandbox: { required: true } }),
        })
      ).toThrow(/my-step/);
    });
  });

  describe("bwrap available", () => {
    it("returns bwrap as command with bwrap argv", () => {
      mockIsBwrapAvailable.mockReturnValue(true);

      const result = applySandbox({
        command: "claude",
        args: ["--print"],
        cwd: "/worktrees/run1/step1",
        env: { ANTHROPIC_API_KEY: "sk-test" },
        ctx: makeCtx(),
      });

      expect(result.command).toBe("bwrap");
      expect(result.args).toEqual(["--unshare-user", "--", "claude", "--print"]);
    });

    it("passes cwd, repoRoot, sockets to buildBwrapArgv", () => {
      mockIsBwrapAvailable.mockReturnValue(true);

      applySandbox({
        command: "claude",
        args: [],
        cwd: "/worktrees/run1/step1",
        env: {},
        ctx: makeCtx({ ipcSocketPath: "/tmp/ipc.sock" }),
      });

      expect(mockBuildBwrapArgv).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/worktrees/run1/step1",
          repoRoot: "/repo",
          sockets: expect.arrayContaining(["/tmp/ipc.sock"]),
        })
      );
    });

    it("passes extra_ro_binds and extra_rw_binds from sandbox config", () => {
      mockIsBwrapAvailable.mockReturnValue(true);

      applySandbox({
        command: "claude",
        args: [],
        cwd: "/worktrees/run1/step1",
        env: {},
        ctx: makeCtx({
          sandbox: {
            extra_ro_binds: ["/my/data"],
            extra_rw_binds: ["/my/writable"],
          },
        }),
      });

      expect(mockBuildBwrapArgv).toHaveBeenCalledWith(
        expect.objectContaining({
          extra_ro_binds: ["/my/data"],
          extra_rw_binds: ["/my/writable"],
        })
      );
    });

    it("logs a sandbox info line", () => {
      mockIsBwrapAvailable.mockReturnValue(true);
      const info = vi.fn();

      applySandbox({
        command: "claude",
        args: [],
        cwd: "/worktrees/run1/step1",
        env: {},
        ctx: makeCtx({ logger: { info, error: vi.fn() } }),
      });

      expect(info).toHaveBeenCalledWith(expect.stringContaining("sandbox: bwrap"));
    });
  });

  describe("no sandbox config (default behaviour)", () => {
    it("uses bwrap when available, even with no sandbox config in ctx", () => {
      mockIsBwrapAvailable.mockReturnValue(true);

      const result = applySandbox({
        command: "claude",
        args: [],
        cwd: "/worktrees/run1/step1",
        env: {},
        ctx: makeCtx({ sandbox: undefined }),
      });

      expect(result.command).toBe("bwrap");
    });

    it("falls back gracefully when bwrap is absent and no config", () => {
      mockIsBwrapAvailable.mockReturnValue(false);

      const result = applySandbox({
        command: "claude",
        args: [],
        cwd: "/worktrees/run1/step1",
        env: {},
        ctx: makeCtx({ sandbox: undefined }),
      });

      expect(result.command).toBe("claude");
    });
  });
});
