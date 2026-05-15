import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  isBwrapAvailable,
  resetBwrapAvailableCache,
  buildBwrapArgv,
  gitWorktreeBinds,
} from "../../src/sandbox/bwrap.js";

const mockExec = vi.mocked(execFileSync);
const mockExists = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  resetBwrapAvailableCache();
  // Default: all paths exist
  mockExists.mockReturnValue(true);
  // Default: bwrap --version succeeds
  mockExec.mockReturnValue(Buffer.from("bwrap 0.9.0\n"));
  // Default: .git file points to a sidecar at /repo/.git/worktrees/run1-step1
  mockReadFileSync.mockReturnValue("gitdir: /repo/.git/worktrees/run1-step1\n" as any);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isBwrapAvailable", () => {
  it("returns true when bwrap --version succeeds", () => {
    expect(isBwrapAvailable()).toBe(true);
    expect(mockExec).toHaveBeenCalledWith("bwrap", ["--version"], { stdio: "pipe" });
  });

  it("returns false when bwrap --version throws", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    expect(isBwrapAvailable()).toBe(false);
  });

  it("caches the result", () => {
    isBwrapAvailable();
    isBwrapAvailable();
    // bwrap probe is called once; the package.json probe (from SPARKFLOW_ROOT init)
    // may also call execFileSync — filter for the bwrap call specifically.
    const bwrapCalls = mockExec.mock.calls.filter(([cmd]) => cmd === "bwrap");
    expect(bwrapCalls).toHaveLength(1);
  });

  it("resetBwrapAvailableCache forces re-probe", () => {
    isBwrapAvailable();
    resetBwrapAvailableCache();
    isBwrapAvailable();
    const bwrapCalls = mockExec.mock.calls.filter(([cmd]) => cmd === "bwrap");
    expect(bwrapCalls).toHaveLength(2);
  });
});

describe("buildBwrapArgv", () => {
  const BASE_OPTS = {
    command: "claude",
    args: ["--print", "--output-format", "stream-json"],
    cwd: "/worktrees/run1/step1",
    env: { ANTHROPIC_API_KEY: "sk-test", PATH: "/usr/bin:/bin" },
    repoRoot: "/repo",
    sparkflowRoot: "/sparkflow",
  };

  it("includes namespace isolation flags", () => {
    const argv = buildBwrapArgv(BASE_OPTS);
    expect(argv).toContain("--unshare-user");
    expect(argv).toContain("--unshare-pid");
    expect(argv).toContain("--unshare-uts");
    expect(argv).toContain("--unshare-ipc");
    expect(argv).toContain("--die-with-parent");
  });

  it("starts with --tmpfs / and proc/dev", () => {
    const argv = buildBwrapArgv(BASE_OPTS);
    expect(argv).toContain("--tmpfs");
    const tmpfsIdx = argv.indexOf("--tmpfs");
    expect(argv[tmpfsIdx + 1]).toBe("/");
    expect(argv).toContain("--proc");
    expect(argv).toContain("--dev");
  });

  it("binds NixOS paths with --ro-bind-try", () => {
    const argv = buildBwrapArgv(BASE_OPTS);
    // Should have --ro-bind-try /nix /nix pair
    const nixIdx = argv.indexOf("--ro-bind-try");
    const nixPairs: string[][] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--ro-bind-try") {
        nixPairs.push([argv[i + 1], argv[i + 2]]);
      }
    }
    expect(nixPairs).toContainEqual(["/nix", "/nix"]);
    expect(nixPairs).toContainEqual(["/etc", "/etc"]);
  });

  it("binds FHS paths with --ro-bind-try as fallback", () => {
    const argv = buildBwrapArgv(BASE_OPTS);
    const roBrTry: string[][] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--ro-bind-try") {
        roBrTry.push([argv[i + 1], argv[i + 2]]);
      }
    }
    expect(roBrTry).toContainEqual(["/usr", "/usr"]);
    expect(roBrTry).toContainEqual(["/bin", "/bin"]);
  });

  it("binds cwd RW", () => {
    const argv = buildBwrapArgv(BASE_OPTS);
    const rwPairs: string[][] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--bind") {
        rwPairs.push([argv[i + 1], argv[i + 2]]);
      }
    }
    expect(rwPairs).toContainEqual(["/worktrees/run1/step1", "/worktrees/run1/step1"]);
  });

  it("binds worktree sidecar/objects/refs RW and HEAD/config RO when in a worktree", () => {
    const argv = buildBwrapArgv(BASE_OPTS);
    const rwPairs: string[][] = [];
    const roPairs: string[][] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--bind") rwPairs.push([argv[i + 1], argv[i + 2]]);
      if (argv[i] === "--ro-bind") roPairs.push([argv[i + 1], argv[i + 2]]);
    }
    // Sidecar RW (git ref updates); objects/refs RW (git commit writes here)
    expect(rwPairs).toContainEqual(["/repo/.git/worktrees/run1-step1", "/repo/.git/worktrees/run1-step1"]);
    expect(rwPairs.some(([src]) => src === "/repo/.git/objects")).toBe(true);
    expect(rwPairs.some(([src]) => src === "/repo/.git/refs")).toBe(true);
    // HEAD and config stay RO
    expect(roPairs.some(([src]) => src === "/repo/.git/HEAD")).toBe(true);
    expect(roPairs.some(([src]) => src === "/repo/.git/config")).toBe(true);
  });

  it("does NOT bind parent repo working tree", () => {
    const argv = buildBwrapArgv(BASE_OPTS);
    const allBinds: string[][] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--bind" || argv[i] === "--ro-bind") {
        allBinds.push([argv[i + 1], argv[i + 2]]);
      }
    }
    // The parent working tree (/repo) itself must NOT be bound
    const repoRootBound = allBinds.some(([src]) => src === "/repo");
    expect(repoRootBound).toBe(false);
    // But .git subdirs are accessible (objects, refs, sidecar, etc.)
    expect(allBinds.some(([src]) => src.startsWith("/repo/.git/"))).toBe(true);
  });

  it("does not add .git bind when cwd equals repoRoot (not a worktree)", () => {
    const argv = buildBwrapArgv({ ...BASE_OPTS, repoRoot: BASE_OPTS.cwd });
    const rwPairs: string[][] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--bind") {
        rwPairs.push([argv[i + 1], argv[i + 2]]);
      }
    }
    // No parent .git dir bind when not in a worktree
    const gitBound = rwPairs.some(([src]) => src.endsWith("/.git"));
    expect(gitBound).toBe(false);
  });

  it("clears env and re-sets via --setenv for allowlisted vars", () => {
    const argv = buildBwrapArgv(BASE_OPTS);
    expect(argv).toContain("--clearenv");
    const clearIdx = argv.indexOf("--clearenv");
    const setenvCalls: Record<string, string> = {};
    for (let i = clearIdx + 1; i < argv.length - 2; i++) {
      if (argv[i] === "--setenv") {
        setenvCalls[argv[i + 1]] = argv[i + 2];
      }
    }
    expect(setenvCalls["ANTHROPIC_API_KEY"]).toBe("sk-test");
    expect(setenvCalls["PATH"]).toBe("/usr/bin:/bin");
  });

  it("sets --chdir to cwd", () => {
    const argv = buildBwrapArgv(BASE_OPTS);
    const idx = argv.indexOf("--chdir");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("/worktrees/run1/step1");
  });

  it("terminates with -- command args", () => {
    const argv = buildBwrapArgv(BASE_OPTS);
    const dashIdx = argv.lastIndexOf("--");
    expect(dashIdx).toBeGreaterThan(-1);
    expect(argv[dashIdx + 1]).toBe("claude");
    expect(argv[dashIdx + 2]).toBe("--print");
  });

  it("appends extra_ro_binds with --ro-bind-try", () => {
    const argv = buildBwrapArgv({
      ...BASE_OPTS,
      extra_ro_binds: ["/my/data"],
    });
    const idx = argv.indexOf("/my/data");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx - 1]).toBe("--ro-bind-try");
  });

  it("appends extra_rw_binds with --bind", () => {
    const argv = buildBwrapArgv({
      ...BASE_OPTS,
      extra_rw_binds: ["/my/writable"],
    });
    const rw: string[][] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--bind") rw.push([argv[i + 1], argv[i + 2]]);
    }
    expect(rw).toContainEqual(["/my/writable", "/my/writable"]);
  });

  it("binds sockets that exist", () => {
    mockExists.mockImplementation((p) => String(p) !== "/no/such.sock");
    const argv = buildBwrapArgv({
      ...BASE_OPTS,
      sockets: ["/run/user/1000/sparkflow.sock", "/no/such.sock"],
    });
    const rw: string[][] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--bind") rw.push([argv[i + 1], argv[i + 2]]);
    }
    expect(rw).toContainEqual(["/run/user/1000/sparkflow.sock", "/run/user/1000/sparkflow.sock"]);
    const nosockBound = rw.some(([s]) => s === "/no/such.sock");
    expect(nosockBound).toBe(false);
  });

  it("skips .git bind when .git dir does not exist", () => {
    mockExists.mockImplementation((p) => !String(p).endsWith("/.git"));
    const argv = buildBwrapArgv(BASE_OPTS);
    const rw: string[][] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--bind") rw.push([argv[i + 1], argv[i + 2]]);
    }
    const gitBound = rw.some(([s]) => s.endsWith("/.git"));
    expect(gitBound).toBe(false);
  });
});

describe("gitWorktreeBinds", () => {
  it("returns single cwd bind when not in a worktree (cwd === repoRoot)", () => {
    mockExists.mockReturnValue(true);
    const binds = gitWorktreeBinds("/repo", "/repo");
    expect(binds).toHaveLength(1);
    expect(binds[0]).toEqual(["--bind", "/repo", "/repo"]);
  });

  it("returns worktree RW + sidecar/objects/refs RW + HEAD/config RO when in a worktree", () => {
    mockExists.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("gitdir: /repo/.git/worktrees/step1\n" as any);
    const binds = gitWorktreeBinds("/repo", "/worktrees/run1/step1");
    const rwBinds = binds.filter((b) => b[0] === "--bind");
    const roBinds = binds.filter((b) => b[0] === "--ro-bind");
    // Worktree dir must be RW
    expect(rwBinds).toContainEqual(["--bind", "/worktrees/run1/step1", "/worktrees/run1/step1"]);
    // Sidecar must be RW
    expect(rwBinds).toContainEqual(["--bind", "/repo/.git/worktrees/step1", "/repo/.git/worktrees/step1"]);
    // objects and refs must be RW (git commits need write access to both)
    expect(rwBinds.some(([, src]) => src === "/repo/.git/objects")).toBe(true);
    expect(rwBinds.some(([, src]) => src === "/repo/.git/refs")).toBe(true);
    // HEAD and config must stay RO
    expect(roBinds.some(([, src]) => src === "/repo/.git/HEAD")).toBe(true);
    expect(roBinds.some(([, src]) => src === "/repo/.git/config")).toBe(true);
  });

  it("falls back to RO bind of entire .git when sidecar cannot be read", () => {
    mockExists.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const binds = gitWorktreeBinds("/repo", "/worktrees/run1/step1");
    const roBinds = binds.filter((b) => b[0] === "--ro-bind");
    expect(roBinds).toContainEqual(["--ro-bind", "/repo/.git", "/repo/.git"]);
    // The entire .git RO bind must NOT be RW
    const rwBinds = binds.filter((b) => b[0] === "--bind");
    expect(rwBinds.some(([, src]) => src === "/repo/.git")).toBe(false);
  });

  it("omits .git bind when .git dir does not exist", () => {
    mockExists.mockImplementation((p) => !String(p).endsWith("/.git"));
    const binds = gitWorktreeBinds("/repo", "/worktrees/run1/step1");
    expect(binds).toHaveLength(1);
    expect(binds[0]).toEqual(["--bind", "/worktrees/run1/step1", "/worktrees/run1/step1"]);
  });

  it("does NOT bind the parent working tree", () => {
    mockExists.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("gitdir: /repo/.git/worktrees/step1\n" as any);
    const binds = gitWorktreeBinds("/repo", "/worktrees/run1/step1");
    const allSrcs = binds.map(([, src]) => src);
    // /repo itself must not be bound
    expect(allSrcs).not.toContain("/repo");
    // But .git subdirs are accessible
    expect(allSrcs.some((src) => src.startsWith("/repo/.git/"))).toBe(true);
  });
});
