import { dirname, resolve } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { SparkflowWorkflow, Step, Runtime } from "../schema/types.js";
import type { RuntimeAdapter } from "../runtime/types.js";
import type { RuntimeContext } from "../runtime/types.js";
import { ShellAdapter } from "../runtime/shell.js";
import { ClaudeCodeAdapter } from "../runtime/claude-code.js";
import { CustomAdapter } from "../runtime/custom.js";
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
  private adapters: Map<string, RuntimeAdapter>;
  private logger: Logger;
  private cwd: string;
  private workflowDir: string;
  private dryRun: boolean;
  private plan?: string;
  private verbose: boolean;
  private worktreeManager: WorktreeManager;
  private interactionManager: UserInteractionManager;

  private stepStatuses = new Map<string, StepStatus>();
  private stepOutputs = new Map<string, Record<string, unknown>>();
  private activePromises = new Map<string, Promise<void>>();
  private ipcServers = new Map<string, IpcServer>();
  private aborted = false;
  private abortError?: string;

  constructor(
    workflow: SparkflowWorkflow,
    options: EngineOptions = {},
    adapters?: Map<string, RuntimeAdapter>
  ) {
    this.workflow = workflow;
    this.logger = options.logger ?? new ConsoleLogger();
    this.cwd = options.cwd ?? process.cwd();
    this.workflowDir = options.workflowDir ?? this.cwd;
    this.dryRun = options.dryRun ?? false;
    this.plan = options.plan;
    this.verbose = options.verbose ?? false;
    this.worktreeManager = new WorktreeManager(this.cwd);
    this.interactionManager = new UserInteractionManager(this.logger);

    this.adapters = adapters ?? new Map<string, RuntimeAdapter>([
      ["shell", new ShellAdapter()],
      ["claude-code", new ClaudeCodeAdapter()],
      ["custom", new CustomAdapter()],
    ]);

    // Initialize step statuses
    for (const id of Object.keys(workflow.steps)) {
      this.stepStatuses.set(id, {
        state: "pending",
        retryCount: 0,
        outputs: {},
        completedJoins: new Set(),
        pendingMessages: [],
      });
    }
  }

  async run(): Promise<RunResult> {
    this.logger.info(`[sparkflow] Starting workflow "${this.workflow.name}"`);

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

  private allTerminalStepsSucceeded(): boolean {
    // A terminal step is one with no on_success transitions
    // The workflow succeeds if at least all reachable steps completed successfully
    for (const [, status] of this.stepStatuses) {
      if (status.state === "failed") return false;
      if (status.state === "running") return false;
    }
    return true;
  }

  private triggerStep(stepId: string, message?: string): void {
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

    // Check retry limit
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

    // Increment retry count (except first run)
    if (status.state !== "pending" && status.state !== "waiting") {
      status.retryCount++;
    } else if (status.state === "pending") {
      // First run: retryCount stays at 0
    } else {
      // Waiting → running (join satisfied): don't increment
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
        step.worktree?.mode === "isolated" ? ", isolated worktree" : ""
      })`
    );

    if (this.dryRun) {
      this.logger.info(`[${stepId}] dry-run: would execute`);
      status.state = "succeeded";
      this.onStepComplete(stepId);
      return;
    }

    // Resolve worktree
    let cwd: string;
    try {
      cwd = this.worktreeManager.resolve(stepId, step, this.workflow);
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
          const response = await this.interactionManager.ask(stepId, question);
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

    // Build runtime context
    const ctx: RuntimeContext = {
      stepId,
      step,
      runtime,
      prompt,
      transitionMessage,
      cwd,
      env,
      interactive: step.interactive,
      timeout: step.timeout ?? this.workflow.defaults?.timeout,
      ipcSocketPath,
      verbose: this.verbose,
      logger: this.logger,
    };

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

      if (result.success) {
        status.state = "succeeded";
        status.outputs = result.outputs;
        this.stepOutputs.set(stepId, result.outputs);

        // Cleanup isolated worktree on success
        if (this.worktreeManager.hasWorktree(stepId)) {
          this.worktreeManager.cleanup(stepId);
        }

        this.logger.info(`[${stepId}] succeeded`);
        this.onStepComplete(stepId);
      } else {
        status.state = "failed";
        this.logger.error(
          `[${stepId}] failed${result.error ? `: ${result.error}` : ""}`
        );
        this.onStepFailure(stepId);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      status.state = "failed";
      this.logger.error(`[${stepId}] error: ${errMsg}`);
      this.onStepFailure(stepId);
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

  private onStepFailure(stepId: string): void {
    const step = this.workflow.steps[stepId];

    if (step.on_failure && step.on_failure.length > 0) {
      for (const transition of step.on_failure) {
        this.triggerStep(transition.step, transition.message);
      }
    } else {
      // No on_failure transitions → workflow fails
      this.aborted = true;
      this.abortError = `Step "${stepId}" failed with no on_failure transition`;
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

  private resolveRuntime(step: Step): Runtime {
    const runtime = step.runtime ?? this.workflow.defaults?.runtime;
    if (!runtime) {
      throw new Error(`Step has no runtime and no default runtime configured`);
    }
    return runtime;
  }
}
