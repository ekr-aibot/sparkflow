/**
 * Integration tests for the bwrap sandbox. These tests actually spawn bwrap
 * to verify filesystem confinement.
 *
 * Requirements:
 *   - Linux (process.platform === "linux")
 *   - bwrap available in PATH
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isBwrapAvailable, resetBwrapAvailableCache, buildBwrapArgv } from "../../src/sandbox/bwrap.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isLinux = process.platform === "linux";
// /var/tmp is required so the parent repo lives outside the /tmp bind mount,
// making parent-repo confinement tests meaningful.
const hasVarTmp = existsSync("/var/tmp");

function hasBwrap(): boolean {
  resetBwrapAvailableCache();
  return isBwrapAvailable();
}

/**
 * Use /var/tmp for the parent repo so it is outside the /tmp bind mount.
 * /var/tmp is NOT bound in our bwrap profile (only /tmp is), so we can verify
 * that the parent repo root is inaccessible while the worktree and .git are.
 */
function repoTmpDir(): string {
  return mkdtempSync(join("/var/tmp", "sf-sandbox-repo-"));
}

describe.skipIf(!isLinux || !hasBwrap() || !hasVarTmp)("bwrap integration", () => {
  let repoDir: string;
  let worktreeDir: string;
  let testFile: string;

  beforeAll(() => {
    // Create a temp git repository OUTSIDE /tmp so it is not covered by the
    // /tmp bind mount in the sandbox.
    repoDir = repoTmpDir();
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });

    testFile = join(repoDir, "README.md");
    writeFileSync(testFile, "# Test Repo\n");
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });

    // Create a worktree in /tmp (covered by the sandbox's /tmp bind)
    worktreeDir = mkdtempSync(join(tmpdir(), "sf-sandbox-wt-"));
    // git worktree add requires non-existent path
    rmSync(worktreeDir, { recursive: true });
    execFileSync("git", ["worktree", "add", "-b", "test-branch", worktreeDir], {
      cwd: repoDir,
      stdio: "pipe",
    });
  });

  afterAll(() => {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktreeDir], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch { /* ignore */ }
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function runInSandbox(shellCmd: string): { exitCode: number; stdout: string; stderr: string } {
    // SPARKFLOW_ROOT for the test: 2 levels up from test/sandbox/ = project root.
    const testSparkflowRoot = resolve(__dirname, "../../");

    const bwrapArgv = buildBwrapArgv({
      command: "sh",
      args: ["-c", shellCmd],
      cwd: worktreeDir,
      env: {
        PATH: process.env.PATH ?? "/run/current-system/sw/bin:/usr/bin:/bin",
        HOME: homedir(),
      },
      repoRoot: repoDir,
      sparkflowRoot: testSparkflowRoot,
    });

    const result = spawnSync("bwrap", bwrapArgv, {
      env: process.env as Record<string, string>,
      encoding: "utf8",
    });

    return {
      exitCode: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  it("ls inside the worktree succeeds", () => {
    const { exitCode } = runInSandbox(`ls "${worktreeDir}"`);
    expect(exitCode).toBe(0);
  });

  it("parent repo working tree appears empty — files not bound", () => {
    // bwrap creates the parent dir as an empty placeholder (mount-point parent)
    // for the .git bind mount. The actual repo files are not bound, so they are
    // not accessible from inside the sandbox.
    const { stdout } = runInSandbox(`ls "${repoDir}" 2>/dev/null`);
    expect(stdout).not.toContain("README.md");
  });

  it("reading a file in the parent working tree fails", () => {
    const { exitCode } = runInSandbox(`cat "${testFile}" 2>/dev/null`);
    expect(exitCode).not.toBe(0);
  });

  it("reading ~/.ssh fails (not bound)", () => {
    const sshDir = join(homedir(), ".ssh");
    if (!existsSync(sshDir)) return; // No .ssh dir → skip
    const { exitCode } = runInSandbox(`ls "${sshDir}" 2>/dev/null`);
    expect(exitCode).not.toBe(0);
  });

  it("git status inside the worktree succeeds (git plumbing accessible)", () => {
    const { exitCode, stderr } = runInSandbox(`cd "${worktreeDir}" && git status`);
    // Treat missing git binary in sandbox as a skip (environment-specific)
    if (stderr.includes("not found") || stderr.includes("No such file")) return;
    expect(exitCode).toBe(0);
  });

  it("/proc is accessible", () => {
    const { exitCode } = runInSandbox("test -d /proc");
    expect(exitCode).toBe(0);
  });

  it("/tmp is accessible and writable", () => {
    const { exitCode } = runInSandbox("touch /tmp/sandbox-write-test");
    expect(exitCode).toBe(0);
  });

  it("git commit inside the worktree succeeds (objects/refs are RW)", () => {
    const { exitCode, stderr } = runInSandbox(
      `cd "${worktreeDir}" && echo "hello" > sandbox-test.txt && git add sandbox-test.txt && git commit -m "sandbox test commit"`
    );
    // Treat missing git binary as an environment skip
    if (stderr.includes("not found") || stderr.includes("No such file")) return;
    expect(exitCode).toBe(0);
  });
});
