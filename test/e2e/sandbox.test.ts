import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { WorkflowEngine } from "../../src/engine/engine.js";
import type { SparkflowWorkflow } from "../../src/schema/types.js";

function dockerAvailable(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function imageExists(image: string): boolean {
  try {
    execSync(`docker image inspect ${image}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const IMAGE = "sparkflow-sandbox:ref";
const canRun = dockerAvailable() && imageExists(IMAGE);
const describeDocker = canRun ? describe : describe.skip;

describeDocker("e2e sandbox (docker)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "sparkflow-sandbox-e2e-"));
    execSync("git init && git commit --allow-empty -m init", {
      cwd: workDir,
      stdio: "pipe",
    });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it(
    "shell step runs inside the container and writes to the bind-mounted workspace",
    async () => {
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "sandbox-write-test",
        entry: "writer",
        defaults: {
          sandbox: { type: "docker", image: IMAGE },
        },
        steps: {
          writer: {
            name: "Writer",
            interactive: false,
            runtime: {
              type: "shell",
              command: "sh",
              args: ["-c", "echo sandbox-ok > /workspace/result.txt && cat /workspace/result.txt"],
            },
            timeout: 30,
            outputs: {
              results: { type: "text" },
            },
          },
        },
      };

      const engine = new WorkflowEngine(workflow, { cwd: workDir, workflowDir: workDir });
      const result = await engine.run();

      expect(result.success).toBe(true);
      expect(result.stepResults.get("writer")?.state).toBe("succeeded");
      // File written inside the container should appear on the host via bind mount.
      expect(existsSync(join(workDir, "result.txt"))).toBe(true);
      expect(readFileSync(join(workDir, "result.txt"), "utf8").trim()).toBe("sandbox-ok");
    },
    { timeout: 30_000 },
  );

  it(
    "shell step is isolated from host filesystem outside the workspace",
    async () => {
      // Create a file on the host outside the workspace; the container
      // should not be able to see it.
      const hostSecret = join(tmpdir(), `sparkflow-secret-${Date.now()}.txt`);
      writeFileSync(hostSecret, "host-secret-value");

      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "sandbox-isolation-test",
        entry: "reader",
        defaults: {
          sandbox: { type: "docker", image: IMAGE },
        },
        steps: {
          reader: {
            name: "Reader",
            interactive: false,
            runtime: {
              type: "shell",
              command: "cat",
              args: [hostSecret],
            },
            timeout: 15,
          },
        },
      };

      const engine = new WorkflowEngine(workflow, { cwd: workDir, workflowDir: workDir });
      const result = await engine.run();

      // The step should fail — the file doesn't exist inside the container.
      expect(result.success).toBe(false);
      expect(result.stepResults.get("reader")?.state).toBe("failed");

      rmSync(hostSecret, { force: true });
    },
    { timeout: 30_000 },
  );

  it(
    "env_passthrough forwards host environment variables into the container",
    async () => {
      process.env.SPARKFLOW_TEST_VAR = "passthrough-ok";

      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "sandbox-env-test",
        entry: "echoer",
        defaults: {
          sandbox: {
            type: "docker",
            image: IMAGE,
            env_passthrough: ["SPARKFLOW_TEST_VAR"],
          },
        },
        steps: {
          echoer: {
            name: "Echoer",
            interactive: false,
            runtime: {
              type: "shell",
              command: "printenv",
              args: ["SPARKFLOW_TEST_VAR"],
            },
            timeout: 15,
            outputs: {
              val: { type: "text" },
            },
          },
        },
      };

      const engine = new WorkflowEngine(workflow, { cwd: workDir, workflowDir: workDir });
      const result = await engine.run();

      expect(result.success).toBe(true);
      expect(result.stepResults.get("echoer")?.outputs.val).toBe("passthrough-ok");

      delete process.env.SPARKFLOW_TEST_VAR;
    },
    { timeout: 30_000 },
  );

  it(
    "container is cleaned up after step completes",
    async () => {
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "sandbox-cleanup-test",
        entry: "noop",
        defaults: {
          sandbox: { type: "docker", image: IMAGE },
        },
        steps: {
          noop: {
            name: "Noop",
            interactive: false,
            runtime: { type: "shell", command: "true" },
            timeout: 15,
          },
        },
      };

      const engine = new WorkflowEngine(workflow, { cwd: workDir, workflowDir: workDir });
      const result = await engine.run();
      expect(result.success).toBe(true);

      // No sparkflow containers should be lingering. We can't easily get
      // the exact container id from here, but we can check that no
      // containers with the reference image are running.
      const running = execSync(
        `docker ps --filter ancestor=${IMAGE} --format '{{.ID}}'`,
        { stdio: "pipe" },
      ).toString().trim();
      expect(running).toBe("");
    },
    { timeout: 30_000 },
  );

  it(
    "multi-step pipeline works with sandbox — fan-out to shell tester",
    async () => {
      // Pre-create a source file on the host so the shell step can just test
      // it — avoids needing claude. This tests that sandbox works across
      // sequential steps sharing the same worktree.
      writeFileSync(
        join(workDir, "add.js"),
        "module.exports = function add(a, b) { return a + b; };\n",
      );
      writeFileSync(
        join(workDir, "add.test.js"),
        [
          'const add = require("./add");',
          'console.assert(add(2, 3) === 5, "2+3 should be 5");',
          'console.log("PASS");',
        ].join("\n") + "\n",
      );

      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "sandbox-pipeline-test",
        entry: "setup",
        defaults: {
          sandbox: { type: "docker", image: IMAGE },
        },
        steps: {
          setup: {
            name: "Setup",
            interactive: false,
            runtime: { type: "shell", command: "ls", args: ["-la"] },
            timeout: 15,
            on_success: [{ step: "tester" }],
          },
          tester: {
            name: "Tester",
            interactive: false,
            runtime: {
              type: "shell",
              command: "node",
              args: ["add.test.js"],
            },
            timeout: 15,
            outputs: {
              results: { type: "text" },
            },
          },
        },
      };

      const engine = new WorkflowEngine(workflow, { cwd: workDir, workflowDir: workDir });
      const result = await engine.run();

      expect(result.success).toBe(true);
      expect(result.stepResults.get("setup")?.state).toBe("succeeded");
      expect(result.stepResults.get("tester")?.state).toBe("succeeded");
      expect(result.stepResults.get("tester")?.outputs.results).toContain("PASS");
    },
    { timeout: 30_000 },
  );
});

describe("e2e sandbox (local fallback)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "sparkflow-sandbox-e2e-local-"));
    execSync("git init && git commit --allow-empty -m init", {
      cwd: workDir,
      stdio: "pipe",
    });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it(
    "workflow without sandbox config runs identically to before",
    async () => {
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "no-sandbox-test",
        entry: "echoer",
        steps: {
          echoer: {
            name: "Echoer",
            interactive: false,
            runtime: {
              type: "shell",
              command: "echo",
              args: ["local-ok"],
            },
            timeout: 10,
            outputs: {
              val: { type: "text" },
            },
          },
        },
      };

      const engine = new WorkflowEngine(workflow, { cwd: workDir, workflowDir: workDir });
      const result = await engine.run();

      expect(result.success).toBe(true);
      expect(result.stepResults.get("echoer")?.outputs.val).toBe("local-ok");
    },
    { timeout: 15_000 },
  );
});
