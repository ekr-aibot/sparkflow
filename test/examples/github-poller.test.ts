import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const POLLER = new URL("../../examples/scripts/github-poller.mjs", import.meta.url).pathname;

function makeGhScript(dir: string, script: string): string {
  const ghPath = join(dir, "gh");
  writeFileSync(ghPath, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return dir;
}

function runPoller(binDir: string, env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync("node", [POLLER], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env },
    encoding: "utf-8",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

describe("github-poller.mjs", () => {
  let tmpDir: string;

  function setup(ghScript: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), "sf-gh-poller-test-"));
    return makeGhScript(tmpDir, ghScript);
  }

  function teardown() {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  it("emits [] and exits 0 when gh issue list fails (network error)", () => {
    const binDir = setup('exit 1');
    try {
      const { stdout, status } = runPoller(binDir);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("emits [] and exits 0 when gh outputs invalid JSON", () => {
    const binDir = setup('echo "not-json"');
    try {
      const { stdout, status } = runPoller(binDir);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("emits filtered issues when polling succeeds", () => {
    const issues = JSON.stringify([
      { number: 1, title: "Bug fix", body: "Fix this", labels: [] },
      { number: 2, title: "Feature", body: "Add this", labels: [{ name: "in-progress" }] },
    ]);
    // First call (issue list) succeeds; subsequent calls (issue edit) succeed
    const binDir = setup(`
case "$1" in
  issue)
    case "$2" in
      list) echo '${issues}' ;;
      edit) exit 0 ;;
    esac ;;
esac
`);
    try {
      const { stdout, status } = runPoller(binDir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout);
      // Issue 2 is filtered out (in-progress), only issue 1 dispatched
      expect(out).toHaveLength(1);
      expect(out[0].issue_number).toBe(1);
    } finally {
      teardown();
    }
  });

  it("continues dispatching remaining issues when one label claim fails", () => {
    const issues = JSON.stringify([
      { number: 10, title: "First", body: "", labels: [] },
      { number: 20, title: "Second", body: "", labels: [] },
    ]);
    // issue edit fails for #10 but succeeds for #20
    const binDir = setup(`
case "$1" in
  issue)
    case "$2" in
      list) echo '${issues}' ;;
      edit)
        # $3 is the issue number (gh issue edit <number> ...)
        if [ "$3" = "10" ]; then exit 1; fi
        exit 0 ;;
    esac ;;
esac
`);
    try {
      const { stdout, stderr, status } = runPoller(binDir);
      expect(status).toBe(0);
      const out = JSON.parse(stdout);
      // Both issues should still appear in output (label claim failures don't drop them)
      expect(out).toHaveLength(2);
      expect(stderr).toContain("failed to claim #10");
    } finally {
      teardown();
    }
  });
});
