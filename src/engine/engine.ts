import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { SparkflowWorkflow, Step, Runtime } from "../schema/types.js";
import type { ProjectConfig } from "../config/project-config.js";
import type { RuntimeAdapter } from "../runtime/types.js";
import type { RuntimeContext } from "../runtime/types.js";
import { ShellAdapter } from "../runtime/shell.js";
import { ClaudeCodeAdapter } from "../runtime/claude-code.js";
import { CustomAdapter } from "../runtime/custom.js";
import { PrWatcherAdapter } from "../runtime/pr-watcher.js";
import { PrCreatorAdapter } from "../runtime/pr-creator.js";
import { WorkflowAdapter } from "../runtime/workflow.js";
import { GeminiAdapter } from "../runtime/gemini.js";
import { resolveTemplate, resolvePrompt } from "./template.js";
import { WorktreeManager } from "./worktree.js";
import { IpcServer, type IpcMessage } from "../mcp/ipc.js";
import type { StepStatus, EngineOptions, RunResult, Logger } from "./types.js";
import { ConsoleLogger } from "./types.js";

const DEFAULT_MAX_RETRIES = 3;

/**
 * Serializes user interactions across concurrent interactive steps.
 * One prompt at a time on the terminal, FIFO order.
 */
export class UserInteractionManager {
  private queue: Array<{
    stepId: string;
    question: string;
    resolve: (answer: string) => void;
  }> = [];
  private processing = false;
  private logger: Logger;
  private rl: ReadlineInterface | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async ask(stepId: string, question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.queue.push({ stepId, question, resolve });
      this.processQueue();
    });
  }

  sendMessage(stepId: string, message: string): void {
    this.logger.info(`[${stepId}] ${message}`);
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;

      if (!this.rl) {
        this.rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
      }

      const answer = await new Promise<string>((resolve) => {
        this.rl!.question(`[${item.stepId}] ${item.question}\n> `, resolve);
      });

      item.resolve(answer);
    }

    this.processing = false;
  }

  close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

export class WorkflowEngine {
  private workflow: SparkflowWorkflow;
  private config?: ProjectConfig;
  private adapters: Map<string, RuntimeAdapter>;
  private logger: Logger;
  private cwd: string;
  private workflowDir: string;
  private dryRun: boolean;
  private plan?: string;
  private verbose: boolean;
  private statusJson: boolean;
  private readonly runId: string = randomBytes(4).toString("hex");
  private worktreeManager: WorktreeManager;
  private interactionManager: UserInteractionManager;
  private pendingAnswers = new Map<string, (answer: string) => void>();

  private stepStatuses = new Map<string, StepStatus>();
  private stepOutputs = new Map<string, Record<string, unknown>>();
  private activePromises = new Map<string, Promise<void>>();
  private ipcServers = new Map<string, IpcServer>();
  private aborted = false;
  private abortError?: string;
  /** When the workflow default is "isolated", all steps share this single worktree. */
  private runWorktree?: string;

  constructor(
    workflow: SparkflowWorkflow,
    options: EngineOptions = {},
    adapters?: Map<string, RuntimeAdapter>
  ) {
    this.workflow = workflow;
    this.config = options.config;
    this.logger = options.logger ?? new ConsoleLogger();
    this.cwd = options.cwd ?? process.cwd();
    this.workflowDir = options.workflowDir ?? this.cwd;
    this.dryRun = options.dryRun ?? false;
    this.plan = options.plan;
    this.verbose = options.verbose ?? false;
    this.statusJson = options.statusJson ?? false;
    this.worktreeManager = new WorktreeManager(this.cwd, this.runId);
    this.interactionManager = new UserInteractionManager(this.logger);

    this.adapters = adapters ?? new Map<string, RuntimeAdapter>([
      ["shell", new ShellAdapter()],
      ["claude-code", new ClaudeCodeAdapter()],
      ["custom", new CustomAdapter()],
      ["pr-watcher", new PrWatcherAdapter()],
      ["pr-creator", new PrCreatorAdapter()],
      ["workflow", new WorkflowAdapter()],
      ["gemini", new GeminiAdapter()],
    ]);

    // Initialize step statuses
    for (const id of Object.keys(workflow.steps)) {
      this.stepStatuses.set(id, {
        state: "pending",
        retryCount: 0,
        inPlaceAttempt: 0,
        tokenLimitResumes: 0,
        outputs: {},
        completedJoins: new Set(),
        pendingMessages: [],
      });
    }
  }

  async run(): Promise<RunResult> {
    this.logger.info(`[sparkflow] runId=${this.runId}`);
    this.logger.info(`[sparkflow] Starting workflow "${this.workflow.name}"`);

    // If workflow default worktree is "fork" or "isolated", create a single
    // worktree for the entire run. All steps share this directory.
    //   fork     → new directory, detached HEAD (no new branch)
    //   isolated → new directory, new named branch (for PRs)
    const defaultMode = this.workflow.defaults?.worktree?.mode;
    if ((defaultMode === "fork" || defaultMode === "isolated") && !this.dryRun) {
      try {
        const dummyStep: Step = {
          name: "_run",
          interactive: false,
          worktree: this.workflow.defaults!.worktree,
        };
        this.runWorktree = this.worktreeManager.resolve("_run", dummyStep, {
          ...this.workflow,
          defaults: { ...this.workflow.defaults, worktree: { mode: "shared" } },
        });
        this.logger.info(`[sparkflow] Using ${defaultMode} worktree: ${this.runWorktree}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[sparkflow] Failed to create run worktree: ${errMsg}`);
        return { success: false, stepResults: this.stepStatuses, error: errMsg };
      }
    }

    this.triggerStep(this.workflow.entry);

    // Drain active promises until nothing is running
    while (this.activePromises.size > 0 && !this.aborted) {
      await Promise.race(this.activePromises.values());
    }

    const success = !this.aborted && this.allTerminalStepsSucceeded();

    if (this.aborted) {
      this.logger.error(`[sparkflow] Workflow aborted: ${this.abortError}`);
    } else if (success) {
      this.logger.info(`[sparkflow] Workflow "${this.workflow.name}" completed successfully`);
    } else {
      this.logger.error(`[sparkflow] Workflow "${this.workflow.name}" failed`);
    }

    // Print the current branch (use run worktree if active)
    const reportCwd = this.runWorktree ?? this.cwd;
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: reportCwd,
        stdio: "pipe",
      }).toString().trim();
      this.logger.info(`[sparkflow] Results are on branch: ${branch}`);
    } catch {
      // Not a git repo or git not available
    }

    // Cleanup run-level worktree (keep it around — it has the results)
    // Don't clean up: the user or pr-creator needs the branch.

    // Best-effort cleanup of per-run worktree dir (fork/step worktrees only;
    // the run-level isolated worktree is intentionally kept for pr-creator).
    try {
      this.worktreeManager.cleanupRunDir();
    } catch {
      // Best-effort
    }

    // Cleanup
    this.interactionManager.close();
    for (const [, ipc] of this.ipcServers) {
      await ipc.close();
    }
    this.ipcServers.clear();

    return {
      success,
      stepResults: this.stepStatuses,
      error: this.abortError,
    };
  }

  /**
   * Answer a pending ask_user question identified by request ID.
   * Used when running with --status-json to receive answers from the dashboard.
   */
  answerPendingQuestion(requestId: string, answer: string): void {
    const resolve = this.pendingAnswers.get(requestId);
    if (resolve) {
      this.pendingAnswers.delete(requestId);
      resolve(answer);
    }
  }

  private allTerminalStepsSucceeded(): boolean {
    // A terminal step is one with no on_success transitions
    // The workflow succeeds if at least all reachable steps completed successfully
    for (const [, status] of this.stepStatuses) {
      if (status.state === "failed") return false;
      if (status.state === "running") return false;
    }
    return true;
  }

  private triggerStep(stepId: string, message?: string, viaFailure: boolean = false): void {
    if (this.aborted) return;

    const status = this.stepStatuses.get(stepId)!;
    const step = this.workflow.steps[stepId];

    // If step is running, queue the message
    if (status.state === "running") {
      if (message) {
        status.pendingMessages.push(message);
      }
      return;
    }

    // Check retry limit (only counts failure-edge re-entries; successful self-loops
    // like polling workflows don't burn retries).
    const maxRetries = step.max_retries ?? this.workflow.defaults?.max_retries ?? DEFAULT_MAX_RETRIES;
    if (status.retryCount > maxRetries) {
      this.aborted = true;
      this.abortError = `Step "${stepId}" exceeded max retries (${maxRetries})`;
      return;
    }

    // Check join dependencies
    if (step.join && step.join.length > 0) {
      const allJoinsSatisfied = step.join.every((joinId) => {
        const joinStatus = this.stepStatuses.get(joinId);
        return joinStatus?.state === "succeeded";
      });

      if (!allJoinsSatisfied) {
        status.state = "waiting";
        if (message) {
          status.pendingMessages.push(message);
        }
        return;
      }
    }

    // Increment retry count only on re-entry via a failure edge.
    if (viaFailure && status.state !== "pending" && status.state !== "waiting") {
      status.retryCount++;
    }

    status.state = "running";

    const promise = this.executeStep(stepId, message).then(() => {
      // Only remove if this is still the tracked promise (not replaced by a re-trigger)
      if (this.activePromises.get(stepId) === promise) {
        this.activePromises.delete(stepId);
      }
    });
    this.activePromises.set(stepId, promise);
  }

  private async executeStep(stepId: string, message?: string): Promise<void> {
    if (this.aborted) return;

    const step = this.workflow.steps[stepId];
    const status = this.stepStatuses.get(stepId)!;
    const runtime = this.resolveRuntime(step);

    this.logger.info(
      `[${stepId}] running (${runtime.type}${step.interactive ? ", interactive" : ""}${
        step.worktree?.mode === "isolated" ? ", isolated worktree" :
        step.worktree?.mode === "fork" ? ", forked worktree" : ""
      })`
    );

    if (this.dryRun) {
      this.logger.info(`[${stepId}] dry-run: would execute`);
      status.state = "succeeded";
      this.onStepComplete(stepId);
      return;
    }

    // Resolve worktree: if a run-level worktree exists, steps without their
    // own worktree config share it. Steps with a "fork" config get a fresh
    // checkout at the run worktree's HEAD (so they only see committed state).
    let cwd: string;
    try {
      if (this.runWorktree && !step.worktree) {
        cwd = this.runWorktree;
      } else {
        // If there's a run-level worktree, resolve the step's worktree
        // relative to its HEAD commit (not the repo root HEAD).
        let commitish: string | undefined;
        if (this.runWorktree) {
          commitish = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: this.runWorktree,
            stdio: "pipe",
          }).toString().trim();
        }
        cwd = this.worktreeManager.resolve(stepId, step, this.workflow, commitish);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${stepId}] worktree setup failed: ${errMsg}`);
      status.state = "failed";
      this.onStepFailure(stepId);
      return;
    }

    // Resolve prompt, prepending plan if provided
    let prompt: string | undefined;
    if (step.prompt || this.plan) {
      try {
        const parts: string[] = [];
        if (this.plan) {
          parts.push(`# Project Plan\n\n${this.plan}`);
        }
        if (step.prompt) {
          const raw = resolvePrompt(step.prompt, this.workflowDir);
          parts.push(resolveTemplate(raw, this.stepOutputs));
        }
        prompt = parts.join("\n\n");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[${stepId}] prompt resolution failed: ${errMsg}`);
        status.state = "failed";
        this.onStepFailure(stepId);
        return;
      }
    }

    // Resolve transition message
    let transitionMessage: string | undefined;
    if (message) {
      try {
        transitionMessage = resolveTemplate(message, this.stepOutputs);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[${stepId}] message resolution failed: ${errMsg}`);
        status.state = "failed";
        this.onStepFailure(stepId);
        return;
      }
    }

    // Resolve env
    const env: Record<string, string> = {};

    // Auto-inject SPARKFLOW_* env vars from project config
    if (this.config?.git) {
      if (this.config.git.pr_repo) env.SPARKFLOW_PR_REPO = this.config.git.pr_repo;
      if (this.config.git.push_remote) env.SPARKFLOW_PUSH_REMOTE = this.config.git.push_remote;
      if (this.config.git.base) env.SPARKFLOW_BASE_BRANCH = this.config.git.base;
    }

    if (step.env) {
      try {
        for (const [key, value] of Object.entries(step.env)) {
          env[key] = resolveTemplate(value, this.stepOutputs);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[${stepId}] env resolution failed: ${errMsg}`);
        status.state = "failed";
        this.onStepFailure(stepId);
        return;
      }
    }

    // Set up IPC server for interactive claude-code steps
    let ipcSocketPath: string | undefined;
    if (step.interactive && runtime.type === "claude-code") {
      const ipcServer = new IpcServer();
      this.ipcServers.set(stepId, ipcServer);

      ipcServer.onRequest(async (msg: IpcMessage) => {
        if (msg.type === "ask_user") {
          const question = String(msg.payload.question);

          let response: string;
          if (this.statusJson) {
            // Emit ask_user event on stderr and wait for answer via stdin
            const requestId = randomBytes(8).toString("hex");
            const event = { type: "ask_user", step: stepId, question, request_id: requestId };
            process.stderr.write(JSON.stringify(event) + "\n");
            response = await new Promise<string>((resolve) => {
              this.pendingAnswers.set(requestId, resolve);
            });
          } else {
            response = await this.interactionManager.ask(stepId, question);
          }

          return { type: "response", id: msg.id, payload: { response } };
        } else if (msg.type === "send_message") {
          const msgText = String(msg.payload.message);
          this.interactionManager.sendMessage(stepId, msgText);
          return { type: "response", id: msg.id, payload: {} };
        }
        return {
          type: "error",
          id: msg.id,
          payload: { error: `Unknown message type: ${msg.type}` },
        };
      });

      try {
        await ipcServer.listen();
        ipcSocketPath = ipcServer.path;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[${stepId}] IPC server setup failed: ${errMsg}`);
        status.state = "failed";
        this.onStepFailure(stepId);
        return;
      }
    }

    // Build runtime context. If this is a retry of a claude-code step with
    // a captured session id, resume that conversation so the agent keeps its
    // prior reasoning and tool history. Otherwise, leave sessionId unset — the
    // adapter will mint a fresh UUID. Passing the stale id on a non-resume
    // re-invocation (e.g. when the step is re-entered via on_success after an
    // upstream loop) would cause claude-code to reject the session-id as
    // "already in use".
    const resuming = runtime.type === "claude-code" &&
      (status.retryCount > 0 || status.tokenLimitResumes > 0) &&
      !!status.sessionId;
    const ctx: RuntimeContext = {
      stepId,
      step,
      runtime,
      prompt,
      transitionMessage,
      cwd,
      env,
      git: this.config?.git,
      interactive: step.interactive,
      timeout: step.timeout ?? this.workflow.defaults?.timeout,
      ipcSocketPath,
      verbose: this.verbose,
      logger: this.logger,
      sessionId: resuming ? status.sessionId : undefined,
      resume: resuming,
      stepOutputs: this.stepOutputs,
      workflowDir: this.workflowDir,
    };
    if (resuming) {
      this.logger.info(`[${stepId}] resuming session ${status.sessionId}`);
    }

    // Get adapter
    const adapter = this.adapters.get(runtime.type);
    if (!adapter) {
      this.logger.error(`[${stepId}] no adapter for runtime type "${runtime.type}"`);
      status.state = "failed";
      this.onStepFailure(stepId);
      return;
    }

    // Execute
    try {
      const result = await adapter.run(ctx);

      // Remember the session id whether the step succeeded or failed —
      // recovery-retry needs it on failure, and future on_failure loops
      // can reuse it too.
      if (result.sessionId) {
        status.sessionId = result.sessionId;
      }

      if (result.success) {
        status.state = "succeeded";
        status.outputs = result.outputs;
        status.lastError = undefined;
        status.inPlaceAttempt = 0;
        this.stepOutputs.set(stepId, result.outputs);

        // Cleanup isolated worktree on success
        if (this.worktreeManager.hasWorktree(stepId)) {
          this.worktreeManager.cleanup(stepId);
        }

        this.logger.info(`[${stepId}] succeeded`);
        this.onStepComplete(stepId);
      } else {
        if (result.tokenLimitHit && result.sessionId) {
          status.sessionId = result.sessionId;
          if (await this.shouldTokenLimitResume(stepId)) {
            status.state = "running";
            await this.executeStep(stepId, "You reached the context/turn limit. Please continue your work where you left off.");
            return;
          }
        }
        const errSuffix = result.error ? `: ${result.error}` : "";
        if (await this.shouldInPlaceRetry(stepId, errSuffix)) {
          // Re-enter execute without traversing on_failure or counting as upstream retry.
          status.state = "running";
          await this.executeStep(stepId, message);
          return;
        }
        status.state = "failed";
        status.lastError = result.error;
        status.inPlaceAttempt = 0;
        this.logger.error(`[${stepId}] failed${errSuffix}`);
        await this.onStepFailure(stepId);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (await this.shouldInPlaceRetry(stepId, `: ${errMsg}`)) {
        status.state = "running";
        await this.executeStep(stepId, message);
        return;
      }
      status.state = "failed";
      status.lastError = errMsg;
      status.inPlaceAttempt = 0;
      this.logger.error(`[${stepId}] error: ${errMsg}`);
      await this.onStepFailure(stepId);
    } finally {
      // Clean up IPC server after step completes
      const ipc = this.ipcServers.get(stepId);
      if (ipc) {
        await ipc.close();
        this.ipcServers.delete(stepId);
      }
    }

    // Process queued messages
    this.processPendingMessages(stepId);
  }

  private onStepComplete(stepId: string): void {
    const step = this.workflow.steps[stepId];

    // Fire on_success transitions
    if (step.on_success) {
      for (const transition of step.on_success) {
        this.triggerStep(transition.step, transition.message);
      }
    }

    // Check if any waiting steps have their joins now satisfied
    this.checkWaitingJoins();
  }

  private async onStepFailure(stepId: string): Promise<void> {
    const step = this.workflow.steps[stepId];

    if (step.on_failure && step.on_failure.length > 0) {
      for (const transition of step.on_failure) {
        this.triggerStep(transition.step, transition.message, true);
      }
      return;
    }

    // No declared recovery. Pause-and-ask only if the step (or workflow
    // default) opts in via ask_on_failure, and we're running under the
    // dashboard (status-json). Otherwise abort like before — unattended
    // runs must still fail fast.
    const askOnFailure = step.ask_on_failure ?? this.workflow.defaults?.ask_on_failure ?? false;
    if (!askOnFailure || !this.statusJson) {
      this.aborted = true;
      this.abortError = `Step "${stepId}" failed with no on_failure transition`;
      return;
    }

    const status = this.stepStatuses.get(stepId)!;
    const requestId = randomBytes(8).toString("hex");
    const event = {
      type: "job_failed",
      step: stepId,
      error: status.lastError ?? "step failed",
      request_id: requestId,
    };
    process.stderr.write(JSON.stringify(event) + "\n");

    const answer = await new Promise<string>((resolve) => {
      this.pendingAnswers.set(requestId, resolve);
    });

    let decision: { action?: string; message?: string };
    try {
      decision = JSON.parse(answer);
    } catch {
      decision = { action: "abort" };
    }

    const action = decision.action ?? "abort";
    const message = decision.message;

    if (action === "retry") {
      // Reset the step so triggerStep will re-run it. viaFailure=true bumps
      // the retry counter so a stuck user-driven retry loop still hits
      // max_retries eventually.
      status.state = "failed";
      status.outputs = {};
      this.triggerStep(stepId, message, true);
    } else if (action === "skip") {
      status.state = "succeeded";
      status.outputs = {};
      status.lastError = undefined;
      this.stepOutputs.set(stepId, {});
      this.logger.info(`[${stepId}] skipped by user`);
      this.onStepComplete(stepId);
    } else {
      this.aborted = true;
      this.abortError = `Step "${stepId}" failed; user aborted`;
    }
  }

  private checkWaitingJoins(): void {
    for (const [id, status] of this.stepStatuses) {
      if (status.state !== "waiting") continue;

      const step = this.workflow.steps[id];
      if (!step.join) continue;

      const allSatisfied = step.join.every((joinId) => {
        const joinStatus = this.stepStatuses.get(joinId);
        return joinStatus?.state === "succeeded";
      });

      if (allSatisfied) {
        const message = status.pendingMessages.shift();
        this.triggerStep(id, message);
      }
    }
  }

  private processPendingMessages(stepId: string): void {
    const status = this.stepStatuses.get(stepId)!;
    if (status.pendingMessages.length > 0 && status.state !== "running") {
      const message = status.pendingMessages.shift();
      this.triggerStep(stepId, message);
    }
  }

  private static readonly MAX_TOKEN_LIMIT_RESUMES = 10;

  private async shouldTokenLimitResume(stepId: string): Promise<boolean> {
    const status = this.stepStatuses.get(stepId)!;
    status.tokenLimitResumes++;
    if (status.tokenLimitResumes > WorkflowEngine.MAX_TOKEN_LIMIT_RESUMES) {
      this.logger.error(
        `[${stepId}] token limit resume exhausted after ${WorkflowEngine.MAX_TOKEN_LIMIT_RESUMES} resumes`
      );
      return false;
    }
    this.logger.info(
      `[${stepId}] token limit reached — resuming (${status.tokenLimitResumes}/${WorkflowEngine.MAX_TOKEN_LIMIT_RESUMES})`
    );
    return true;
  }

  private async shouldInPlaceRetry(stepId: string, errSuffix: string): Promise<boolean> {
    const step = this.workflow.steps[stepId];
    const retry = step.retry ?? this.workflow.defaults?.retry;
    if (!retry) return false;

    const status = this.stepStatuses.get(stepId)!;
    status.inPlaceAttempt++;
    if (status.inPlaceAttempt >= retry.attempts) {
      this.logger.error(
        `[${stepId}] retry exhausted after ${status.inPlaceAttempt} attempt(s)${errSuffix}`
      );
      return false;
    }

    const backoff = retry.backoff_seconds ?? 0;
    this.logger.info(
      `[${stepId}] failed${errSuffix} — retrying (${status.inPlaceAttempt}/${retry.attempts - 1})${backoff ? ` after ${backoff}s` : ""}`
    );
    if (backoff > 0) {
      await new Promise((r) => setTimeout(r, backoff * 1000));
    }
    return true;
  }

  private resolveRuntime(step: Step): Runtime {
    const runtime = step.runtime ?? this.workflow.defaults?.runtime;
    if (!runtime) {
      throw new Error(`Step has no runtime and no default runtime configured`);
    }
    return applyLlmOverride(runtime);
  }
}

/**
 * Swap an LLM step's `runtime.type` based on the `SPARKFLOW_LLM` env var
 * (set by the web server when the user picks "Jobs runtime: Gemini/Claude").
 * Preserves non-LLM runtime types unchanged. Other fields (model, args, etc.)
 * are dropped on swap — they're tool-specific and don't translate cleanly, so
 * we let each adapter fall back to its defaults.
 */
function applyLlmOverride(runtime: Runtime): Runtime {
  const override = process.env.SPARKFLOW_LLM;
  if (override !== "claude" && override !== "gemini") return runtime;
  if (override === "claude" && runtime.type === "gemini") return { type: "claude-code" };
  if (override === "gemini" && runtime.type === "claude-code") return { type: "gemini" };
  return runtime;
}
