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
  /**
   * When true, a failure with no effective on_failure transition (or after
   * retries are exhausted) pauses the workflow and asks the outer console how
   * to proceed instead of aborting. Requires status-json mode (i.e. running
   * under the dashboard). Defaults to the workflow's `defaults.ask_on_failure`,
   * and ultimately to false.
   */
  ask_on_failure?: boolean;
  /** Timeout in seconds for non-interactive steps. */
  timeout?: number;
  /** Named outputs this step produces. */
  outputs?: Record<string, OutputDeclaration>;
  /** Extra environment variables. Values support templates. */
  env?: Record<string, string>;
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
  /** Default ask_on_failure for steps that don't set it. */
  ask_on_failure?: boolean;
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
