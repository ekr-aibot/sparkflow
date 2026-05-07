import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { select, checkbox, input, confirm } from "@inquirer/prompts";
import {
  type ProjectConfig,
  type GitConfig,
  listWorkflowsIn,
  projectConfigExists,
  parseConfigObject,
  userConfigDir,
} from "../config/project-config.js";

const PROJECT_WORKFLOWS_DIR = ".sparkflow/workflows";
const USER_FLOWS_DIR = "flows";

type WorkflowMeta = { kind?: string; description?: string };

function readWorkflowMeta(dir: string, name: string): WorkflowMeta {
  try {
    const raw = readFileSync(join(dir, `${name}.json`), "utf-8");
    const data = JSON.parse(raw) as { kind?: unknown; description?: unknown };
    const result: WorkflowMeta = {};
    if (typeof data.kind === "string") result.kind = data.kind;
    if (typeof data.description === "string" && data.description) result.description = data.description;
    return result;
  } catch {
    return {};
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.8 ? cut.slice(0, lastSpace) : cut) + "…";
}

function listGitRemotes(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["remote", "-v"], { cwd, encoding: "utf-8", stdio: "pipe" });
    return [...new Set(out.split("\n").filter(Boolean).map((l) => l.split("\t")[0]))];
  } catch {
    return [];
  }
}

export async function detectGitDefaults(cwd: string): Promise<Partial<GitConfig>> {
  const result: Partial<GitConfig> = {};

  const remotes = listGitRemotes(cwd);
  if (remotes.includes("origin")) {
    result.push_remote = "origin";
  } else if (remotes.length > 0) {
    result.push_remote = remotes[0];
  }
  if (result.push_remote) {
    result.pull_remote = result.push_remote;
  }

  try {
    const out = execFileSync(
      "gh",
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      { cwd, encoding: "utf-8", stdio: "pipe" },
    );
    const data = JSON.parse(out) as {
      nameWithOwner?: string;
      defaultBranchRef?: { name?: string };
    };
    if (data.nameWithOwner) result.pr_repo = data.nameWithOwner;
    if (data.defaultBranchRef?.name) result.base = data.defaultBranchRef.name;
  } catch {
    // gh not available or not a GitHub repo — non-fatal
  }

  return result;
}

export function shouldAutoTrigger(cwd: string): boolean {
  if (!process.stdin.isTTY) return false;
  if (process.env.SPARKFLOW_SKIP_INIT === "1") return false;
  return !projectConfigExists(cwd);
}

export async function runInitInterview(opts: {
  cwd: string;
  existing: ProjectConfig | null;
}): Promise<ProjectConfig> {
  const { cwd, existing } = opts;

  const projectWorkflows = listWorkflowsIn(join(cwd, PROJECT_WORKFLOWS_DIR));
  const userWorkflows = listWorkflowsIn(join(userConfigDir(), USER_FLOWS_DIR));
  const projectSet = new Set(projectWorkflows);
  const dedupedUser = userWorkflows.filter((n) => !projectSet.has(n));

  if (projectWorkflows.length === 0 && userWorkflows.length === 0) {
    throw new Error(
      "No workflows found in ~/.sparkflow/flows/ or .sparkflow/workflows/. Populate one of these first.",
    );
  }

  const projectDir = join(cwd, PROJECT_WORKFLOWS_DIR);
  const userDir = join(userConfigDir(), USER_FLOWS_DIR);

  // Single pre-pass: read kind + description for each workflow (each file read once).
  const metaMap = new Map<string, WorkflowMeta>();
  for (const n of dedupedUser) metaMap.set(n, readWorkflowMeta(userDir, n));
  for (const n of projectWorkflows) metaMap.set(n, readWorkflowMeta(projectDir, n));

  function makeChoice(n: string) {
    const meta = metaMap.get(n) ?? {};
    const choice: { name: string; value: string; description?: string } = { name: n, value: n };
    if (meta.description) choice.description = truncate(meta.description, 200);
    return choice;
  }

  // kind:"main" only — eligible as project default.
  const mainChoices = [
    ...projectWorkflows.filter((n) => metaMap.get(n)?.kind === "main").map(makeChoice),
    ...dedupedUser.filter((n) => metaMap.get(n)?.kind === "main").map(makeChoice),
  ];

  // kind:"monitor" only — offered in the monitors checkbox.
  const monitorChoices = [
    ...projectWorkflows.filter((n) => metaMap.get(n)?.kind === "monitor").map(makeChoice),
    ...dedupedUser.filter((n) => metaMap.get(n)?.kind === "monitor").map(makeChoice),
  ];

  try {
    // 1. Default workflow (only kind:"main" workflows offered)
    const NONE = "__none__";
    const defaultChoices = [...mainChoices, { name: "(none)", value: NONE }];

    let defaultWorkflowSeed = NONE;
    if (existing?.defaultWorkflow) {
      const found = mainChoices.some((c) => c.value === existing.defaultWorkflow);
      if (found) defaultWorkflowSeed = existing.defaultWorkflow;
    }

    const selectedDefault = await select<string>({
      message: "Which workflow should be the default?",
      choices: defaultChoices,
      default: defaultWorkflowSeed,
    });

    // 2. Monitors (only kind:"monitor" workflows, minus the chosen default).
    //    Skip entirely when no eligible monitors exist.
    const eligibleMonitors = monitorChoices.filter((c) => c.value !== selectedDefault);
    let selectedMonitors: string[] = [];
    if (eligibleMonitors.length > 0) {
      const existingMonitors = (existing?.monitors ?? []).filter((m) =>
        eligibleMonitors.some((c) => c.value === m),
      );
      selectedMonitors = await checkbox<string>({
        message: "Which workflows should run as monitors on launch?",
        choices: eligibleMonitors.map((c) => ({
          ...c,
          checked: existingMonitors.includes(c.value),
        })),
      });
    }

    // 3. Git remotes — detect defaults and get list for choices
    const remotes = listGitRemotes(cwd);
    const gitDefaults = await detectGitDefaults(cwd);

    let pushRemote: string;
    if (remotes.length <= 1) {
      pushRemote = remotes[0] ?? "";
    } else {
      const defaultRemote =
        existing?.git?.push_remote ?? gitDefaults.push_remote ?? remotes[0];
      pushRemote = await select<string>({
        message: "Which git remote does sparkflow push branches to?",
        choices: remotes.map((r) => ({ name: r, value: r })),
        default: defaultRemote,
      });
    }

    // 4. Pull remote
    const pullRemote = await input({
      message: "Which git remote does sparkflow fetch the base branch from?",
      default: existing?.git?.pull_remote ?? pushRemote,
    });

    // 5. PR repo
    const prRepo = await input({
      message: "GitHub repo for PRs (OWNER/NAME, blank to let gh auto-detect at runtime)?",
      default: existing?.git?.pr_repo ?? gitDefaults.pr_repo ?? "",
    });

    // 6. Issues repo
    const issuesRepo = await input({
      message: "GitHub repo for issue polling (blank ⇒ same as PR repo)?",
      default: existing?.git?.issues_repo ?? "",
    });

    // 7. Base branch
    const baseBranch = await input({
      message: "Default base branch (blank ⇒ target repo's default)?",
      default: existing?.git?.base ?? gitDefaults.base ?? "",
    });

    // 8. Confirm write
    const configPath = resolve(cwd, ".sparkflow/config.json");
    const doWrite = await confirm({
      message: `Write ${configPath}?`,
      default: true,
    });

    if (!doWrite) {
      process.stderr.write("Aborted.\n");
      process.exit(0);
    }

    // Assemble config
    const config: ProjectConfig = {};
    if (selectedDefault !== NONE) config.defaultWorkflow = selectedDefault;
    if (selectedMonitors.length > 0) config.monitors = selectedMonitors;

    const git: GitConfig = {};
    if (pushRemote.trim()) git.push_remote = pushRemote.trim();
    if (pullRemote.trim()) git.pull_remote = pullRemote.trim();
    if (prRepo.trim()) git.pr_repo = prRepo.trim();
    if (issuesRepo.trim()) git.issues_repo = issuesRepo.trim();
    if (baseBranch.trim()) git.base = baseBranch.trim();
    if (Object.keys(git).length > 0) config.git = git;

    // Validate by round-tripping through the parser (catches interview bugs)
    parseConfigObject(config as Record<string, unknown>, "assembled config");

    return config;
  } catch (err) {
    if (err instanceof Error && err.name === "ExitPromptError") {
      process.stderr.write("\nAborted.\n");
      process.exit(130);
    }
    throw err;
  }
}
