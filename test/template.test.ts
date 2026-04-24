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

  it("returns placeholder when referencing a step with no outputs", () => {
    const outputs = new Map<string, Record<string, unknown>>();
    const result = resolveTemplate("${steps.missing.output.x}", outputs);
    expect(result).toBe('<sparkflow:missing-step step="missing">');
  });

  it("returns placeholder when referencing a non-existent output field", () => {
    const outputs = new Map([["author", { summary: "ok" }]]);
    const result = resolveTemplate("${steps.author.output.missing}", outputs);
    expect(result).toBe('<sparkflow:missing-output step="author" field="missing">');
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

  it("resolves ${item} to the JSON-stringified item", () => {
    const outputs = new Map<string, Record<string, unknown>>();
    const result = resolveTemplate("${item}", outputs, { id: 1 });
    expect(result).toBe('{"id":1}');
  });

  it("resolves ${item.field} to a string field", () => {
    const outputs = new Map<string, Record<string, unknown>>();
    const result = resolveTemplate("name: ${item.name}", outputs, { name: "alice" });
    expect(result).toBe("name: alice");
  });

  it("resolves nested ${item.a.b}", () => {
    const outputs = new Map<string, Record<string, unknown>>();
    const result = resolveTemplate("${item.issue.number}", outputs, { issue: { number: 42 } });
    expect(result).toBe("42");
  });

  it("ignores ${item} when no item context is provided", () => {
    const outputs = new Map<string, Record<string, unknown>>();
    const result = resolveTemplate("${item.name}", outputs);
    expect(result).toBe("${item.name}");
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
