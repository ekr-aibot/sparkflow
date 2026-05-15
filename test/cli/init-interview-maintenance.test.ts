import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(),
  checkbox: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { select, checkbox, input, confirm } from "@inquirer/prompts";
import { execFileSync } from "node:child_process";
import { runInitInterview } from "../../src/cli/init-interview.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "sf-init-maint-"));
}

function writeUserWorkflow(home: string, name: string, kind = "main"): void {
  const dir = join(home, ".sparkflow", "flows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ kind }));
}

// Minimal git mock: one remote (origin), gh fails
function mockOneRemote(): void {
  vi.mocked(execFileSync).mockReturnValue(
    "origin\tgit@github.com:foo/bar.git (fetch)\norigin\tgit@github.com:foo/bar.git (push)\n",
  );
}

describe("runInitInterview — maintenance prompts", () => {
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
    mockOneRemote();
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("prompts for pm and architect when selectedDefault is 'auto-develop'", async () => {
    writeUserWorkflow(home, "auto-develop", "main");

    vi.mocked(select).mockResolvedValueOnce("auto-develop");
    vi.mocked(confirm)
      .mockResolvedValueOnce(true)  // pm
      .mockResolvedValueOnce(true)  // architect
      .mockResolvedValueOnce(true); // write config
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const config = await runInitInterview({ cwd, existing: null });
    expect(config.maintenance?.pm).toBe(true);
    expect(config.maintenance?.architect).toBe(true);
    // confirm was called 3 times: pm, architect, write
    expect(vi.mocked(confirm)).toHaveBeenCalledTimes(3);
  });

  it("does NOT prompt for maintenance when selectedDefault is not 'auto-develop'", async () => {
    writeUserWorkflow(home, "feature-development", "main");

    vi.mocked(select).mockResolvedValueOnce("feature-development");
    vi.mocked(confirm).mockResolvedValueOnce(true); // only write config
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const config = await runInitInterview({ cwd, existing: null });
    expect(config.maintenance).toBeUndefined();
    // confirm called only once: write config
    expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1);
  });

  it("omits maintenance from config when both pm and architect are false", async () => {
    writeUserWorkflow(home, "auto-develop", "main");

    vi.mocked(select).mockResolvedValueOnce("auto-develop");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // pm=false
      .mockResolvedValueOnce(false) // architect=false
      .mockResolvedValueOnce(true); // write
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const config = await runInitInterview({ cwd, existing: null });
    expect(config.maintenance).toBeUndefined();
  });

  it("seeds pm prompt default from existing maintenance.pm", async () => {
    writeUserWorkflow(home, "auto-develop", "main");

    const existing = {
      defaultWorkflow: "auto-develop",
      maintenance: { pm: false, architect: true },
    };

    vi.mocked(select).mockResolvedValueOnce("auto-develop");
    vi.mocked(confirm)
      .mockResolvedValueOnce(false) // pm
      .mockResolvedValueOnce(true)  // architect
      .mockResolvedValueOnce(true); // write
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    await runInitInterview({ cwd, existing });

    // First confirm call should have default=false (from existing.maintenance.pm)
    const pmCall = vi.mocked(confirm).mock.calls[0][0] as { default: boolean };
    expect(pmCall.default).toBe(false);

    // Second confirm call should have default=true (from existing.maintenance.architect)
    const archCall = vi.mocked(confirm).mock.calls[1][0] as { default: boolean };
    expect(archCall.default).toBe(true);
  });

  it("drops maintenance config when switching away from auto-develop", async () => {
    writeUserWorkflow(home, "feature-development", "main");
    writeUserWorkflow(home, "auto-develop", "main");

    // Existing config had auto-develop with maintenance enabled
    const existing = {
      defaultWorkflow: "auto-develop",
      maintenance: { pm: true, architect: true },
    };

    // User selects feature-development (not auto-develop)
    vi.mocked(select).mockResolvedValueOnce("feature-development");
    vi.mocked(confirm).mockResolvedValueOnce(true); // write
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const config = await runInitInterview({ cwd, existing });
    expect(config.maintenance).toBeUndefined();
    expect(config.defaultWorkflow).toBe("feature-development");
  });

  it("writes maintenance field with pm=true architect=false when only pm enabled", async () => {
    writeUserWorkflow(home, "auto-develop", "main");

    vi.mocked(select).mockResolvedValueOnce("auto-develop");
    vi.mocked(confirm)
      .mockResolvedValueOnce(true)  // pm=true
      .mockResolvedValueOnce(false) // architect=false
      .mockResolvedValueOnce(true); // write
    vi.mocked(checkbox).mockResolvedValueOnce([]);
    vi.mocked(input)
      .mockResolvedValueOnce("origin")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const config = await runInitInterview({ cwd, existing: null });
    expect(config.maintenance).toEqual({ pm: true, architect: false });
  });
});
