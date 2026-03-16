import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { WorkflowEngine } from "../../src/engine/engine.js";
import type { SparkflowWorkflow } from "../../src/schema/types.js";

// Skip if claude is not available
let hasClaude = false;
try {
  execSync("claude --version", { stdio: "pipe" });
  hasClaude = true;
} catch {
  // claude not installed
}

const describeE2e = hasClaude ? describe : describe.skip;

describeE2e("e2e pipeline", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "sparkflow-e2e-"));
    // Initialize a minimal package.json so node can resolve modules
    execSync("npm init -y", { cwd: workDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it(
    "author writes code, tester runs it",
    async () => {
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "e2e-test",
        entry: "author",
        defaults: {
          max_retries: 1,
        },
        steps: {
          author: {
            name: "Author",
            interactive: false,
            runtime: {
              type: "claude-code",
              model: "sonnet",
              auto_accept: true,
            },
            prompt: [
              "Write a file called add.js in the current directory with a function that adds two numbers and exports it via module.exports.",
              "Then write a file called add.test.js that requires ./add.js, calls add(2, 3), and asserts the result is 5.",
              "The test file should use console.assert and print 'PASS' if all assertions pass.",
              "Do not use any test framework. Just plain Node.js.",
              "Do not create any other files.",
            ].join(" "),
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
            timeout: 30,
            outputs: {
              results: { type: "text" },
            },
          },
        },
      };

      const engine = new WorkflowEngine(workflow, {
        cwd: workDir,
        workflowDir: workDir,
      });

      const result = await engine.run();

      // Verify files were created
      expect(existsSync(join(workDir, "add.js"))).toBe(true);
      expect(existsSync(join(workDir, "add.test.js"))).toBe(true);

      // Verify the pipeline succeeded
      expect(result.success).toBe(true);
      expect(result.stepResults.get("author")?.state).toBe("succeeded");
      expect(result.stepResults.get("tester")?.state).toBe("succeeded");
    },
    { timeout: 120_000 }
  );

  it(
    "plan is provided to all steps",
    async () => {
      const workflow: SparkflowWorkflow = {
        version: "1",
        name: "e2e-plan-test",
        entry: "author",
        defaults: {
          max_retries: 1,
        },
        steps: {
          author: {
            name: "Author",
            interactive: false,
            runtime: {
              type: "claude-code",
              model: "sonnet",
              auto_accept: true,
            },
            // No step-level prompt — the plan is the only instruction
            on_success: [{ step: "tester" }],
          },
          tester: {
            name: "Tester",
            interactive: false,
            runtime: {
              type: "shell",
              command: "node",
              args: ["multiply.test.js"],
            },
            timeout: 30,
          },
        },
      };

      const plan = [
        "Write a file called multiply.js that exports a function multiply(a, b) which returns a * b.",
        "Write a file called multiply.test.js that requires ./multiply.js,",
        "calls multiply(3, 4), asserts the result is 12 using console.assert,",
        "and prints 'PASS' if all assertions pass.",
        "Do not use any test framework. Just plain Node.js.",
        "Do not create any other files.",
      ].join(" ");

      const engine = new WorkflowEngine(workflow, {
        cwd: workDir,
        workflowDir: workDir,
        plan,
      });

      const result = await engine.run();

      expect(existsSync(join(workDir, "multiply.js"))).toBe(true);
      expect(existsSync(join(workDir, "multiply.test.js"))).toBe(true);
      expect(result.success).toBe(true);
      expect(result.stepResults.get("author")?.state).toBe("succeeded");
      expect(result.stepResults.get("tester")?.state).toBe("succeeded");
    },
    { timeout: 120_000 }
  );
});
