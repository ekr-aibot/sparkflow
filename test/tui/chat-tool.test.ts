import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
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
    slashCommands: {},
  };
}

describe("buildChatSpawn", () => {
  it("claude path passes --mcp-config and --append-system-prompt flags and writes slash commands", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-chat-test-"));
    try {
      const opts = {
        ...baseOpts(tmp),
        tool: "claude" as const,
        command: "claude",
        slashCommands: {
          "sf-plan": { body: "Plan: $ARGUMENTS", description: "Planning mode" },
        },
      };
      const spawn = buildChatSpawn(opts);
      expect(spawn.cmd).toBe("claude");
      expect(spawn.args).toEqual([
        "--extra", "42",
        "--mcp-config", "/tmp/mcp-config.json",
        "--append-system-prompt", "You are helpful.",
      ]);

      const planFile = join(tmp, ".claude", "commands", "sf-plan.md");
      expect(existsSync(planFile)).toBe(true);
      expect(readFileSync(planFile, "utf-8")).toBe("Plan: $ARGUMENTS");

      spawn.cleanup();
      expect(existsSync(planFile)).toBe(false);
      expect(existsSync(join(tmp, ".claude"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gemini path writes .gemini/settings.json and GEMINI.md, and slash commands in TOML format", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-chat-test-"));
    try {
      const opts = {
        ...baseOpts(tmp),
        tool: "gemini" as const,
        command: "npx",
        slashCommands: {
          "sf-plan": { body: "Plan: $ARGUMENTS", description: "Planning mode" },
        },
      };
      const spawn = buildChatSpawn(opts);
      expect(spawn.cmd).toBe("npx");

      const planFile = join(tmp, ".gemini", "commands", "project", "sf-plan.toml");
      expect(existsSync(planFile)).toBe(true);
      const content = readFileSync(planFile, "utf-8");
      expect(content).toContain('description = "Planning mode"');
      expect(content).toContain("prompt = '''");
      expect(content).toContain("Plan: {{args}}");

      spawn.cleanup();
      expect(existsSync(planFile)).toBe(false);
      expect(existsSync(join(tmp, ".gemini"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gemini slash command cleanup restores pre-existing command files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-chat-test-"));
    try {
      const geminiDir = join(tmp, ".gemini", "commands", "project");
      mkdirSync(geminiDir, { recursive: true });
      const planFile = join(geminiDir, "sf-plan.toml");
      writeFileSync(planFile, "ORIGINAL_PLAN");

      const opts = {
        ...baseOpts(tmp),
        tool: "gemini" as const,
        command: "npx",
        slashCommands: {
          "sf-plan": { body: "NEW_PLAN", description: "New plan" },
        },
      };
      const spawn = buildChatSpawn(opts);
      expect(readFileSync(planFile, "utf-8")).toContain("NEW_PLAN");

      spawn.cleanup();
      expect(readFileSync(planFile, "utf-8")).toBe("ORIGINAL_PLAN");
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
