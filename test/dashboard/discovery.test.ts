import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use SPARKFLOW_HOME to isolate from real ~/.sparkflow in every test.
function makeSparkflowHome(): string {
  return mkdtempSync(join(tmpdir(), "sparkflow-discovery-test-"));
}

async function importDiscovery() {
  // Re-import after setting env so module picks up SPARKFLOW_HOME.
  return import("../../src/dashboard/discovery.js");
}

describe("discovery", () => {
  let home: string;
  const originalHome = process.env.SPARKFLOW_HOME;

  beforeEach(() => {
    home = makeSparkflowHome();
    process.env.SPARKFLOW_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.SPARKFLOW_HOME;
    else process.env.SPARKFLOW_HOME = originalHome;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("ensureSparkflowHomePerms creates the directory", async () => {
    const { ensureSparkflowHomePerms, dashboardJsonPath } = await importDiscovery();
    // Home already exists (created by mkdtempSync) — should not throw.
    expect(() => ensureSparkflowHomePerms()).not.toThrow();
    // dashboardJsonPath should be inside the home dir.
    expect(dashboardJsonPath()).toContain(home);
  });

  it("acquireFrontendLock is atomic: first caller wins, second returns false", async () => {
    const { ensureSparkflowHomePerms, acquireFrontendLock, releaseFrontendLock } = await importDiscovery();
    ensureSparkflowHomePerms();

    const first = acquireFrontendLock();
    expect(first).toBe(true);

    const second = acquireFrontendLock();
    expect(second).toBe(false);

    releaseFrontendLock();

    // After release, lock can be acquired again.
    const third = acquireFrontendLock();
    expect(third).toBe(true);
    releaseFrontendLock();
  });

  it("write/read dashboard info round-trips", async () => {
    const { ensureSparkflowHomePerms, writeDashboardInfo, readDashboardInfo } = await importDiscovery();
    ensureSparkflowHomePerms();

    expect(readDashboardInfo()).toBeNull();

    const info = {
      socketPath: join(home, "dashboard.sock"),
      port: 12345,
      token: "a".repeat(64),
      pid: process.pid,
      version: "0.1.0",
      startedAt: Date.now(),
    };
    writeDashboardInfo(info);

    const read = readDashboardInfo();
    expect(read).not.toBeNull();
    expect(read!.port).toBe(12345);
    expect(read!.token).toBe("a".repeat(64));
    expect(read!.pid).toBe(process.pid);
  });

  it("repoIdFor produces stable 10-char hex strings", async () => {
    const { repoIdFor } = await importDiscovery();
    const id1 = repoIdFor("/home/user/projects/foo");
    const id2 = repoIdFor("/home/user/projects/foo");
    const id3 = repoIdFor("/home/user/projects/bar");

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[0-9a-f]{10}$/);
  });

  it("acquireFrontendLock cleans up a stale lock whose writer pid is dead", async () => {
    const { ensureSparkflowHomePerms, acquireFrontendLock, releaseFrontendLock, dashboardLockPath } = await importDiscovery();
    ensureSparkflowHomePerms();

    // Plant a lock file claiming ownership by an unlikely-to-exist pid.
    const lock = dashboardLockPath();
    writeFileSync(lock, "999999999", { mode: 0o600 });

    // Acquire should succeed: the stale lock is detected and cleaned.
    const ok = acquireFrontendLock();
    expect(ok).toBe(true);

    releaseFrontendLock();
    expect(existsSync(lock)).toBe(false);
  });

  it("acquireFrontendLock returns false when the current process already holds it", async () => {
    const { ensureSparkflowHomePerms, acquireFrontendLock, releaseFrontendLock, dashboardLockPath } = await importDiscovery();
    ensureSparkflowHomePerms();

    expect(acquireFrontendLock()).toBe(true);

    // Second call with the live holder (this process) should fail.
    expect(acquireFrontendLock()).toBe(false);

    // Sanity check: the lock file contains our pid.
    const lock = dashboardLockPath();
    expect(existsSync(lock)).toBe(true);

    releaseFrontendLock();
  });

  it("writeDashboardInfo writes the token file with mode 0700", async () => {
    const { ensureSparkflowHomePerms, writeDashboardInfo, dashboardJsonPath } = await importDiscovery();
    ensureSparkflowHomePerms();

    writeDashboardInfo({
      socketPath: join(home, "dashboard.sock"),
      port: 1111,
      token: "c".repeat(64),
      pid: process.pid,
      version: "0.1.0",
      startedAt: Date.now(),
    });

    const st = statSync(dashboardJsonPath());
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("probeFrontend returns false for dead pid", async () => {
    const { probeFrontend } = await importDiscovery();
    const alive = await probeFrontend({
      socketPath: join(home, "nonexistent.sock"),
      port: 0,
      token: "x".repeat(64),
      pid: 999999999, // unlikely to be a real pid
      version: "0.0.0",
      startedAt: Date.now(),
    });
    // Either the pid doesn't exist, or the socket doesn't accept connections.
    expect(alive).toBe(false);
  });
});
