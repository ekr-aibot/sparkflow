# Sparkflow Workflow Schema v1

## Schema Reference

### `SparkflowWorkflow` (top-level object)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `"1"` | yes | Schema version. Always `"1"` for now. Enables forward-compatible changes. |
| `name` | `string` | yes | Human-readable name for this workflow (e.g., `"feature-development"`). |
| `description` | `string` | no | Longer description of what this workflow does. |
| `entry` | `string` | yes | The step ID where execution begins. Must be a key in `steps`. |
| `defaults` | `StepDefaults` | no | Default settings inherited by all steps unless overridden per-step. |
| `steps` | `Record<string, Step>` | yes | The steps in the workflow, keyed by unique step ID. Must contain at least one step. Step IDs are alphanumeric + hyphens + underscores. |

### `StepDefaults`

Default values inherited by all steps. Any field set here can be overridden on an individual step.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_retries` | `integer` | `3` | Default max times a step can be re-entered via feedback loops before the workflow aborts. |
| `timeout` | `integer` | none | Default timeout in seconds for non-interactive steps. No timeout if omitted. |
| `runtime` | `Runtime` | none | Default runtime config. Steps without their own `runtime` inherit this. |
| `worktree` | `WorktreeConfig` | `{"mode":"shared"}` | Default worktree settings. |

### `Step`

A single node in the workflow graph.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Human-readable display name. |
| `description` | `string` | no | Longer description. Shown to agents and in logs. |
| `interactive` | `boolean` | yes | `true`: presents a TUI the user can interact with. `false`: runs autonomously. |
| `runtime` | `Runtime` | yes (or inherited) | How to execute this step. If omitted, inherited from `defaults.runtime`. |
| `prompt` | `string` | no | Instructions injected into the agent's context. Supports template interpolation. If the value starts with `./` or ends with `.md`, the engine reads it as a file path (relative to the workflow JSON file) and uses the file contents as the prompt text. For shell runtimes, the resolved prompt is passed via the `SPARKFLOW_PROMPT` environment variable. |
| `worktree` | `WorktreeConfig` | no | Git worktree configuration. Defaults to `defaults.worktree` or `{"mode":"shared"}`. |
| `join` | `string[]` | no | Step IDs this step waits for (fan-in). The step will not start until ALL listed steps have completed successfully. |
| `on_success` | `Transition[]` | no | Transitions on success. Multiple entries = fan-out (concurrent). If omitted, workflow completes when this step succeeds. |
| `on_failure` | `Transition[]` | no | Transitions on failure. Typically feedback loops. If omitted, workflow fails when this step fails. |
| `max_retries` | `integer` | no | Max re-entries via feedback loops before workflow aborts. Overrides `defaults.max_retries`. |
| `timeout` | `integer` | no | Timeout in seconds for non-interactive steps. Overrides `defaults.timeout`. |
| `outputs` | `Record<string, OutputDeclaration>` | no | Named outputs this step produces. Referenced via templates. |
| `env` | `Record<string, string>` | no | Extra environment variables. Values support template interpolation. |

### `Transition`

An edge in the workflow graph.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `step` | `string` | yes | Target step ID. Must be a key in `steps`. |
| `message` | `string` | no | Context passed to the target step. Supports template interpolation. |

### `Runtime`

A discriminated union on the `type` field.

#### `ClaudeCodeRuntime` (`type: "claude-code"`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"claude-code"` | yes | Discriminator. |
| `model` | `string` | no | Model to use (e.g., `"sonnet"`, `"opus"`). |
| `auto_accept` | `boolean` | no | Auto-accept all tool calls without user confirmation. |
| `args` | `string[]` | no | Additional CLI flags passed to the `claude` command. |
| `mcp_servers` | `string[]` | no | Names of MCP servers to enable for this session. |

#### `ShellRuntime` (`type: "shell"`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"shell"` | yes | Discriminator. |
| `command` | `string` | yes | The command to execute. |
| `args` | `string[]` | no | Arguments to the command. |
| `cwd` | `string` | no | Working directory override. |

#### `CustomRuntime` (`type: "custom"`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"custom"` | yes | Discriminator. |
| `adapter` | `string` | yes | Path to the adapter binary or Node module. |
| `config` | `Record<string, unknown>` | no | Arbitrary adapter-specific configuration. |

#### `GeminiRuntime` (`type: "gemini"`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"gemini"` | yes | Discriminator. |
| `command` | `string` | no | Binary to invoke. When omitted, sparkflow spawns `npx @google/gemini-cli@latest` so the runtime works on NixOS and any host without a global install. |
| `model` | `string` | no | Model id, e.g. `"gemini-2.5-pro"` or `"gemini-2.5-flash"`. |
| `args` | `string[]` | no | Additional CLI flags appended after sparkflow's own flags. |
| `mcp_servers` | `string[]` | no | Names of MCP servers to whitelist (maps to `--allowed-mcp-server-names`). |

Invocation: `<command> -p "" -y [-m <model>] -o text|stream-json [...args]`. The step prompt is piped on stdin (Gemini appends stdin to its `-p` value, so we pass an empty `-p` to trigger headless mode and stream the real prompt through stdin).

#### `CodexRuntime` (`type: "codex"`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"codex"` | yes | Discriminator. |
| `model` | `string` | no | Model to use (e.g. `"gpt-4o-codex"`, `"o4-mini"`). |
| `args` | `string[]` | no | Additional CLI flags passed to `codex exec`. |
| `mcp_servers` | `string[]` | no | Names of MCP servers to enable for this session. |

Invocation: `codex [exec|exec resume <id>] --json --dangerously-bypass-approvals-and-sandbox [-m <model>] [...args]`. The step prompt is piped on stdin.

**Differences from `claude-code`:**

- **Single-turn only.** Like `gemini`, `codex` is invoked once per turn; it reads the entire stdin until EOF before starting. Multi-turn nudges (including `success_output` self-nudges) are not supported in a single step execution.
- **Output extraction.** Sparkflow extracts text from `item.completed` events where `item.type` is `agent_message`. If the text contains JSON, it is parsed for named outputs.

**Differences from `claude-code`:**

- **No session resume.** Gemini's `--resume` uses per-project numeric indexes rather than UUIDs; sparkflow's retry machinery replays the full prompt + transition message instead. Costs extra tokens on retry but works.
- **MCP config lives on disk.** Gemini has no `--mcp-config <path>` flag — it reads `./.gemini/settings.json` and `~/.gemini/settings.json`. For interactive steps (`interactive: true` with a dashboard IPC socket), sparkflow writes `<cwd>/.gemini/settings.json` containing the sparkflow MCP server entry before spawn, backs up any pre-existing file, and restores it in `finally`. If sparkflow is `SIGKILL`'d mid-run, a `settings.json.sparkflow-backup` sibling is left behind so you can recover.
- **Output extraction.** If the model returns parseable JSON, sparkflow pulls named outputs from the object. Otherwise each declared `type: "text"` output receives the trimmed stdout. `_response` is always set to the raw stdout (or parsed object).

### `WorktreeConfig`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | `"shared" \| "fork" \| "isolated"` | yes | `"shared"`: main worktree. `"fork"`: new worktree, detached HEAD (transient). `"isolated"`: new worktree with a named branch, **persists for the lifetime of the workflow run** — re-entries of the same step resume the same worktree rather than creating a new one. |
| `branch` | `string` | no | Branch name for isolated worktrees. Defaults to `sparkflow/<stepId>-<runId>-<rand>`. |
| `fork_from` | `string` | no | Step ID whose isolated worktree HEAD is used as the base commit for this fork worktree. Only valid when `mode` is `"fork"`. On each invocation the engine re-resolves the HEAD so re-runs pick up new commits automatically. Throws a clear error if the referenced step has not run yet. |

**Isolated worktree persistence example** — `develop` runs in an isolated worktree that persists across retries, so commits from attempt N are visible on attempt N+1:

```json
{
  "develop": { "worktree": { "mode": "isolated" }, "on_failure": [{ "step": "develop" }] }
}
```

**`fork_from` example** — `test` forks from `develop`'s worktree so it sees exactly the commits that `develop` produced:

```json
{
  "develop": { "worktree": { "mode": "isolated" }, "on_success": [{ "step": "test" }] },
  "test":    { "worktree": { "mode": "fork", "fork_from": "develop" }, "on_failure": [{ "step": "develop" }] }
}
```

### `OutputDeclaration`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"text" \| "json" \| "file"` | yes | Output type. |
| `description` | `string` | no | Human-readable description of what this output contains. |

## Template Syntax

Templates allow steps to reference outputs from other steps or values from the project config. They are interpolated by the runtime before being passed to the agent or command.

### Syntax

**Step output references:**
```
${steps.<step_id>.output.<field>}
```

- `step_id` — key of a step in the `steps` map
- `field` — key declared in that step's `outputs` map

**Config references:**
```
${config.<dot.path>}
```

- `dot.path` — dot-separated path into the merged project config (`.sparkflow/config.json` → `~/.sparkflow/config.json`)
- Example: `${config.git.pull_remote}`, `${config.git.base}`
- Non-string values (arrays, objects) are JSON-serialized

**Foreach item references** (workflow runtime only):
```
${item}
${item.<field>}
```

### Where templates are allowed

1. **`prompt`** — instructions injected into an agent for a step
2. **`message`** — message attached to a transition
3. **`env`** — environment variable values on a step
4. **`runtime.command`** and **`runtime.args`** — shell runtime command and arguments (supports `${config.X}` and `${steps.X.output.Y}`)

Templates are **not** allowed in other fields.

### Resolution rules

- Resolved at **runtime**, just before a step executes
- Step output references can only reference steps that have **already completed**
- Reference to a step that has not run → **runtime error**
- Reference to an undeclared output field → **runtime error**
- Config references to a missing key → **runtime error** (shell adapter fails fast with a clear message)
- Nested templates are not supported

### Type-specific behavior

| Output type | Resolution |
|-------------|------------|
| `"text"` | Inserted as a plain string |
| `"json"` | Inserted as a JSON-formatted string |
| `"file"` | Inserted as the file path (not the file contents) |

### Escaping

To include a literal `${` without triggering interpolation, use `$${`:

```
$${steps.foo.output.bar}  →  ${steps.foo.output.bar}
$${config.git.base}       →  ${config.git.base}
```

## Concurrent Failure Semantics

When multiple steps fail simultaneously and all point back to the same step (e.g., both reviewer and test fail → author), the failures are **queued**. The target step is re-entered once per failure, processing them sequentially. Each re-entry carries its own transition `message`.
