import { describe, it, expect } from "vitest";
import { LocalBackend } from "../../src/sandbox/local.js";

describe("LocalBackend", () => {
  const backend = new LocalBackend();

  it("spawn runs a command on the host", async () => {
    const sandbox = await backend.create({
      stepId: "t",
      step: { name: "t", interactive: false },
      workspaceHostPath: process.cwd(),
      env: {},
      config: { type: "local" },
    });
    const child = sandbox.spawn({ command: "echo", args: ["hi"], stdio: "pipe" });
    const out = await new Promise<string>((resolve, reject) => {
      let buf = "";
      child.stdout?.on("data", (d: Buffer) => { buf += d.toString(); });
      child.on("close", () => resolve(buf));
      child.on("error", reject);
    });
    expect(out.trim()).toBe("hi");
    await sandbox.dispose();
  });

  it("spawn passes env vars to the child", async () => {
    const sandbox = await backend.create({
      stepId: "t",
      step: { name: "t", interactive: false },
      workspaceHostPath: process.cwd(),
      env: { FOO: "bar" },
      config: { type: "local" },
    });
    const child = sandbox.spawn({
      command: "sh",
      args: ["-c", "echo $FOO"],
      stdio: "pipe",
    });
    const out = await new Promise<string>((resolve) => {
      let buf = "";
      child.stdout?.on("data", (d: Buffer) => { buf += d.toString(); });
      child.on("close", () => resolve(buf));
    });
    expect(out.trim()).toBe("bar");
    await sandbox.dispose();
  });

  it("mcpStdioCommand points at the local MCP server", async () => {
    const sandbox = await backend.create({
      stepId: "t",
      step: { name: "t", interactive: true },
      workspaceHostPath: process.cwd(),
      env: {},
      ipcSocketHostPath: "/tmp/foo.sock",
      config: { type: "local" },
    });
    const cmd = sandbox.mcpStdioCommand();
    expect(cmd.command).toBe("node");
    expect(cmd.args[0]).toMatch(/mcp\/server\.js$/);
    expect(cmd.env?.SPARKFLOW_SOCKET).toBe("/tmp/foo.sock");
    await sandbox.dispose();
  });

  it("kind and id reflect local backend", async () => {
    const sandbox = await backend.create({
      stepId: "t",
      step: { name: "t", interactive: false },
      workspaceHostPath: process.cwd(),
      env: {},
      config: { type: "local" },
    });
    expect(sandbox.kind).toBe("local");
    expect(sandbox.id).toBe("local");
    await sandbox.dispose();
  });
});
