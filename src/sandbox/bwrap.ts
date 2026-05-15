import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Sparkflow installation root. Works for both source (src/sandbox/) and
 * compiled (dist/src/sandbox/) locations by walking up until package.json is
 * found. Falls back to 3 levels up if package.json is not found.
 */
function deriveSparkflowRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
    if (existsSync(resolve(dir, "package.json"))) {
      return dir;
    }
  }
  return resolve(__dirname, "../../..");
}

export const SPARKFLOW_ROOT = deriveSparkflowRoot();

let _bwrapAvailable: boolean | undefined;

/** Returns true if `bwrap` is available on this system. Caches the result. */
export function isBwrapAvailable(): boolean {
  if (_bwrapAvailable !== undefined) return _bwrapAvailable;
  try {
    execFileSync("bwrap", ["--version"], { stdio: "pipe" });
    _bwrapAvailable = true;
  } catch {
    _bwrapAvailable = false;
  }
  return _bwrapAvailable;
}

/** Reset the cached bwrap availability check (for testing). */
export function resetBwrapAvailableCache(): void {
  _bwrapAvailable = undefined;
}

export interface BwrapOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Parent repo root. When set and different from cwd, git worktree binds are added. */
  repoRoot?: string;
  /** Unix socket paths to bind RW inside the sandbox. */
  sockets?: string[];
  extra_ro_binds?: string[];
  extra_rw_binds?: string[];
  /** Override the sparkflow root path (for testing). */
  sparkflowRoot?: string;
}

/**
 * Builds the bwrap argv that wraps `[opts.command, ...opts.args]` in a
 * filesystem-isolated sandbox. Pure function — no side effects.
 *
 * Profile:
 * - Unprivileged user/pid/uts/ipc namespaces, no network isolation.
 * - Empty root via --tmpfs /, then explicit bind mounts for what the agent needs.
 * - NixOS-first: /nix and /run/current-system bound RO; /usr /bin /lib as fallbacks.
 * - Worktree bound RW; parent repo .git bound RW (for commits); parent working tree NOT bound.
 * - ~/.claude bound RW (claude writes session state); ~/.sparkflow bound RO.
 * - Env filtered via allowlist; clearenv + --setenv for child.
 */
export function buildBwrapArgv(opts: BwrapOptions): string[] {
  const home = homedir();
  const sfRoot = opts.sparkflowRoot ?? SPARKFLOW_ROOT;
  const argv: string[] = [];

  // Namespace isolation (no --unshare-net: network is allowed by default)
  argv.push("--unshare-user", "--unshare-pid", "--unshare-uts", "--unshare-ipc");

  // Preserve the host UID/GID inside the user namespace so file ownership
  // checks behave the same as outside the sandbox.
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  argv.push("--uid", String(uid), "--gid", String(gid));

  argv.push("--die-with-parent");

  // Start with an empty root, then populate via bind mounts
  argv.push("--tmpfs", "/");
  argv.push("--proc", "/proc");
  argv.push("--dev", "/dev");

  // NixOS: all tools live in /nix
  argv.push("--ro-bind-try", "/nix", "/nix");
  // NixOS shell init, certs, resolv.conf
  argv.push("--ro-bind-try", "/run/current-system", "/run/current-system");
  // /etc covers hosts, resolv.conf, ssl certs on both NixOS and FHS
  argv.push("--ro-bind-try", "/etc", "/etc");

  // FHS fallback for non-NixOS systems
  argv.push("--ro-bind-try", "/usr", "/usr");
  argv.push("--ro-bind-try", "/bin", "/bin");
  argv.push("--ro-bind-try", "/lib", "/lib");
  argv.push("--ro-bind-try", "/lib64", "/lib64");
  argv.push("--ro-bind-try", "/sbin", "/sbin");

  // Claude config: RW because claude writes session state here
  const claudeDir = `${home}/.claude`;
  if (existsSync(claudeDir)) {
    argv.push("--bind", claudeDir, claudeDir);
  }

  // Sparkflow user config: RO (workflow JSON files)
  const sfUserDir = `${home}/.sparkflow`;
  if (existsSync(sfUserDir)) {
    argv.push("--ro-bind", sfUserDir, sfUserDir);
  }

  // Sparkflow installation root: RO (MCP server binary, etc.)
  if (existsSync(sfRoot)) {
    argv.push("--ro-bind", sfRoot, sfRoot);
  }

  // Worktree / cwd and git binds
  for (const bind of gitWorktreeBinds(opts.repoRoot ?? opts.cwd, opts.cwd)) {
    argv.push(...bind);
  }

  // /tmp: RW for temp files (MCP config, scratch space)
  argv.push("--bind", "/tmp", "/tmp");

  // Sockets needed by child (MCP IPC, etc.)
  for (const sock of opts.sockets ?? []) {
    if (sock && existsSync(sock)) {
      argv.push("--bind", sock, sock);
    }
  }

  // User-specified extra binds
  for (const p of opts.extra_ro_binds ?? []) {
    argv.push("--ro-bind-try", p, p);
  }
  for (const p of opts.extra_rw_binds ?? []) {
    argv.push("--bind", p, p);
  }

  // Environment: clear everything, then pass through the allowlist
  argv.push("--clearenv");
  for (const [k, v] of Object.entries(buildPassthroughEnv(opts.env))) {
    argv.push("--setenv", k, v);
  }

  // Set working directory inside the sandbox
  argv.push("--chdir", opts.cwd);

  // The command to run inside the sandbox
  argv.push("--", opts.command, ...opts.args);

  return argv;
}

/** Env var patterns passed through into the sandboxed child. Everything else is stripped. */
const ENV_ALLOWLIST: RegExp[] = [
  /^HOME$/,
  /^PATH$/,
  /^TERM$/,
  /^LANG$/,
  /^LC_/,
  /^USER$/,
  /^LOGNAME$/,
  /^SHELL$/,
  /^COLORTERM$/,
  /^NO_COLOR$/,
  /^ANTHROPIC_/,
  /^SPARKFLOW_/,
  /^OPENAI_/,
  /^GH_/,
  /^GITHUB_/,
  /^GIT_/,
  /^NODE_/,
  /^NPM_/,
  /^XDG_/,
];

function buildPassthroughEnv(extraEnv: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  const src: Record<string, string | undefined> = { ...(process.env as Record<string, string | undefined>), ...extraEnv };
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (ENV_ALLOWLIST.some((re) => re.test(k))) {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Returns the bwrap bind-mount flags needed for git operations inside a worktree.
 *
 * When repoRoot === worktreePath (not in a worktree), returns a single RW bind
 * for the directory. When in a proper worktree, uses surgical binds:
 *   1. `--bind <worktreePath> <worktreePath>` — the agent's working directory (RW)
 *   2. `--bind <sidecar> <sidecar>` — the worktree sidecar inside .git/worktrees/<id>/ (RW,
 *      needed for git ref updates); sidecar path is read from <worktreePath>/.git file.
 *   3. `--ro-bind <repoRoot>/.git/{objects,refs,HEAD,config,info,packed-refs}` — shared git
 *      plumbing the agent needs to read (RO — the agent must not rewrite parent repo refs).
 *
 * The parent repo's working tree (<repoRoot>/) is intentionally NOT bound, so the
 * agent cannot read or write files there.
 *
 * Fallback: if the sidecar cannot be determined (e.g., not a real worktree), binds the
 * entire <repoRoot>/.git as RO to preserve read access without granting write access.
 */
export function gitWorktreeBinds(repoRoot: string, worktreePath: string): string[][] {
  const binds: string[][] = [];

  // The agent's working directory (RW)
  binds.push(["--bind", worktreePath, worktreePath]);

  // Not in a worktree — no additional git binds needed
  if (repoRoot === worktreePath) {
    return binds;
  }

  const gitDir = `${repoRoot}/.git`;
  if (!existsSync(gitDir)) {
    return binds;
  }

  // Read the .git file inside the worktree to discover the sidecar path.
  // Format: "gitdir: /absolute/path/to/<repo>/.git/worktrees/<id>"
  let sidecarPath: string | undefined;
  try {
    const content = readFileSync(`${worktreePath}/.git`, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(content);
    if (match) {
      sidecarPath = match[1].trim();
    }
  } catch {
    // Not a file-based worktree or unreadable — fall back below
  }

  if (sidecarPath && existsSync(sidecarPath)) {
    // Surgical: sidecar RW (git needs to write ORIG_HEAD, HEAD ref, etc.)
    binds.push(["--bind", sidecarPath, sidecarPath]);
    // objects and refs must be RW so the agent can `git commit` in its worktree
    // branch. New commit objects go into .git/objects; the branch ref is updated
    // under .git/refs/heads/<branch>. The escape-detection layer (engine.ts)
    // catches any parent HEAD movement post-step, keeping the constraint visible.
    //
    // HEAD and config stay RO: HEAD prevents redirecting the parent repo's
    // checked-out branch; config prevents overwriting shared git settings.
    const RW_PARTS = new Set(["objects", "refs"]);
    for (const part of ["objects", "refs", "HEAD", "config", "info", "packed-refs"]) {
      const partPath = `${gitDir}/${part}`;
      if (existsSync(partPath)) {
        binds.push([RW_PARTS.has(part) ? "--bind" : "--ro-bind", partPath, partPath]);
      }
    }
  } else {
    // Fallback: bind the whole .git RO — git reads work, but writes are blocked.
    binds.push(["--ro-bind", gitDir, gitDir]);
  }

  return binds;
}
