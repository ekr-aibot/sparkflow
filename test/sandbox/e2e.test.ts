/**
 * End-to-end sandbox integration tests.
 *
 * Runs a feature-development-like workflow (developer → test) through
 * WorkflowEngine with the bwrap sandbox engaged. Verifies:
 *   1. The full pipeline succeeds (sandbox doesn't break normal operation).
 *   2. git commit works inside the sandbox (objects/refs are RW).
 *   3. The developer agent cannot read files from the parent repo working tree
 *      (confinement — requires Linux + bwrap + /var/tmp).
 *
 * Requirements:
 *   - Linux for confinement tests (bwrap is Linux-only).
 *   - bwrap in PATH for sandbox to engage (graceful fallback otherwise).
 *   - /var/tmp for confinement tests (parent repo must sit outside the /tmp bind).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { WorkflowEngine } from "../../src/engine/engine.js";
import type { SparkflowWorkflow } from "../../src/schema/types.js";
import type { Logger } from "../../src/engine/types.js";
import { isBwrapAvailable, resetBwrapAvailableCache } from "../../src/sandbox/bwrap.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isLinux = process.platform === "linux";
const hasVarTmp = existsSync("/var/tmp");

function hasBwrap(): boolean {
  resetBwrapAvailableCache();
  return isBwrapAvailable();
}

/** Logger that captures output for assertions. */
class CapturingLogger implements Logger {
  readonly lines: string[] = [];
  info(msg: string): void { this.lines.push(msg); }
  error(msg: string): void { this.lines.push(`[ERROR] ${msg}`); }
  debug(msg: string): void { /* ignore */ }
}

/**
 * Creates a fake claude binary that:
 *  - Receives stream-json prompts on stdin.
 *  - Writes add.js + add.test.js to cwd.
 *  - Runs `git add . && git commit` (proves commits work inside the sandbox).
 *  - Tries to read process.env.SPARKFLOW_TEST_CANARY if set; reports result.
 *  - Emits a stream-json result event with canary_accessible field.
 */
function createFakeClaude(dir: string): string {
  const scriptPath = join(dir, "claude");
  const content = `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');

if (process.argv.includes('--version')) {
  process.stdout.write('claude-code/0.1.0\\n');
  process.exit(0);
}

const rl = require('readline').createInterface({ input: process.stdin });

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type !== 'user') return;

    // Create the files the test step needs
    fs.writeFileSync('add.js', 'module.exports = (a, b) => a + b;\\n');
    fs.writeFileSync('add.test.js', [
      "const add = require('./add.js');",
      "console.assert(add(2, 3) === 5, '2+3 should be 5');",
      "console.log('PASS');",
    ].join('\\n') + '\\n');

    // Commit so the fork step can see the files
    try {
      execFileSync('git', ['add', '.'], { stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'Add test files'], { stdio: 'pipe' });
    } catch (_) { /* git may not be available in some envs */ }

    // Confinement check: try to read the canary file that lives in the parent
    // repo's working tree (outside the sandbox bind mounts).
    let canaryAccessible = 'not-checked';
    if (process.env.SPARKFLOW_TEST_CANARY) {
      try {
        fs.readFileSync(process.env.SPARKFLOW_TEST_CANARY, 'utf8');
        canaryAccessible = 'yes';
      } catch (_) {
        canaryAccessible = 'no';
      }
    }

    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify({ canary_accessible: canaryAccessible }),
    }) + '\\n');
  } catch (_) {}
});

rl.on('close', () => process.exit(0));
`;
  writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}

/** Creates a minimal git repo and returns its path. */
function createGitRepo(baseDir: string, prefix: string): string {
  const dir = mkdtempSync(join(baseDir, prefix));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m initial", { cwd: dir, stdio: "pipe" });
  return dir;
}

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

let fakeBinDir: string;
let prevPath: string | undefined;
let prevClaudeCmd: string | undefined;
let prevSandbox: string | undefined;

function setupEnv(): void {
  fakeBinDir = mkdtempSync(join(tmpdir(), "sf-sandbox-e2e-bin-"));
  createFakeClaude(fakeBinDir);

  prevPath = process.env.PATH;
  prevClaudeCmd = process.env.SPARKFLOW_CLAUDE_COMMAND;
  prevSandbox = process.env.SPARKFLOW_SANDBOX;

  process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;
  process.env.SPARKFLOW_CLAUDE_COMMAND = join(fakeBinDir, "claude");
  // Leave SPARKFLOW_SANDBOX unset so the sandbox engages if bwrap is available
  delete process.env.SPARKFLOW_SANDBOX;
}

function teardownEnv(): void {
  if (prevPath !== undefined) process.env.PATH = prevPath;
  else delete process.env.PATH;
  if (prevClaudeCmd !== undefined) process.env.SPARKFLOW_CLAUDE_COMMAND = prevClaudeCmd;
  else delete process.env.SPARKFLOW_CLAUDE_COMMAND;
  if (prevSandbox !== undefined) process.env.SPARKFLOW_SANDBOX = prevSandbox;
  else delete process.env.SPARKFLOW_SANDBOX;
  if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Feature-development-like workflow helper
// ---------------------------------------------------------------------------

function makeFeatureDevWorkflow(opts: {
  sandboxRequired?: boolean;
  canaryPath?: string;
}): SparkflowWorkflow {
  const stepEnv = opts.canaryPath
    ? { SPARKFLOW_TEST_CANARY: opts.canaryPath }
    : undefined;

  return {
    version: "1",
    name: "sandbox-e2e",
    entry: "developer",
    defaults: {
      max_retries: 1,
      // Isolated worktree mirrors feature-development.json
      worktree: { mode: "isolated" },
      sandbox: {
        enabled: true,
        required: opts.sandboxRequired ?? false,
      },
    },
    steps: {
      developer: {
        name: "Developer",
        interactive: false,
        runtime: { type: "claude-code", model: "sonnet", auto_accept: true },
        prompt: "Write add.js (exports a + b) and add.test.js, then commit them.",
        env: stepEnv,
        outputs: {
          canary_accessible: { type: "text", description: "Result of confinement check" },
        },
        on_success: [{ step: "test" }],
      },
      test: {
        name: "Test Runner",
        interactive: false,
        // Fork from the run-level isolated worktree so it sees the developer's commits
        worktree: { mode: "fork" },
        runtime: { type: "shell", command: "node", args: ["add.test.js"] },
        timeout: 30,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite 1: workflow succeeds with sandbox enabled (cross-platform)
// ---------------------------------------------------------------------------

describe("sandbox e2e: feature-development-like workflow", () => {
  let repoDir: string;

  beforeEach(() => {
    setupEnv();
    repoDir = createGitRepo(tmpdir(), "sf-sandbox-e2e-repo-");
  });

  afterEach(() => {
    teardownEnv();
    rmSync(repoDir, { recursive: true, force: true });
  });

  it(
    "developer creates & commits code, test step verifies it — full pipeline succeeds",
    async () => {
      const logger = new CapturingLogger();
      const workflow = makeFeatureDevWorkflow({});

      const engine = new WorkflowEngine(workflow, {
        cwd: repoDir,
        workflowDir: repoDir,
        logger,
      });

      const result = await engine.run();

      expect(result.success).toBe(true);
      expect(result.stepResults.get("developer")?.state).toBe("succeeded");
      expect(result.stepResults.get("test")?.state).toBe("succeeded");

      // Verify sandbox was at least considered (log line emitted either way)
      const sandboxLines = logger.lines.filter((l) => l.includes("sandbox:"));
      if (isBwrapAvailable()) {
        // Sandbox engaged: should see the bwrap log line
        expect(sandboxLines.some((l) => l.includes("bwrap"))).toBe(true);
      }
      // If bwrap is unavailable the fallback path logs "bwrap not available";
      // either way, the workflow must succeed — the test above proves it.
    },
    180_000
  );
});

// ---------------------------------------------------------------------------
// Test suite 2: confinement — parent repo working tree is inaccessible
// (requires Linux + bwrap + /var/tmp so parent repo sits outside /tmp bind)
// ---------------------------------------------------------------------------

describe.skipIf(!isLinux || !hasBwrap() || !hasVarTmp)(
  "sandbox e2e: confinement — parent repo files inaccessible inside sandbox",
  () => {
    let repoDir: string;

    beforeEach(() => {
      setupEnv();
      // Parent repo in /var/tmp — NOT covered by the sandbox's /tmp bind mount
      repoDir = createGitRepo("/var/tmp", "sf-sandbox-e2e-conf-repo-");
      // Plant a "secret" file in the parent repo's working tree
      writeFileSync(join(repoDir, "secret.txt"), "TOP SECRET\n");
    });

    afterEach(() => {
      teardownEnv();
      rmSync(repoDir, { recursive: true, force: true });
    });

    it(
      "developer agent cannot read parent repo files; worktree operations succeed",
      async () => {
        const logger = new CapturingLogger();
        const canaryPath = join(repoDir, "secret.txt");

        const workflow = makeFeatureDevWorkflow({
          sandboxRequired: true, // fail if bwrap isn't available in this env
          canaryPath,
        });

        const engine = new WorkflowEngine(workflow, {
          cwd: repoDir,
          workflowDir: repoDir,
          logger,
        });

        const result = await engine.run();

        // The full pipeline must succeed (sandbox must not break normal coding)
        expect(result.success).toBe(true);
        expect(result.stepResults.get("developer")?.state).toBe("succeeded");
        expect(result.stepResults.get("test")?.state).toBe("succeeded");

        // The bwrap sandbox log line must be present
        expect(logger.lines.some((l) => l.includes("sandbox: bwrap"))).toBe(true);

        // The canary file in the parent working tree must be inaccessible inside
        // the sandbox — the developer agent should report "no" (read failed)
        const devOutputs = result.stepResults.get("developer")?.outputs ?? {};
        expect(devOutputs.canary_accessible).toBe("no");
      },
      180_000
    );
  }
);
