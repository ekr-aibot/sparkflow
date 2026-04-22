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
  writeFileSync,
  readFileSync,
  statSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { readFileSync as _readPkg } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_JSON_PATH = resolve(__dirname, "..", "..", "..", "package.json");

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SPARKFLOW_VERSION = readPackageVersion();

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
 */
export function acquireFrontendLock(): boolean {
  const lock = dashboardLockPath();
  try {
    const fd = openSync(lock, "ax", 0o600);
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
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

/** Write dashboard info with mode 0600. */
export function writeDashboardInfo(info: DashboardInfo): void {
  const path = dashboardJsonPath();
  writeFileSync(path, JSON.stringify(info, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
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

/**
 * Derive a display name for a repo. If another repo in `existingNames` already
 * uses the same basename, append the first 4 chars of `repoId` in parens.
 */
export function repoDisplayName(absPath: string, repoId: string, existingNames: Set<string>): string {
  const base = absPath.split("/").at(-1) ?? absPath;
  if (!existingNames.has(base)) return base;
  return `${base} (${repoId.slice(0, 4)})`;
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
