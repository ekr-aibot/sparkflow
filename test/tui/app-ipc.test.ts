import { describe, it, expect, afterEach } from "vitest";
import { IpcServer, IpcClient, type IpcMessage } from "../../src/mcp/ipc.js";
import { JobManager } from "../../src/tui/job-manager.js";

/**
 * Tests for the App's IPC request handler logic.
 * We extract the handler pattern from app.ts and test it via IPC directly,
 * since the full App requires a TTY.
 */

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function createIpcHandler(jobManager: JobManager) {
  return async (msg: IpcMessage): Promise<IpcMessage> => {
    const response = (payload: Record<string, unknown>): IpcMessage => ({
      type: "response",
      id: msg.id,
      payload,
    });
    const errorResponse = (error: string): IpcMessage => ({
      type: "error",
      id: msg.id,
      payload: { error },
    });

    switch (msg.type) {
      case "start_workflow": {
        const { workflowPath, cwd, plan } = msg.payload as {
          workflowPath: string;
          cwd?: string;
          plan?: string;
        };
        const jobId = jobManager.startJob(workflowPath, { cwd, plan });
        return response({ jobId });
      }
      case "list_jobs":
        return response({ jobs: jobManager.getJobs() });
      case "get_job_detail": {
        const { jobId } = msg.payload as { jobId: string };
        const detail = jobManager.getJobDetail(jobId);
        if (!detail) return errorResponse(`Job not found: ${jobId}`);
        return response(detail as unknown as Record<string, unknown>);
      }
      case "answer_question": {
        const { jobId, answer } = msg.payload as { jobId: string; answer: string };
        const ok = jobManager.answerQuestion(jobId, answer);
        if (!ok) return errorResponse(`No pending question for job: ${jobId}`);
        return response({});
      }
      default:
        return errorResponse(`Unknown message type: ${msg.type}`);
    }
  };
}

describe("App IPC handler", () => {
  let server: IpcServer | null = null;
  let client: IpcClient | null = null;
  let jobManager: JobManager;

  afterEach(async () => {
    client?.close();
    client = null;
    await server?.close();
    server = null;
    jobManager?.killAll();
  });

  async function setup(): Promise<void> {
    jobManager = new JobManager();
    server = new IpcServer();
    server.onRequest(createIpcHandler(jobManager));
    await server.listen();
    client = new IpcClient(server.path);
    await client.connect();
  }

  it("start_workflow creates a job and returns ID", async () => {
    await setup();

    const response = await client!.request({
      type: "start_workflow",
      id: "r1",
      payload: { workflowPath: "/tmp/wf.json" },
    });

    expect(response.type).toBe("response");
    expect(response.payload.jobId).toBeTruthy();
    expect(typeof response.payload.jobId).toBe("string");
  });

  it("list_jobs returns all jobs", async () => {
    await setup();

    // Start two jobs
    await client!.request({
      type: "start_workflow",
      id: "r1",
      payload: { workflowPath: "/tmp/wf1.json" },
    });
    await client!.request({
      type: "start_workflow",
      id: "r2",
      payload: { workflowPath: "/tmp/wf2.json" },
    });

    const response = await client!.request({
      type: "list_jobs",
      id: "r3",
      payload: {},
    });

    expect(response.type).toBe("response");
    const jobs = response.payload.jobs as Array<{ id: string; workflowPath: string }>;
    expect(jobs.length).toBe(2);
  });

  it("get_job_detail returns info and output", async () => {
    await setup();

    const startResp = await client!.request({
      type: "start_workflow",
      id: "r1",
      payload: { workflowPath: "/tmp/wf.json" },
    });
    const jobId = startResp.payload.jobId as string;

    const response = await client!.request({
      type: "get_job_detail",
      id: "r2",
      payload: { jobId },
    });

    expect(response.type).toBe("response");
    expect(response.payload.info).toBeDefined();
    expect(response.payload.output).toBeDefined();
  });

  it("get_job_detail returns error for unknown job", async () => {
    await setup();

    const response = await client!.request({
      type: "get_job_detail",
      id: "r1",
      payload: { jobId: "nonexistent" },
    });

    expect(response.type).toBe("error");
    expect(response.payload.error).toContain("Job not found");
  });

  it("answer_question returns error when no pending question", async () => {
    await setup();

    const startResp = await client!.request({
      type: "start_workflow",
      id: "r1",
      payload: { workflowPath: "/tmp/wf.json" },
    });
    const jobId = startResp.payload.jobId as string;

    const response = await client!.request({
      type: "answer_question",
      id: "r2",
      payload: { jobId, answer: "yes" },
    });

    expect(response.type).toBe("error");
    expect(response.payload.error).toContain("No pending question");
  });

  it("unknown message type returns error", async () => {
    await setup();

    const response = await client!.request({
      type: "bogus",
      id: "r1",
      payload: {},
    });

    expect(response.type).toBe("error");
    expect(response.payload.error).toContain("Unknown message type");
  });

  it("job eventually shows as failed for nonexistent workflow", async () => {
    await setup();

    const startResp = await client!.request({
      type: "start_workflow",
      id: "r1",
      payload: { workflowPath: "/nonexistent/workflow.json" },
    });
    const jobId = startResp.payload.jobId as string;

    // Wait for the job to fail
    await waitFor(() => {
      const jobs = jobManager.getJobs();
      return jobs.find((j) => j.id === jobId)?.state === "failed";
    });

    const response = await client!.request({
      type: "list_jobs",
      id: "r2",
      payload: {},
    });

    const jobs = response.payload.jobs as Array<{ id: string; state: string }>;
    const job = jobs.find((j) => j.id === jobId);
    expect(job?.state).toBe("failed");
  });
});
