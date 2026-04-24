/**
 * Manages the ~/.sparkflow/ directory, dashboard.json, and the frontend lockfile.
 *
 * The SPARKFLOW_HOME env var overrides ~/.sparkflow/ so tests can use a tmpdir
 * without touching the real user home.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  openSync,
  closeSync,
  fchmodSync,
  renameSync,
  writeSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Walk up from this module until we find a package.json with a sparkflow
 * name. This makes the version resolve identically whether the code is
 * loaded from `src/dashboard/` (tests, tsx) or `dist/src/dashboard/` (npm
 * install, production).
 */
function readPackageVersion(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: string; version?: string };
      if (pkg.name === "sparkflow" && typeof pkg.version === "string") return pkg.version;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

export const SPARKFLOW_VERSION = readPackageVersion();

/**
 * Frontend ↔ engine wire-format version. Bump this integer whenever the IPC
 * message shapes change in a way that older peers can't understand; leave
 * it alone for patch-level sparkflow upgrades that don't touch the wire
 * format. The frontend rejects attaches that disagree on this value.
 */
export const SPARKFLOW_PROTOCOL_VERSION = 2;

function sparkflowHome(): string {
  return process.env.SPARKFLOW_HOME ?? join(homedir(), ".sparkflow");
}

export function dashboardJsonPath(): string {
  return join(sparkflowHome(), "dashboard.json");
}

export function dashboardLockPath(): string {
  return join(sparkflowHome(), "dashboard.lock");
}

export function dashboardSockPath(): string {
  return join(sparkflowHome(), "dashboard.sock");
}

export interface DashboardInfo {
  socketPath: string;
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: number;
}

/**
 * Ensure ~/.sparkflow/ exists with mode 0700.
 * Throws if the directory already exists with looser permissions.
 */
export function ensureSparkflowHomePerms(): void {
  const home = sparkflowHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(home);
  } catch (err) {
    throw new Error(`Could not stat ${home}: ${(err as Error).message}`);
  }

  const mode = st.mode & 0o777;
  if ((mode & ~0o700) !== 0) {
    throw new Error(
      `${home} has permissions ${mode.toString(8).padStart(4, "0")}, expected 0700. ` +
        `Fix with: chmod 700 ${home}`,
    );
  }
}

/**
 * Attempt to atomically create the lock file.
 * Returns true if the lock was acquired, false if another process holds it.
 *
 * If an existing lock file refers to a dead pid, it is removed and the
 * acquire is retried so a crashed holder can't deadlock future starts.
 *
 * CAVEAT: the stale-lock recovery is NOT race-free. Two processes racing
 * to replace the same stale lock can both observe the dead pid, sequence
 * their own unlink+create in an interleaving where both end up with their
 * own pid on disk at different moments, and both return `true`. The
 * damage is bounded because the caller (findOrCreateFrontend) also races
 * to spawn a frontend, and the second frontend's `listen(socketPath)`
 * will fail loudly — the overall system self-heals. If true atomicity is
 * ever needed, replace this with flock(2) via a helper module.
 *
 * We do two things to narrow the window:
 *  - Compare-and-unlink: re-read the pid immediately before unlinking so
 *    we don't blow away a fresh live lock that a racer just created.
 *  - Verify-after-acquire: confirm our own pid is what ends up on disk.
 */
export function acquireFrontendLock(): boolean {
  const lock = dashboardLockPath();
  const tryCreate = (): boolean => {
    try {
      const fd = openSync(lock, "ax", 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  };

  const readPid = (): number => {
    try {
      return parseInt(readFileSync(lock, "utf-8").trim(), 10) || 0;
    } catch {
      return 0;
    }
  };

  const confirmOwnership = (): boolean => readPid() === process.pid;

  if (tryCreate()) return confirmOwnership();

  // EEXIST: inspect the holder pid. Back off if it looks alive.
  const holderPid = readPid();
  if (holderPid > 0 && isAlive(holderPid)) return false;

  // Compare-and-unlink: only remove the lock if the pid we sampled is
  // still the one on disk. A racer who already swapped in a live lock
  // will have a different pid here and we'll back off.
  try {
    if (readPid() !== holderPid) return false;
    unlinkSync(lock);
  } catch {
    /* another racer may have unlinked it first — fall through and retry */
  }
  if (!tryCreate()) return false;
  return confirmOwnership();
}

/** Release the lock file if we hold it. */
export function releaseFrontendLock(): void {
  try {
    unlinkSync(dashboardLockPath());
  } catch {
    /* ignore */
  }
}

/** Read the dashboard info file. Returns null if not present or invalid. */
export function readDashboardInfo(): DashboardInfo | null {
  try {
    const raw = readFileSync(dashboardJsonPath(), "utf-8");
    return JSON.parse(raw) as DashboardInfo;
  } catch {
    return null;
  }
}

/**
 * Atomically write dashboard info with mode 0700.
 *
 * Uses the write-to-tmp-then-rename pattern so readers never see a partial
 * file or a brief ENOENT: the tmp file is created exclusively (wx) so we
 * can't follow a planted symlink, chmod'd to 0700 via fchmod (openSync's
 * mode arg is subject to umask), written in full, then renamed over the
 * destination. rename(2) on the same filesystem is atomic on POSIX.
 */
export function writeDashboardInfo(info: DashboardInfo): void {
  const path = dashboardJsonPath();
  const tmpPath = `${path}.tmp.${process.pid}`;

  // Remove any straggler from a previous crash before opening exclusively.
  try {
    unlinkSync(tmpPath);
  } catch {
    /* not present */
  }

  // "wx" = O_WRONLY|O_CREAT|O_EXCL — fails if tmpPath exists as any inode
  // type, including symlinks, so an attacker can't redirect the write.
  const fd = openSync(tmpPath, "wx", 0o700);
  try {
    fchmodSync(fd, 0o700);
    writeSync(fd, JSON.stringify(info, null, 2));
    closeSync(fd);
  } catch (err) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Probe whether the frontend described in `info` is actually alive.
 * Returns true if the pid is running AND the socket accepts a connection.
 */
export function probeFrontend(info: DashboardInfo): Promise<boolean> {
  if (!isAlive(info.pid)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      conn.destroy();
      resolve(false);
    }, 2000);
    const conn = createConnection(info.socketPath);
    conn.once("connect", () => {
      clearTimeout(timer);
      conn.destroy();
      resolve(true);
    });
    conn.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Derive a stable 10-hex-char repo ID from the absolute repo path. */
export function repoIdFor(absPath: string): string {
  return createHash("sha256").update(absPath).digest("hex").slice(0, 10);
}

function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
