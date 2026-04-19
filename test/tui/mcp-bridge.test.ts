import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { IpcServer, IpcClient, type IpcMessage } from "../../src/mcp/ipc.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, resolveWorkflowPath } from "../../src/config/project-config.js";

/**
 * Tests for the MCP bridge IPC protocol.
 * We simulate the bridge by testing the IPC request/response patterns
 * that the bridge uses to communicate with the dashboard app.
 */
describe("MCP bridge IPC protocol", () => {
  let server: IpcServer | null = null;
  let client: IpcClient | null = null;

  afterEach(async () => {
    client?.close();
    client = null;
    await server?.close();
    server = null;
  });

  it("handles start_workflow request", async () => {
    server = new IpcServer();
    server.onRequest(async (msg) => {
      if (msg.type === "start_workflow") {
        return {
          type: "response",
          id: msg.id,
          payload: { jobId: "test-job-123" },
        };
      }
      return { type: "error", id: msg.id, payload: { error: "unknown" } };
    });
    await server.listen();

    client = new IpcClient(server.path);
    await client.connect();

    const response = await client.request({
      type: "start_workflow",
      id: "req-1",
      payload: { workflowPath: "/tmp/workflow.json", cwd: "/tmp" },
    });

    expect(response.type).toBe("response");
    expect(response.payload.jobId).toBe("test-job-123");
  });

  it("handles list_jobs request", async () => {
    const mockJobs = [
      {
        id: "job-1",
        workflowPath: "/tmp/wf.json",
        workflowName: "test-wf",
        state: "running",
        summary: "step1: running",
        startTime: Date.now(),
      },
    ];

    server = new IpcServer();
    server.onRequest(async (msg) => {
      if (msg.type === "list_jobs") {
        return {
          type: "response",
          id: msg.id,
          payload: { jobs: mockJobs },
        };
      }
      return { type: "error", id: msg.id, payload: { error: "unknown" } };
    });
    await server.listen();

    client = new IpcClient(server.path);
    await client.connect();

    const response = await client.request({
      type: "list_jobs",
      id: "req-2",
      payload: {},
    });

    expect(response.type).toBe("response");
    const jobs = response.payload.jobs as typeof mockJobs;
    expect(jobs.length).toBe(1);
    expect(jobs[0].id).toBe("job-1");
    expect(jobs[0].state).toBe("running");
  });

  it("handles get_job_detail request", async () => {
    server = new IpcServer();
    server.onRequest(async (msg) => {
      if (msg.type === "get_job_detail") {
        const jobId = msg.payload.jobId as string;
        if (jobId === "job-1") {
          return {
            type: "response",
            id: msg.id,
            payload: {
              info: { id: "job-1", state: "running" },
              output: ["[sparkflow] Starting workflow", "[dev] running"],
            },
          };
        }
        return {
          type: "error",
          id: msg.id,
          payload: { error: `Job not found: ${jobId}` },
        };
      }
      return { type: "error", id: msg.id, payload: { error: "unknown" } };
    });
    await server.listen();

    client = new IpcClient(server.path);
    await client.connect();

    const response = await client.request({
      type: "get_job_detail",
      id: "req-3",
      payload: { jobId: "job-1" },
    });

    expect(response.type).toBe("response");
    expect(response.payload.info).toBeDefined();
    expect((response.payload.output as string[]).length).toBe(2);
  });

  it("returns error for unknown job in get_job_detail", async () => {
    server = new IpcServer();
    server.onRequest(async (msg) => {
      if (msg.type === "get_job_detail") {
        return {
          type: "error",
          id: msg.id,
          payload: { error: `Job not found: ${msg.payload.jobId}` },
        };
      }
      return { type: "error", id: msg.id, payload: { error: "unknown" } };
    });
    await server.listen();

    client = new IpcClient(server.path);
    await client.connect();

    const response = await client.request({
      type: "get_job_detail",
      id: "req-4",
      payload: { jobId: "nonexistent" },
    });

    expect(response.type).toBe("error");
    expect(response.payload.error).toContain("nonexistent");
  });

  it("handles answer_question request", async () => {
    server = new IpcServer();
    server.onRequest(async (msg) => {
      if (msg.type === "answer_question") {
        return { type: "response", id: msg.id, payload: {} };
      }
      return { type: "error", id: msg.id, payload: { error: "unknown" } };
    });
    await server.listen();

    client = new IpcClient(server.path);
    await client.connect();

    const response = await client.request({
      type: "answer_question",
      id: "req-5",
      payload: { jobId: "job-1", answer: "Use React" },
    });

    expect(response.type).toBe("response");
  });

  it("start_workflow payload forwards the provided workflowPath unchanged", async () => {
    let capturedPayload: Record<string, unknown> | null = null;
    server = new IpcServer();
    server.onRequest(async (msg) => {
      if (msg.type === "start_workflow") {
        capturedPayload = msg.payload as Record<string, unknown>;
        return { type: "response", id: msg.id, payload: { jobId: "job-abs" } };
      }
      return { type: "error", id: msg.id, payload: { error: "unknown" } };
    });
    await server.listen();

    client = new IpcClient(server.path);
    await client.connect();

    const absPath = "/abs/path/to/workflow.json";
    await client.request({
      type: "start_workflow",
      id: "req-abs",
      payload: { workflowPath: absPath, cwd: "/tmp" },
    });

    expect(capturedPayload).not.toBeNull();
    expect((capturedPayload as unknown as Record<string, unknown>)["workflowPath"]).toBe(absPath);
  });

  it("handles unknown message type", async () => {
    server = new IpcServer();
    server.onRequest(async (msg) => {
      return {
        type: "error",
        id: msg.id,
        payload: { error: `Unknown message type: ${msg.type}` },
      };
    });
    await server.listen();

    client = new IpcClient(server.path);
    await client.connect();

    const response = await client.request({
      type: "bogus",
      id: "req-6",
      payload: {},
    });

    expect(response.type).toBe("error");
    expect(response.payload.error).toContain("Unknown message type");
  });
});

// Tests for the workflow path resolution logic used by the start_workflow handler.
// These mirror the bridge's exact call sequence (loadProjectConfig → resolveWorkflowPath)
// so that the IPC tests above and the resolution tests below together cover the handler end-to-end.
describe("start_workflow workflow path resolution (bridge logic)", () => {
  let userHome: string;
  let projectCwd: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    userHome = mkdtempSync(join(tmpdir(), "sparkflow-bridge-test-"));
    projectCwd = mkdtempSync(join(tmpdir(), "sparkflow-bridge-cwd-"));
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = userHome;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    rmSync(userHome, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  function writeUserWorkflow(name: string): string {
    const dir = join(userHome, "sparkflow", "workflows");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.json`);
    writeFileSync(path, "{}");
    return path;
  }

  function writeProjectWorkflow(name: string): string {
    const dir = join(projectCwd, ".sparkflow", "workflows");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.json`);
    writeFileSync(path, "{}");
    return path;
  }

  it("bare name resolves to user-level workflow", () => {
    const expected = writeUserWorkflow("feature-development");
    const config = loadProjectConfig(projectCwd);
    expect(resolveWorkflowPath("feature-development", projectCwd, config)).toBe(expected);
  });

  it("project-level workflow overrides user-level for the same bare name", () => {
    writeUserWorkflow("feature-development");
    const expected = writeProjectWorkflow("feature-development");
    const config = loadProjectConfig(projectCwd);
    expect(resolveWorkflowPath("feature-development", projectCwd, config)).toBe(expected);
  });

  it("absolute path is forwarded unchanged", () => {
    const abs = writeUserWorkflow("feature-development");
    const config = loadProjectConfig(projectCwd);
    expect(resolveWorkflowPath(abs, projectCwd, config)).toBe(abs);
  });

  it("unknown bare name throws an error listing searched locations", () => {
    writeUserWorkflow("other");
    const config = loadProjectConfig(projectCwd);
    expect(() => resolveWorkflowPath("nonexistent", projectCwd, config)).toThrow(/nonexistent/);
  });
});
