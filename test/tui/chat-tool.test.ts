import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildChatSpawn } from "../../src/tui/chat-tool.js";

function baseOpts(tmp: string) {
  return {
    command: "", // overridden per test
    chatArgs: ["--extra", "42"],
    mcpServerSpec: {
      command: "node",
      args: ["/path/to/mcp-bridge.js"],
      env: { SPARKFLOW_DASHBOARD_SOCKET: "/tmp/fake.sock" },
    },
    mcpServerName: "sparkflow-dashboard",
    mcpConfigPath: "/tmp/mcp-config.json",
    systemPromptText: "You are helpful.",
    systemPromptPath: "/tmp/system-prompt.txt",
    cwd: tmp,
  };
}

describe("buildChatSpawn", () => {
  it("claude path passes --mcp-config and --append-system-prompt flags", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-chat-test-"));
    try {
      const spawn = buildChatSpawn({ ...baseOpts(tmp), tool: "claude", command: "claude" });
      expect(spawn.cmd).toBe("claude");
      expect(spawn.args).toEqual([
        "--extra", "42",
        "--mcp-config", "/tmp/mcp-config.json",
        "--append-system-prompt", "You are helpful.",
      ]);
      expect(spawn.shellCmd).toContain("--mcp-config");
      expect(spawn.shellCmd).toContain("--append-system-prompt");
      expect(spawn.shellCmd).toContain("$(cat '/tmp/system-prompt.txt')");
      // No side effects.
      expect(existsSync(join(tmp, ".gemini"))).toBe(false);
      expect(existsSync(join(tmp, "GEMINI.md"))).toBe(false);
      spawn.cleanup();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gemini path writes .gemini/settings.json and GEMINI.md, with npx + -y prefix when command is npx", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-chat-test-"));
    try {
      const spawn = buildChatSpawn({ ...baseOpts(tmp), tool: "gemini", command: "npx" });
      expect(spawn.cmd).toBe("npx");
      expect(spawn.args[0]).toBe("@google/gemini-cli@latest");
      expect(spawn.args[1]).toBe("-y");
      expect(spawn.args).toContain("--extra");
      // No Claude-specific flags.
      expect(spawn.args).not.toContain("--mcp-config");
      expect(spawn.args).not.toContain("--append-system-prompt");

      const settings = JSON.parse(readFileSync(join(tmp, ".gemini", "settings.json"), "utf-8"));
      expect(settings.mcpServers["sparkflow-dashboard"].command).toBe("node");
      expect(readFileSync(join(tmp, "GEMINI.md"), "utf-8")).toBe("You are helpful.");

      spawn.cleanup();
      expect(existsSync(join(tmp, ".gemini"))).toBe(false);
      expect(existsSync(join(tmp, "GEMINI.md"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gemini cleanup restores a pre-existing GEMINI.md instead of deleting it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-chat-test-"));
    try {
      writeFileSync(join(tmp, "GEMINI.md"), "USER_ORIGINAL");
      const spawn = buildChatSpawn({ ...baseOpts(tmp), tool: "gemini", command: "npx" });
      // During the run, our system prompt is active.
      expect(readFileSync(join(tmp, "GEMINI.md"), "utf-8")).toBe("You are helpful.");
      spawn.cleanup();
      expect(readFileSync(join(tmp, "GEMINI.md"), "utf-8")).toBe("USER_ORIGINAL");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gemini path with a non-npx binary passes chatArgs through unchanged", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-chat-test-"));
    try {
      const spawn = buildChatSpawn({ ...baseOpts(tmp), tool: "gemini", command: "/usr/bin/gemini" });
      expect(spawn.cmd).toBe("/usr/bin/gemini");
      // No npx prefix, no injected -y — trust the user's chatArgs.
      expect(spawn.args).toEqual(["--extra", "42"]);
      spawn.cleanup();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
