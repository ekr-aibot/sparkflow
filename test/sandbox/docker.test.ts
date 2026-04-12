import { describe, it, expect } from "vitest";
import { DockerBackend } from "../../src/sandbox/docker.js";
import { execFileSync } from "node:child_process";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

const runIf = dockerAvailable() ? describe : describe.skip;

runIf("DockerBackend", () => {
  const backend = new DockerBackend();

  it("spawns a container, execs a command, and disposes", async () => {
    const sandbox = await backend.create({
      stepId: "t",
      step: { name: "t", interactive: false },
      workspaceHostPath: process.cwd(),
      env: { FOO: "bar" },
      config: { type: "docker", image: "alpine:latest" },
    });

    try {
      expect(sandbox.kind).toBe("docker");
      expect(sandbox.id).toMatch(/^[a-f0-9]{12,}$/);

      const child = sandbox.spawn({
        command: "sh",
        args: ["-c", "echo $FOO && pwd"],
        stdio: "pipe",
      });
      const out = await new Promise<string>((resolve, reject) => {
        let buf = "";
        child.stdout?.on("data", (d: Buffer) => { buf += d.toString(); });
        child.on("close", () => resolve(buf));
        child.on("error", reject);
      });
      // FOO should be visible via -e passthrough, and cwd should be /workspace.
      expect(out).toContain("bar");
      expect(out).toContain("/workspace");
    } finally {
      await sandbox.dispose();
    }

    // After dispose the container should be gone.
    let exists = true;
    try {
      execFileSync("docker", ["inspect", sandbox.id], { stdio: "pipe" });
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  }, 30_000);

  it("mcpStdioCommand targets docker exec + in-container node", async () => {
    const sandbox = await backend.create({
      stepId: "t",
      step: { name: "t", interactive: false },
      workspaceHostPath: process.cwd(),
      env: {},
      config: { type: "docker", image: "alpine:latest" },
    });
    try {
      const cmd = sandbox.mcpStdioCommand();
      expect(cmd.command).toBe("docker");
      expect(cmd.args).toContain("exec");
      expect(cmd.args).toContain("-i");
      expect(cmd.args).toContain(sandbox.id);
      expect(cmd.args).toContain("node");
      expect(cmd.args.at(-1)).toBe("/opt/sparkflow/src/mcp/server.js");
    } finally {
      await sandbox.dispose();
    }
  }, 30_000);
});
