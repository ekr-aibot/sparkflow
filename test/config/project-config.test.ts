import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, resolveWorkflowPath, userConfigDir } from "../../src/config/project-config.js";

// Each test gets its own temp HOME and project cwd so layers can't bleed across cases.
describe("loadProjectConfig / resolveWorkflowPath — user + project layering", () => {
  let userHome: string;
  let projectCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    userHome = mkdtempSync(join(tmpdir(), "sparkflow-userhome-"));
    projectCwd = mkdtempSync(join(tmpdir(), "sparkflow-project-"));
    originalHome = process.env.HOME;
    process.env.HOME = userHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(userHome, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  function writeUserConfig(obj: Record<string, unknown>): void {
    const dir = join(userHome, ".sparkflow");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
  }
  function writeProjectConfig(obj: Record<string, unknown>): void {
    const dir = join(projectCwd, ".sparkflow");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
  }
  function writeUserWorkflow(name: string, body: string = "{}"): void {
    const dir = join(userHome, ".sparkflow", "flows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), body);
  }
  function writeProjectWorkflow(name: string, body: string = "{}"): void {
    const dir = join(projectCwd, ".sparkflow", "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), body);
  }

  it("userConfigDir returns ~/.sparkflow", () => {
    expect(userConfigDir()).toBe(join(userHome, ".sparkflow"));
  });

  it("loads user-only config when no project file exists", () => {
    writeUserConfig({ defaultWorkflow: "std", git: { pr_repo: "me/app" } });
    const cfg = loadProjectConfig(projectCwd);
    expect(cfg.defaultWorkflow).toBe("std");
    expect(cfg.git?.pr_repo).toBe("me/app");
  });

  it("project config overrides user config field-by-field (shallow)", () => {
    writeUserConfig({ defaultWorkflow: "std", git: { pr_repo: "me/app", push_remote: "fork" } });
    writeProjectConfig({ defaultWorkflow: "custom" });
    const cfg = loadProjectConfig(projectCwd);
    // defaultWorkflow overridden at project level.
    expect(cfg.defaultWorkflow).toBe("custom");
    // `git` not present at project level, so user's whole `git` is preserved.
    expect(cfg.git?.pr_repo).toBe("me/app");
    expect(cfg.git?.push_remote).toBe("fork");
  });

  it("project's git object fully replaces user's (nested objects are not deep-merged)", () => {
    writeUserConfig({ git: { pr_repo: "me/app", push_remote: "fork" } });
    writeProjectConfig({ git: { base: "develop" } });
    const cfg = loadProjectConfig(projectCwd);
    // User fields are gone — shallow merge replaces the whole `git` object.
    expect(cfg.git?.pr_repo).toBeUndefined();
    expect(cfg.git?.push_remote).toBeUndefined();
    expect(cfg.git?.base).toBe("develop");
  });

  it("returns empty config when neither file exists", () => {
    expect(loadProjectConfig(projectCwd)).toEqual({});
  });

  it("resolves a bare workflow name from the project first", () => {
    writeUserWorkflow("feature");
    writeProjectWorkflow("feature");
    const resolved = resolveWorkflowPath("feature", projectCwd, {});
    expect(resolved).toBe(join(projectCwd, ".sparkflow", "workflows", "feature.json"));
  });

  it("falls back to user workflows when the bare name isn't in the project", () => {
    writeUserWorkflow("standard");
    const resolved = resolveWorkflowPath("standard", projectCwd, {});
    expect(resolved).toBe(join(userHome, ".sparkflow", "flows", "standard.json"));
  });

  it("error lists workflows from both project and user directories", () => {
    writeProjectWorkflow("proj-only");
    writeUserWorkflow("user-only");
    expect(() => resolveWorkflowPath("nope", projectCwd, {})).toThrow(/proj-only.+user-only \(user\)/s);
  });

  it("absolute / relative paths bypass the bare-name lookup", () => {
    writeProjectWorkflow("feature");
    const abs = join(projectCwd, ".sparkflow", "workflows", "feature.json");
    expect(resolveWorkflowPath(abs, projectCwd, {})).toBe(abs);
  });

  it("uses config.defaultWorkflow when no explicit name passed", () => {
    writeUserWorkflow("user-default");
    const resolved = resolveWorkflowPath(undefined, projectCwd, { defaultWorkflow: "user-default" });
    expect(resolved).toBe(join(userHome, ".sparkflow", "flows", "user-default.json"));
  });

  it("loads monitors array from config", () => {
    writeProjectConfig({ monitors: ["github-poller", "fixer"] });
    const cfg = loadProjectConfig(projectCwd);
    expect(cfg.monitors).toEqual(["github-poller", "fixer"]);
  });

  it("monitors from user config are preserved when project has none", () => {
    writeUserConfig({ monitors: ["github-poller"] });
    const cfg = loadProjectConfig(projectCwd);
    expect(cfg.monitors).toEqual(["github-poller"]);
  });

  it("project monitors replace user monitors (shallow merge)", () => {
    writeUserConfig({ monitors: ["user-monitor"] });
    writeProjectConfig({ monitors: ["project-monitor"] });
    const cfg = loadProjectConfig(projectCwd);
    expect(cfg.monitors).toEqual(["project-monitor"]);
  });

  it("throws when monitors is not an array", () => {
    writeProjectConfig({ monitors: "github-poller" });
    expect(() => loadProjectConfig(projectCwd)).toThrow(/"monitors" must be an array of strings/);
  });

  it("throws when monitors contains non-string items", () => {
    writeProjectConfig({ monitors: [42] });
    expect(() => loadProjectConfig(projectCwd)).toThrow(/"monitors" must be an array of strings/);
  });
});
