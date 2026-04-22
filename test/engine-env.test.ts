import { describe, it, expect } from "vitest";
import { WorkflowEngine } from "../src/engine/engine.js";
import type { RuntimeAdapter, RuntimeContext, RuntimeResult } from "../src/runtime/types.js";

// Silent logger for tests
const silentLogger = {
  info: () => {},
  error: () => {},
};

class MockAdapter implements RuntimeAdapter {
  lastCtx?: RuntimeContext;
  async run(ctx: RuntimeContext): Promise<RuntimeResult> {
    this.lastCtx = ctx;
    return { success: true, outputs: {} };
  }
}

describe("WorkflowEngine Env Injection", () => {
  it("injects SPARKFLOW_PR_REPO from config", async () => {
    const workflow = {
      version: "1",
      name: "test",
      entry: "step1",
      steps: {
        step1: {
          name: "Step 1",
          interactive: false,
          runtime: { type: "shell", command: "echo" }
        }
      }
    } as any;

    const adapter = new MockAdapter();
    const adapters = new Map<string, RuntimeAdapter>([["shell", adapter]]);

    const engine = new WorkflowEngine(workflow, {
      logger: silentLogger,
      config: {
        git: {
          pr_repo: "owner/repo",
          push_remote: "upstream",
          base: "main"
        }
      }
    }, adapters);

    await engine.run();

    expect(adapter.lastCtx?.env.SPARKFLOW_PR_REPO).toBe("owner/repo");
    expect(adapter.lastCtx?.env.SPARKFLOW_PUSH_REMOTE).toBe("upstream");
    expect(adapter.lastCtx?.env.SPARKFLOW_BASE_BRANCH).toBe("main");
  });

  it("injects SPARKFLOW_ISSUES_REPO from git.issues_repo", async () => {
    const workflow = {
      version: "1",
      name: "test",
      entry: "step1",
      steps: {
        step1: {
          name: "Step 1",
          interactive: false,
          runtime: { type: "shell", command: "echo" }
        }
      }
    } as any;

    const adapter = new MockAdapter();
    const adapters = new Map<string, RuntimeAdapter>([["shell", adapter]]);

    const engine = new WorkflowEngine(workflow, {
      logger: silentLogger,
      config: {
        git: {
          pr_repo: "owner/repo",
          issues_repo: "owner/issues-tracker"
        }
      }
    }, adapters);

    await engine.run();

    expect(adapter.lastCtx?.env.SPARKFLOW_ISSUES_REPO).toBe("owner/issues-tracker");
    expect(adapter.lastCtx?.env.SPARKFLOW_PR_REPO).toBe("owner/repo");
  });

  it("SPARKFLOW_ISSUES_REPO falls back to pr_repo when issues_repo is absent", async () => {
    const workflow = {
      version: "1",
      name: "test",
      entry: "step1",
      steps: {
        step1: {
          name: "Step 1",
          interactive: false,
          runtime: { type: "shell", command: "echo" }
        }
      }
    } as any;

    const adapter = new MockAdapter();
    const adapters = new Map<string, RuntimeAdapter>([["shell", adapter]]);

    const engine = new WorkflowEngine(workflow, {
      logger: silentLogger,
      config: {
        git: {
          pr_repo: "owner/repo"
        }
      }
    }, adapters);

    await engine.run();

    expect(adapter.lastCtx?.env.SPARKFLOW_ISSUES_REPO).toBe("owner/repo");
  });

  it("SPARKFLOW_ISSUES_REPO is absent when neither issues_repo nor pr_repo is configured", async () => {
    const workflow = {
      version: "1",
      name: "test",
      entry: "step1",
      steps: {
        step1: {
          name: "Step 1",
          interactive: false,
          runtime: { type: "shell", command: "echo" }
        }
      }
    } as any;

    const adapter = new MockAdapter();
    const adapters = new Map<string, RuntimeAdapter>([["shell", adapter]]);

    const engine = new WorkflowEngine(workflow, {
      logger: silentLogger,
      config: {
        git: {
          push_remote: "origin"
        }
      }
    }, adapters);

    await engine.run();

    expect(adapter.lastCtx?.env.SPARKFLOW_ISSUES_REPO).toBeUndefined();
  });

  it("step env overrides injected vars", async () => {
    const workflow = {
      version: "1",
      name: "test",
      entry: "step1",
      steps: {
        step1: {
          name: "Step 1",
          interactive: false,
          runtime: { type: "shell", command: "echo" },
          env: {
            SPARKFLOW_PR_REPO: "override/repo"
          }
        }
      }
    } as any;

    const adapter = new MockAdapter();
    const adapters = new Map<string, RuntimeAdapter>([["shell", adapter]]);

    const engine = new WorkflowEngine(workflow, {
      logger: silentLogger,
      config: {
        git: {
          pr_repo: "owner/repo"
        }
      }
    }, adapters);

    await engine.run();

    expect(adapter.lastCtx?.env.SPARKFLOW_PR_REPO).toBe("override/repo");
  });
});
