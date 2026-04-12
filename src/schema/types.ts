// ── Output Declaration ──────────────────────────────────────────────

export interface OutputDeclaration {
  /** Output type: text (string), json (structured), or file (path). */
  type: "text" | "json" | "file";
  /** Human-readable description of what this output contains. */
  description?: string;
}

// ── Worktree ────────────────────────────────────────────────────────

export interface WorktreeConfig {
  /**
   * "shared"   — runs in the main worktree (or run-level worktree).
   * "fork"     — new worktree directory, detached HEAD at current commit.
   * "isolated" — new worktree directory with a new named branch.
   */
  mode: "shared" | "fork" | "isolated";
  /** Branch name for isolated worktrees. Ignored for shared/fork modes. */
  branch?: string;
}

// ── Sandbox ─────────────────────────────────────────────────────────

export interface SandboxMount {
  /** Host path to mount. */
  host: string;
  /** Path inside the sandbox. */
  container: string;
  /** Mount mode. Defaults to "rw". */
  mode?: "ro" | "rw";
}

export interface LocalSandboxConfig {
  type: "local";
}

export interface DockerSandboxConfig {
  type: "docker";
  /** Docker image to run. Must provide node, git, gh, and the workflow's toolchain. */
  image: string;
  /** Extra bind mounts beyond the worktree and IPC socket. */
  mounts?: SandboxMount[];
  /** Host env vars to forward into the container (e.g. GITHUB_TOKEN). */
  env_passthrough?: string[];
  /** `docker run --user` value. */
  user?: string;
  /** `docker run --network` value. */
  network?: string;
}

export type SandboxConfig = LocalSandboxConfig | DockerSandboxConfig;

/** Policy for restricting Claude Code's built-in tools when running in a sandbox. */
export type SandboxToolPolicy =
  /** Block built-in Bash only; keep Read/Edit/Write/Glob/Grep native. */
  | "bash_only"
  /** Block all built-in tools; agent must use MCP tools exclusively. */
  | "strict"
  /** No restriction. Built-in tools remain available. */
  | "off";

// ── Runtimes (discriminated union on `type`) ────────────────────────

export interface ClaudeCodeRuntime {
  type: "claude-code";
  /** Model to use (e.g. "sonnet", "opus"). */
  model?: string;
  /** If true, auto-accept all tool calls without user confirmation. */
  auto_accept?: boolean;
  /** Additional CLI flags passed to the `claude` command. */
  args?: string[];
  /** Names of MCP servers to enable for this session. */
  mcp_servers?: string[];
  /**
   * How aggressively to restrict Claude Code's built-in tools when the step
   * runs in a non-local sandbox. Defaults to "bash_only" (block built-in Bash,
   * keep Read/Edit/Write/Glob/Grep native). Ignored for local sandboxes.
   */
  sandbox_tool_policy?: SandboxToolPolicy;
}

export interface ShellRuntime {
  type: "shell";
  /** The command to execute. */
  command: string;
  /** Arguments to the command. */
  args?: string[];
  /** Working directory override. Defaults to the worktree root. */
  cwd?: string;
}

export interface CustomRuntime {
  type: "custom";
  /** Path to the adapter binary or Node module. */
  adapter: string;
  /** Arbitrary adapter-specific configuration. */
  config?: Record<string, unknown>;
}

export interface PrWatcherRuntime {
  type: "pr-watcher";
  /** Seconds between polling checks. Defaults to 30. */
  poll_interval?: number;
}

export interface PrCreatorRuntime {
  type: "pr-creator";
  /** Model for title/summary generation. Defaults to "sonnet". */
  model?: string;
}

export type Runtime = ClaudeCodeRuntime | ShellRuntime | CustomRuntime | PrWatcherRuntime | PrCreatorRuntime;

// ── Transition ──────────────────────────────────────────────────────

export interface Transition {
  /** Target step ID. Must be a key in the `steps` map. */
  step: string;
  /** Context passed to the target step. Supports template interpolation. */
  message?: string;
}

// ── Step ────────────────────────────────────────────────────────────

export interface Step {
  /** Human-readable display name. */
  name: string;
  /** Longer description. Shown to agents and in logs. */
  description?: string;
  /**
   * true — presents a TUI the user can interact with.
   * false — runs autonomously to completion.
   */
  interactive: boolean;
  /** How to execute this step. If omitted, inherited from defaults.runtime. */
  runtime?: Runtime;
  /** Instructions injected into the agent's context. Supports templates. */
  prompt?: string;
  /** Git worktree configuration. */
  worktree?: WorktreeConfig;
  /** Step IDs this step waits for (fan-in). */
  join?: string[];
  /** Transitions on success. Multiple = fan-out. */
  on_success?: Transition[];
  /** Transitions on failure. Typically feedback loops. */
  on_failure?: Transition[];
  /** Max re-entries via feedback loops before workflow aborts. */
  max_retries?: number;
  /** Timeout in seconds for non-interactive steps. */
  timeout?: number;
  /** Named outputs this step produces. */
  outputs?: Record<string, OutputDeclaration>;
  /** Extra environment variables. Values support templates. */
  env?: Record<string, string>;
  /** Sandbox to run this step in. If omitted, inherited from defaults.sandbox (or local). */
  sandbox?: SandboxConfig;
}

// ── Step Defaults ───────────────────────────────────────────────────

export interface StepDefaults {
  /** Default max retries for feedback loops. */
  max_retries?: number;
  /** Default timeout in seconds. */
  timeout?: number;
  /** Default runtime config. */
  runtime?: Runtime;
  /** Default worktree settings. */
  worktree?: WorktreeConfig;
  /** Default sandbox settings. */
  sandbox?: SandboxConfig;
}

// ── Workflow (top-level) ────────────────────────────────────────────

export interface SparkflowWorkflow {
  /** Schema version. Always "1" for now. */
  version: "1";
  /** Human-readable name for this workflow. */
  name: string;
  /** Longer description of what this workflow does. */
  description?: string;
  /** The step ID where execution begins. Must be a key in `steps`. */
  entry: string;
  /** Default settings inherited by all steps. */
  defaults?: StepDefaults;
  /** Steps in the workflow, keyed by unique step ID. */
  steps: Record<string, Step>;
}
