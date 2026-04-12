import type { SandboxHandle } from "../../src/sandbox/types.js";

/** A stub SandboxHandle for tests that don't actually exercise sandbox spawn. */
export const stubSandbox: SandboxHandle = {
  id: "stub",
  kind: "local",
  spawn() {
    throw new Error("stubSandbox.spawn called — test should not spawn");
  },
  mcpStdioCommand() {
    return { command: "node", args: [] };
  },
  async dispose() {},
};
