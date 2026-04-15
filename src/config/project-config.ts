import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";

export interface ProjectConfig {
  defaultWorkflow?: string;
}

const CONFIG_PATH = ".sparkflow/config.json";
const WORKFLOWS_DIR = ".sparkflow/workflows";

export function loadProjectConfig(cwd: string): ProjectConfig {
  const path = join(cwd, CONFIG_PATH);
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read ${CONFIG_PATH}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const config: ProjectConfig = {};
  if (obj.defaultWorkflow !== undefined) {
    if (typeof obj.defaultWorkflow !== "string") {
      throw new Error(`${CONFIG_PATH}: "defaultWorkflow" must be a string`);
    }
    config.defaultWorkflow = obj.defaultWorkflow;
  }
  return config;
}

function listAvailableWorkflows(cwd: string): string[] {
  const dir = join(cwd, WORKFLOWS_DIR);
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

export function resolveWorkflowPath(
  nameOrPath: string | undefined,
  cwd: string,
  config: ProjectConfig,
): string {
  const input = nameOrPath ?? config.defaultWorkflow;
  if (!input) {
    const available = listAvailableWorkflows(cwd);
    const hint = available.length
      ? ` Available workflows in ${WORKFLOWS_DIR}/: ${available.join(", ")}`
      : "";
    throw new Error(
      `No workflow specified and no "defaultWorkflow" set in ${CONFIG_PATH}.${hint}`,
    );
  }

  let resolved: string;
  if (looksLikePath(input)) {
    resolved = resolve(cwd, input);
  } else {
    resolved = join(cwd, WORKFLOWS_DIR, `${input}.json`);
  }

  if (!existsSync(resolved)) {
    const available = listAvailableWorkflows(cwd);
    const hint = available.length
      ? ` Available workflows: ${available.join(", ")}.`
      : "";
    throw new Error(`Workflow not found: ${resolved}.${hint}`);
  }
  return resolved;
}
