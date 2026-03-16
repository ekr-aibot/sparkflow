import { describe, it, expect, afterEach } from "vitest";
import { IpcServer, IpcClient, type IpcMessage } from "../../src/mcp/ipc.js";

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
