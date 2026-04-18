import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { homedir } from "node:os";

export interface GitConfig {
  /** Git remote name pr-creator pushes the branch to. Defaults to "origin". */
  push_remote?: string;
  /** GitHub repo (OWNER/NAME) that pr-creator opens the PR against and pr-watcher polls. Defaults to gh's auto-detection. */
  pr_repo?: string;
  /** Base branch for the PR. Defaults to the target repo's default branch. */
  base?: string;
}

export interface ProjectConfig {
  defaultWorkflow?: string;
  git?: GitConfig;
}

const PROJECT_CONFIG_PATH = ".sparkflow/config.json";
const PROJECT_WORKFLOWS_DIR = ".sparkflow/workflows";
const USER_CONFIG_FILE = "config.json";
const USER_WORKFLOWS_DIR = "workflows";

/**
 * User-level sparkflow home: `$XDG_CONFIG_HOME/sparkflow` or, fallback,
 * `~/.config/sparkflow`. Layout mirrors the project-level `.sparkflow/`:
 *
 *   <user-home>/config.json
 *   <user-home>/workflows/<name>.json
 *
 * Tests (and users who want a custom location) can override via XDG_CONFIG_HOME.
 */
export function userConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "sparkflow");
  return join(homedir(), ".config", "sparkflow");
}

function parseConfigObject(obj: Record<string, unknown>, label: string): ProjectConfig {
  const config: ProjectConfig = {};
  if (obj.defaultWorkflow !== undefined) {
    if (typeof obj.defaultWorkflow !== "string") {
      throw new Error(`${label}: "defaultWorkflow" must be a string`);
    }
    config.defaultWorkflow = obj.defaultWorkflow;
  }
  if (obj.git !== undefined) {
    if (typeof obj.git !== "object" || obj.git === null || Array.isArray(obj.git)) {
      throw new Error(`${label}: "git" must be an object`);
    }
    const gitObj = obj.git as Record<string, unknown>;
    const git: GitConfig = {};
    for (const key of ["push_remote", "pr_repo", "base"] as const) {
      const value = gitObj[key];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw new Error(`${label}: "git.${key}" must be a string`);
      }
      git[key] = value;
    }
    config.git = git;
  }
  return config;
}

function loadConfigFile(path: string, label: string): ProjectConfig {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read ${label}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${label}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parseConfigObject(parsed as Record<string, unknown>, label);
}

/**
 * Load user-level config merged with project-level config. Project fields win
 * on conflict; nested objects (`git`) are replaced whole rather than
 * deep-merged — simpler to reason about and easy to debug.
 */
export function loadProjectConfig(cwd: string): ProjectConfig {
  const userPath = join(userConfigDir(), USER_CONFIG_FILE);
  const projectPath = join(cwd, PROJECT_CONFIG_PATH);
  const user = loadConfigFile(userPath, userPath);
  const project = loadConfigFile(projectPath, PROJECT_CONFIG_PATH);
  return { ...user, ...project };
}

function listWorkflowsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

function looksLikePath(input: string): boolean {
  return (
    input.includes("/") ||
    input.includes("\\") ||
    input.endsWith(".json") ||
    isAbsolute(input)
  );
}

/**
 * Resolve a workflow name or path to an absolute file path.
 *
 * - Absolute or relative path: resolved against `cwd`.
 * - Bare name: first looked up in `<cwd>/.sparkflow/workflows/<name>.json`,
 *   then in the user-level `<user-config>/sparkflow/workflows/<name>.json`.
 *   Project wins; user is the fallback so common workflows don't need to be
 *   copied into every repo.
 */
export function resolveWorkflowPath(
  nameOrPath: string | undefined,
  cwd: string,
  config: ProjectConfig,
): string {
  const input = nameOrPath ?? config.defaultWorkflow;
  if (!input) {
    const available = [
      ...listWorkflowsIn(join(cwd, PROJECT_WORKFLOWS_DIR)),
      ...listWorkflowsIn(join(userConfigDir(), USER_WORKFLOWS_DIR)).map((n) => `${n} (user)`),
    ];
    const hint = available.length ? ` Available workflows: ${available.join(", ")}.` : "";
    throw new Error(
      `No workflow specified and no "defaultWorkflow" set in ${PROJECT_CONFIG_PATH} or ${USER_CONFIG_FILE}.${hint}`,
    );
  }

  if (looksLikePath(input)) {
    const resolved = resolve(cwd, input);
    if (!existsSync(resolved)) {
      throw new Error(`Workflow not found: ${resolved}.`);
    }
    return resolved;
  }

  const projectPath = join(cwd, PROJECT_WORKFLOWS_DIR, `${input}.json`);
  if (existsSync(projectPath)) return projectPath;

  const userPath = join(userConfigDir(), USER_WORKFLOWS_DIR, `${input}.json`);
  if (existsSync(userPath)) return userPath;

  const available = [
    ...listWorkflowsIn(join(cwd, PROJECT_WORKFLOWS_DIR)),
    ...listWorkflowsIn(join(userConfigDir(), USER_WORKFLOWS_DIR)).map((n) => `${n} (user)`),
  ];
  const hint = available.length ? ` Available: ${available.join(", ")}.` : "";
  throw new Error(
    `Workflow "${input}" not found in ${PROJECT_WORKFLOWS_DIR}/ or ${userConfigDir()}/${USER_WORKFLOWS_DIR}/.${hint}`,
  );
}
