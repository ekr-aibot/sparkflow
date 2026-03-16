import { describe, it, expect } from "vitest";
import { resolveTemplate, resolvePrompt } from "../src/engine/template.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("resolveTemplate", () => {
  it("replaces a single template reference with text output", () => {
    const outputs = new Map([["author", { summary: "Added login feature" }]]);
    const result = resolveTemplate(
      "Review: ${steps.author.output.summary}",
      outputs
    );
    expect(result).toBe("Review: Added login feature");
  });

  it("replaces multiple template references", () => {
    const outputs = new Map([
      ["author", { summary: "feat" }],
      ["reviewer", { feedback: "LGTM" }],
    ]);
    const result = resolveTemplate(
      "${steps.author.output.summary} - ${steps.reviewer.output.feedback}",
      outputs
    );
    expect(result).toBe("feat - LGTM");
  });

  it("JSON-stringifies non-string values", () => {
    const outputs = new Map([["test", { data: { passed: true, count: 5 } }]]);
    const result = resolveTemplate("Result: ${steps.test.output.data}", outputs);
    expect(result).toBe('Result: {"passed":true,"count":5}');
  });

  it("handles escaped $$ by converting to literal ${", () => {
    const outputs = new Map<string, Record<string, unknown>>();
    const result = resolveTemplate("literal: $${steps.foo.output.bar}", outputs);
    expect(result).toBe("literal: ${steps.foo.output.bar}");
  });

  it("throws when referencing a step with no outputs", () => {
    const outputs = new Map<string, Record<string, unknown>>();
    expect(() =>
      resolveTemplate("${steps.missing.output.x}", outputs)
    ).toThrow('Template references step "missing" which has no outputs');
  });

  it("throws when referencing a non-existent output field", () => {
    const outputs = new Map([["author", { summary: "ok" }]]);
    expect(() =>
      resolveTemplate("${steps.author.output.missing}", outputs)
    ).toThrow(
      'Template references output "missing" on step "author" which does not exist'
    );
  });

  it("returns text unchanged when no templates present", () => {
    const outputs = new Map<string, Record<string, unknown>>();
    const result = resolveTemplate("plain text", outputs);
    expect(result).toBe("plain text");
  });

  it("handles numeric output values", () => {
    const outputs = new Map([["step1", { count: 42 }]]);
    const result = resolveTemplate("Count: ${steps.step1.output.count}", outputs);
    expect(result).toBe("Count: 42");
  });
});

describe("resolvePrompt", () => {
  const tmpDir = join(process.cwd(), "test", ".tmp-prompt-test");

  it("returns inline text as-is", () => {
    const result = resolvePrompt("You are a code reviewer", "/some/dir");
    expect(result).toBe("You are a code reviewer");
  });

  it("reads file when prompt starts with ./", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "prompt.txt"), "file prompt content");
    try {
      const result = resolvePrompt("./prompt.txt", tmpDir);
      expect(result).toBe("file prompt content");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads file when prompt ends with .md", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "instructions.md"), "# Instructions\nDo stuff");
    try {
      const result = resolvePrompt("instructions.md", tmpDir);
      expect(result).toBe("# Instructions\nDo stuff");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
