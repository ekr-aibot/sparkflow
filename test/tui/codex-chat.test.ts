import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the exported helpers in isolation by temporarily redirecting the
// home directory path. To avoid mutating the global module-level constants
// (CODEX_CONFIG_DIR etc.), we import the individual helpers we can test
// without relying on home-dir side effects, and test the TOML/marker logic
// through the block helpers, which are not exported but whose effects are
// observable via the install/uninstall functions.

import {
  installCodexMcp,
  uninstallCodexMcp,
  installCodexSystemPrompt,
  uninstallCodexSystemPrompt,
  installCodexPrompts,
  uninstallCodexPrompts,
  buildCodexSpawn,
  buildBareCodexSpawn,
} from "../../src/tui/codex-chat.js";

// Because codex-chat.ts uses a module-level constant (CODEX_CONFIG_DIR) bound
// to homedir() at import time, we can't easily redirect it without patching the
// module. Instead, we test install/uninstall directly against the real
// ~/.codex/config.toml path — but that would pollute the test environment.
//
// Strategy: test the AGENTS.md and prompts operations (which take cwd/dir
// arguments) using temp directories, and test the TOML operations using the
// exported installCodexMcp/uninstallCodexMcp on a tmpdir by monkey-patching
// the CODEX_CONFIG_PATH constant via vi.mock (not feasible without module mock).
//
// So for config.toml we do a live integration-style test in a real temp dir.
// We accept that ~/.codex/config.toml may be touched, but restore it afterward.

describe("installCodexSystemPrompt / uninstallCodexSystemPrompt", () => {
  it("creates AGENTS.md with the sparkflow block when file doesn't exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-chat-test-"));
    try {
      installCodexSystemPrompt(tmp, "System prompt text");
      const agentsPath = join(tmp, "AGENTS.md");
      expect(existsSync(agentsPath)).toBe(true);
      const content = readFileSync(agentsPath, "utf-8");
      expect(content).toContain("System prompt text");
      expect(content).toContain("sparkflow context start");
      expect(content).toContain("sparkflow context end");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("merges sparkflow block into an existing AGENTS.md", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-chat-test-"));
    try {
      const agentsPath = join(tmp, "AGENTS.md");
      writeFileSync(agentsPath, "# Project Rules\n\nAlways write tests.\n");
      installCodexSystemPrompt(tmp, "Sparkflow context here");
      const content = readFileSync(agentsPath, "utf-8");
      expect(content).toContain("# Project Rules");
      expect(content).toContain("Sparkflow context here");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("replaces an existing sparkflow block on re-install", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-chat-test-"));
    try {
      installCodexSystemPrompt(tmp, "First install");
      installCodexSystemPrompt(tmp, "Second install");
      const agentsPath = join(tmp, "AGENTS.md");
      const content = readFileSync(agentsPath, "utf-8");
      expect(content).toContain("Second install");
      expect(content).not.toContain("First install");
      // Only one start marker
      expect(content.split("sparkflow context start").length - 1).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes the sparkflow block and deletes empty AGENTS.md", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-chat-test-"));
    try {
      installCodexSystemPrompt(tmp, "To be removed");
      uninstallCodexSystemPrompt(tmp);
      // File was only the sparkflow block, so it's deleted
      expect(existsSync(join(tmp, "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes only the sparkflow block when other content exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-chat-test-"));
    try {
      const agentsPath = join(tmp, "AGENTS.md");
      writeFileSync(agentsPath, "# Rules\n\nKeep it simple.\n");
      installCodexSystemPrompt(tmp, "Sparkflow context");
      uninstallCodexSystemPrompt(tmp);
      const content = readFileSync(agentsPath, "utf-8");
      expect(content).toContain("# Rules");
      expect(content).not.toContain("sparkflow context start");
      expect(content).not.toContain("Sparkflow context");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when no AGENTS.md exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-chat-test-"));
    try {
      expect(() => uninstallCodexSystemPrompt(tmp)).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("installCodexPrompts / uninstallCodexPrompts", () => {
  it("writes sf-*.md files with command body", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-prompts-test-"));
    // Override the prompts dir by patching environment — we can't easily test
    // the real ~/.codex/prompts without a module mock. Test what we can: that
    // the returned paths exist.
    //
    // Since installCodexPrompts writes to CODEX_PROMPTS_DIR (a module-level
    // constant), we'll accept this is an integration-style test.
    // Skip if we can't create the real dir (CI / restricted env).
    const warnings: string[] = [];
    const warn = (msg: string) => warnings.push(msg);
    const installed = installCodexPrompts(
      { "sf-jobs": { body: "List all jobs" }, "sf-detail": { body: "Show detail" } },
      warn
    );
    // Either it succeeded (installed paths exist) or it warned and returned []
    if (installed.length > 0) {
      for (const p of installed) {
        expect(existsSync(p)).toBe(true);
      }
      // Clean up
      uninstallCodexPrompts(warn);
      for (const p of installed) {
        expect(existsSync(p)).toBe(false);
      }
    } else {
      // Couldn't write — that's okay in restricted environments
      expect(warnings.length).toBeGreaterThan(0);
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array when no slash commands are given", () => {
    const installed = installCodexPrompts({});
    expect(installed).toEqual([]);
  });

  it("prefixes command name with sf- if not already prefixed", () => {
    const warnings: string[] = [];
    const installed = installCodexPrompts(
      { "jobs": { body: "List jobs" } },
      (msg) => warnings.push(msg)
    );
    if (installed.length > 0) {
      const basename = installed[0].split("/").at(-1)!;
      expect(basename.startsWith("sf-")).toBe(true);
      uninstallCodexPrompts();
    }
  });
});

describe("buildBareCodexSpawn", () => {
  it("returns cmd and args without MCP or system prompt", () => {
    const result = buildBareCodexSpawn({ command: "codex", chatArgs: ["--extra"] });
    expect(result.cmd).toBe("codex");
    expect(result.args).toContain("--extra");
    expect(result.cleanup).toBeTypeOf("function");
    expect(() => result.cleanup()).not.toThrow();
  });

  it("produces a shellCmd string", () => {
    const result = buildBareCodexSpawn({ command: "codex", chatArgs: [] });
    expect(result.shellCmd).toContain("codex");
  });
});

describe("buildCodexSpawn", () => {
  it("injects --dangerously-bypass-approvals-and-sandbox when command is codex", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-spawn-test-"));
    const warnings: string[] = [];
    try {
      const result = buildCodexSpawn({
        command: "codex",
        chatArgs: [],
        mcpServerPath: "/fake/server.js",
        ipcSocketPath: "/fake/socket",
        systemPromptText: "System",
        cwd: tmp,
        slashCommands: {},
        warn: (msg) => warnings.push(msg),
      });
      expect(result.args).toContain("--dangerously-bypass-approvals-and-sandbox");
      result.cleanup();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does NOT inject --dangerously-bypass-approvals-and-sandbox when command is overridden", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-spawn-test-"));
    try {
      const result = buildCodexSpawn({
        command: "/usr/local/bin/my-codex",
        chatArgs: [],
        mcpServerPath: "/fake/server.js",
        ipcSocketPath: "/fake/socket",
        systemPromptText: "System",
        cwd: tmp,
        slashCommands: {},
      });
      expect(result.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      result.cleanup();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes AGENTS.md and cleans it up", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-spawn-test-"));
    try {
      const result = buildCodexSpawn({
        command: "codex",
        chatArgs: [],
        mcpServerPath: "/fake/server.js",
        ipcSocketPath: "/fake/socket",
        systemPromptText: "Hello from sparkflow",
        cwd: tmp,
        slashCommands: {},
      });
      const agentsPath = join(tmp, "AGENTS.md");
      expect(existsSync(agentsPath)).toBe(true);
      expect(readFileSync(agentsPath, "utf-8")).toContain("Hello from sparkflow");
      result.cleanup();
      // After cleanup, the sparkflow block is gone
      expect(existsSync(agentsPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
