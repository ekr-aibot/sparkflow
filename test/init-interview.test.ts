import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock @inquirer/prompts before any imports that use it.
vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(),
  checkbox: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
}));

// Mock child_process so git/gh calls don't hit the real system.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { select, checkbox, input, confirm } from "@inquirer/prompts";
import { execFileSync } from "node:child_process";
import {
  detectGitDefaults,
  shouldAutoTrigger,
  runInitInterview,
} from "../src/cli/init-interview.js";
import { writeProjectConfig, projectConfigExists } from "../src/config/project-config.js";

// Helpers
function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "sf-init-test-"));
}

function writeUserWorkflow(home: string, name: string, kind = "main"): void {
  const dir = join(home, ".sparkflow", "flows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ kind }));
}

function writeProjectWorkflow(cwd: string, name: string, kind = "main"): void {
  const dir = join(cwd, ".sparkflow", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ kind }));
}

// ---- detectGitDefaults -------------------------------------------------------

describe("detectGitDefaults", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp();
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("picks origin as push_remote when origin is present", async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(
        "origin\tgit@github.com:foo/bar.git (fetch)\norigin\tgit@github.com:foo/bar.git (push)\n",
      )
      .mockReturnValueOnce(
        JSON.stringify({ nameWithOwner: "foo/bar", defaultBranchRef: { name: "main" } }),
      );

    const result = await detectGitDefaults(cwd);
    expect(result.push_remote).toBe("origin");
    expect(result.pull_remote).toBe("origin");
    expect(result.pr_repo).toBe("foo/bar");
    expect(result.base).toBe("main");
  });

  it("picks first remote when origin is absent", async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(
        "upstream\tgit@github.com:foo/bar.git (fetch)\nupstream\tgit@github.com:foo/bar.git (push)\n",
      )
      .mockReturnValueOnce(
        JSON.stringify({ nameWithOwner: "foo/bar", defaultBranchRef: { name: "main" } }),
      );

    const result = await detectGitDefaults(cwd);
    expect(result.push_remote).toBe("upstream");
  });

  it("returns empty object when no git remotes", async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce("")  // git remote -v returns empty
      .mockReturnValueOnce(
        JSON.stringify({ nameWithOwner: "foo/bar", defaultBranchRef: { name: "main" } }),
      );

    const result = await detectGitDefaults(cwd);
    expect(result.push_remote).toBeUndefined();
    expect(result.pull_remote).toBeUndefined();
  });

  it("handles gh failure gracefully (no pr_repo or base)", async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(
        "origin\tgit@github.com:foo/bar.git (fetch)\norigin\tgit@github.com:foo/bar.git (push)\n",
      )
      .mockImplementationOnce(() => { throw new Error("gh not found"); });

    const result = await detectGitDefaults(cwd);
    expect(result.push_remote).toBe("origin");
    expect(result.pr_repo).toBeUndefined();
    expect(result.base).toBeUndefined();
  });

  it("handles git remote failure gracefully", async () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error("not a git repo"); })
      .mockImplementationOnce(() => { throw new Error("gh not found"); });

    const result = await detectGitDefaults(cwd);
    expect(result).toEqual({});
  });
});

// ---- shouldAutoTrigger -------------------------------------------------------

describe("shouldAutoTrigger", () => {
  let cwd: string;
  let origIsTTY: boolean | undefined;
  let origSkipInit: string | undefined;

  beforeEach(() => {
    cwd = makeTmp();
    origIsTTY = process.stdin.isTTY;
    origSkipInit = process.env.SPARKFLOW_SKIP_INIT;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    if (origSkipInit === undefined) delete process.env.SPARKFLOW_SKIP_INIT;
    else process.env.SPARKFLOW_SKIP_INIT = origSkipInit;
    rmSync(cwd, { recursive: true, force: true });
  });

  function setTTY(val: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { value: val, configurable: true });
  }

  it("returns false when not a TTY", () => {
    setTTY(false);
    delete process.env.SPARKFLOW_SKIP_INIT;
    expect(shouldAutoTrigger(cwd)).toBe(false);
  });

  it("returns false when SPARKFLOW_SKIP_INIT=1", () => {
    setTTY(true);
    process.env.SPARKFLOW_SKIP_INIT = "1";
    expect(shouldAutoTrigger(cwd)).toBe(false);
  });

  it("returns false when config file already exists", () => {
    setTTY(true);
    delete process.env.SPARKFLOW_SKIP_INIT;
    mkdirSync(join(cwd, ".sparkflow"), { recursive: true });
    writeFileSync(join(cwd, ".sparkflow", "config.json"), "{}");
    expect(shouldAutoTrigger(cwd)).toBe(false);
  });

  it("returns true when TTY, no env skip, and no config", () => {
    setTTY(true);
    delete process.env.SPARKFLOW_SKIP_INIT;
    expect(shouldAutoTrigger(cwd)).toBe(true);
  });
});

// ---- writeProjectConfig / projectConfigExists --------------------------------

describe("writeProjectConfig", () => {
  let cwd: string;

  beforeEach(() => { cwd = makeTmp(); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it("writes pretty JSON and returns absolute path", () => {
    const config = { defaultWorkflow: "my-flow", git: { push_remote: "origin" } };
    const path = writeProjectConfig(cwd, config);
    expect(path).toContain(".sparkflow/config.json");
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed).toEqual(config);
  });

  it("creates .sparkflow/ directory if missing", () => {
    writeProjectConfig(cwd, { defaultWorkflow: "x" });
    expect(projectConfigExists(cwd)).toBe(true);
  });

  it("round-trip: written config can be read back identically", () => {
    const config = {
      defaultWorkflow: "wf",
      monitors: ["monitor-a"],
      git: { push_remote: "origin", pr_repo: "owner/repo", base: "main" },
    };
    const path = writeProjectConfig(cwd, config);
    const roundTripped = JSON.parse(readFileSync(path, "utf-8"));
    expect(roundTripped).toEqual(config);
  });
});

// ---- runInitInterview --------------------------------------------------------

describe("runInitInterview", () => {
  let cwd: string;
  let home: string;
  let origHome: string | undefined;

  beforeEach(() => {
    cwd = makeTmp();
    home = makeTmp();
    origHome = process.env.HOME;
    process.env.HOME = home;
    vi.mocked(execFileSync).mockReset();
    vi.mocked(select).mockReset();
    vi.mocked(checkbox).mockReset();
    vi.mocked(input).mockReset();
    vi.mocked(confirm).mockReset();
    // Default: git has origin, gh fails
    vi.mocked(execFileSync).mockReturnValue(
      "origin\tgit@github.com:foo/bar.git (fetch)\norigin\tgit@github.com:foo/bar.git (push)\n",
    );
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("throws when no workflows are available", async () => {
    await expect(runInitInterview({ cwd, existing: null })).rejects.toThrow(
      /No workflows found/,
    );
  });

  it("produces correct ProjectConfig from canned answers", async () => {
    writeUserWorkflow(home, "feature-development");
    writeUserWorkflow(home, "monitor-a");

    // one remote → skip push_remote select
    vi.mocked(select).mockResolvedValueOnce("feature-development");
    vi.mocked(checkbox).mockResolvedValueOnce(["monitor-a"]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")    // pull_remote
      .mockResolvedValueOnce("owner/repo") // pr_repo
      .mockResolvedValueOnce("")           // issues_repo
      .mockResolvedValueOnce("main");      // base
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const config = await runInitInterview({ cwd, existing: null });
    expect(config.defaultWorkflow).toBe("feature-development");
    expect(config.monitors).toEqual(["monitor-a"]);
    expect(config.git?.push_remote).toBe("origin");
    expect(config.git?.pull_remote).toBe("origin");
    expect(config.git?.pr_repo).toBe("owner/repo");
    expect(config.git?.issues_repo).toBeUndefined(); // blank → omitted
    expect(config.git?.base).toBe("main");
  });

  it("omits git block when all git answers are blank", async () => {
    writeUserWorkflow(home, "wf");
    vi.mocked(execFileSync).mockReturnValue(""); // no remotes

    vi.mocked(select).mockResolvedValueOnce("wf");
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("") // pull_remote
      .mockResolvedValueOnce("") // pr_repo
      .mockResolvedValueOnce("") // issues_repo
      .mockResolvedValueOnce(""); // base
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const config = await runInitInterview({ cwd, existing: null });
    expect(config.git).toBeUndefined();
  });

  it("seeds prompts with existing config values", async () => {
    writeUserWorkflow(home, "feature-development");
    writeUserWorkflow(home, "monitor-a");

    const existing = {
      defaultWorkflow: "feature-development",
      monitors: ["monitor-a"],
      git: { push_remote: "origin", pull_remote: "upstream", pr_repo: "foo/bar", base: "dev" },
    };

    vi.mocked(select).mockResolvedValueOnce("feature-development");
    vi.mocked(checkbox).mockResolvedValueOnce(["monitor-a"]);
    vi.mocked(input)
      .mockResolvedValueOnce("upstream")
      .mockResolvedValueOnce("foo/bar")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("dev");
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runInitInterview({ cwd, existing });

    // Verify that `input` was called with the existing pull_remote as default
    const inputCalls = vi.mocked(input).mock.calls;
    expect(inputCalls[0][0]).toMatchObject({ default: "upstream" });
  });

  it("presents two remotes as a select", async () => {
    writeUserWorkflow(home, "wf");
    // Two remotes: origin + upstream
    vi.mocked(execFileSync).mockReturnValue(
      "origin\tgit@github.com:foo/bar.git (fetch)\norigin\tgit@github.com:foo/bar.git (push)\n" +
      "upstream\thttps://github.com/baz/qux.git (fetch)\nupstream\thttps://github.com/baz/qux.git (push)\n",
    );

    vi.mocked(select)
      .mockResolvedValueOnce("wf")       // defaultWorkflow
      .mockResolvedValueOnce("origin");   // push_remote
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const config = await runInitInterview({ cwd, existing: null });
    expect(config.git?.push_remote).toBe("origin");
    // select was called twice: once for defaultWorkflow, once for push_remote
    expect(vi.mocked(select)).toHaveBeenCalledTimes(2);
  });

  it("omits defaultWorkflow when (none) is chosen", async () => {
    writeUserWorkflow(home, "wf");
    vi.mocked(select).mockResolvedValueOnce("__none__");
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const config = await runInitInterview({ cwd, existing: null });
    expect(config.defaultWorkflow).toBeUndefined();
  });

  it("deduplicates workflows: project shadows user", async () => {
    writeUserWorkflow(home, "shared");
    writeProjectWorkflow(cwd, "shared");
    writeUserWorkflow(home, "user-only");

    vi.mocked(select).mockResolvedValueOnce("shared");
    vi.mocked(checkbox).mockResolvedValueOnce(["user-only"]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runInitInterview({ cwd, existing: null });

    // Default workflow select: "shared (project)" present, "shared (user)" absent (deduped)
    const selectCall = vi.mocked(select).mock.calls[0][0] as unknown as { choices: Array<{ name: string; value: string }> };
    const names = selectCall.choices.map((c) => c.name);
    expect(names).toContain("shared (project)");
    expect(names).not.toContain("shared (user)");
    expect(names).toContain("user-only (user)");
  });

  it("only kind:main workflows appear in the default select; monitor workflows do not", async () => {
    writeUserWorkflow(home, "feature-dev", "main");
    writeUserWorkflow(home, "github-poller", "monitor");

    vi.mocked(select).mockResolvedValueOnce("feature-dev");
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runInitInterview({ cwd, existing: null });

    const selectCall = vi.mocked(select).mock.calls[0][0] as unknown as { choices: Array<{ name: string; value: string }> };
    const defaultChoiceNames = selectCall.choices.map((c) => c.name);
    expect(defaultChoiceNames).toContain("feature-dev (user)");
    expect(defaultChoiceNames).not.toContain("github-poller (user)");

    // But github-poller should still appear in the monitors checkbox
    const checkboxCall = vi.mocked(checkbox).mock.calls[0][0] as unknown as { choices: Array<{ name: string; value: string }> };
    const monitorChoiceNames = checkboxCall.choices.map((c) => c.name);
    expect(monitorChoiceNames).toContain("github-poller (user)");
  });

  it("existing defaultWorkflow that no longer resolves falls back to NONE seed", async () => {
    writeUserWorkflow(home, "wf");

    const existing = { defaultWorkflow: "deleted-workflow" };
    vi.mocked(select).mockResolvedValueOnce("wf");
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runInitInterview({ cwd, existing });

    // The select prompt for defaultWorkflow should have default "__none__" since
    // "deleted-workflow" doesn't exist in any workflow dir.
    const selectCall = vi.mocked(select).mock.calls[0][0] as { default: string };
    expect(selectCall.default).toBe("__none__");
  });
});
