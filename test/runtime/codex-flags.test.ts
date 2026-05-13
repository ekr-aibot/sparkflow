import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodexArgs,
  writeCodexMcpConfig,
  extractCodexSessionId,
  isCodexQuotaError,
  isCodexTokenLimitError,
  codexUserMessage,
} from "../../src/runtime/codex-flags.js";

describe("buildCodexArgs", () => {
  it("includes --dangerously-bypass-approvals-and-sandbox and --json", () => {
    const args = buildCodexArgs({ type: "codex" });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--json");
  });

  it("includes --model when set", () => {
    const args = buildCodexArgs({ type: "codex", model: "o4-mini" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("o4-mini");
  });

  it("does not include --model when unset", () => {
    const args = buildCodexArgs({ type: "codex" });
    expect(args).not.toContain("--model");
  });

  it("includes --config-file when mcpConfigPath is provided", () => {
    const args = buildCodexArgs({ type: "codex" }, { mcpConfigPath: "/tmp/config.toml" });
    expect(args).toContain("--config-file");
    expect(args[args.indexOf("--config-file") + 1]).toBe("/tmp/config.toml");
  });

  it("appends extra runtime.args", () => {
    const args = buildCodexArgs({ type: "codex", args: ["--verbose", "--timeout", "60"] });
    expect(args).toContain("--verbose");
    expect(args).toContain("--timeout");
    expect(args).toContain("60");
  });
});

describe("writeCodexMcpConfig", () => {
  it("creates a TOML file with the sparkflow MCP block", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-flags-test-"));
    try {
      const configPath = writeCodexMcpConfig(tmp, "/tmp/sparkflow.sock");
      const content = readFileSync(configPath, "utf-8");
      expect(content).toContain("[mcp_servers.sparkflow]");
      expect(content).toContain("command = \"node\"");
      expect(content).toContain("/tmp/sparkflow.sock");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes to tmpDir/codex-config.toml", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sparkflow-codex-flags-test-"));
    try {
      const configPath = writeCodexMcpConfig(tmp, "/tmp/s.sock");
      expect(configPath).toBe(join(tmp, "codex-config.toml"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("extractCodexSessionId", () => {
  it("extracts session_id field", () => {
    expect(extractCodexSessionId({ type: "result", session_id: "abc-123" })).toBe("abc-123");
  });

  it("extracts sessionId camelCase field", () => {
    expect(extractCodexSessionId({ type: "result", sessionId: "def-456" })).toBe("def-456");
  });

  it("extracts session_id from nested meta", () => {
    expect(extractCodexSessionId({ type: "result", meta: { session_id: "ghi-789" } })).toBe("ghi-789");
  });

  it("extracts thread_id field", () => {
    expect(extractCodexSessionId({ type: "thread.started", thread_id: "jkl-012" })).toBe("jkl-012");
  });

  it("returns undefined when no session id is present", () => {
    expect(extractCodexSessionId({ type: "result" })).toBeUndefined();
  });

  it("returns undefined for empty string session_id", () => {
    expect(extractCodexSessionId({ session_id: "" })).toBeUndefined();
  });
});

describe("isCodexQuotaError", () => {
  it("detects rate limit", () => {
    expect(isCodexQuotaError("Error: rate limit exceeded")).toBe(true);
  });

  it("detects quota exceeded", () => {
    expect(isCodexQuotaError("quota exceeded for this key")).toBe(true);
  });

  it("detects too many requests", () => {
    expect(isCodexQuotaError("429 too many requests")).toBe(true);
  });

  it("detects resource exhausted", () => {
    expect(isCodexQuotaError("RESOURCE_EXHAUSTED: daily quota exceeded")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isCodexQuotaError("network timeout")).toBe(false);
    expect(isCodexQuotaError("exit code 1")).toBe(false);
    expect(isCodexQuotaError("")).toBe(false);
  });
});

describe("isCodexTokenLimitError", () => {
  it("detects context length exceeded", () => {
    expect(isCodexTokenLimitError("context length exceeded")).toBe(true);
  });

  it("detects context window exceeded", () => {
    expect(isCodexTokenLimitError("context window exceeded")).toBe(true);
  });

  it("detects context_length_exceeded", () => {
    expect(isCodexTokenLimitError("context_length_exceeded")).toBe(true);
  });

  it("detects input too long", () => {
    expect(isCodexTokenLimitError("input is too long for this model")).toBe(true);
  });

  it("detects maximum context", () => {
    expect(isCodexTokenLimitError("maximum context reached")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isCodexTokenLimitError("rate limit exceeded")).toBe(false);
    expect(isCodexTokenLimitError("exit code 1")).toBe(false);
    expect(isCodexTokenLimitError("")).toBe(false);
  });
});

describe("codexUserMessage", () => {
  it("returns plain text", () => {
    const text = codexUserMessage("hello world");
    expect(text).toBe("hello world");
  });
});
