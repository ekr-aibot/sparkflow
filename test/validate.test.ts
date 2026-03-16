import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/schema/validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadExample(name: string): unknown {
  const path = resolve(__dirname, "..", "examples", name);
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("validate", () => {
  describe("feature-development.json example", () => {
    it("passes schema and semantic validation", () => {
      const workflow = loadExample("feature-development.json");
      const result = validate(workflow);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  });

  describe("JSON Schema validation", () => {
    it("rejects missing required fields", () => {
      const result = validate({});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects invalid version", () => {
      const result = validate({
        version: "2",
        name: "test",
        entry: "a",
        steps: {
          a: { name: "A", interactive: false, runtime: { type: "shell", command: "echo" } },
        },
      });
      expect(result.valid).toBe(false);
    });

    it("rejects empty steps", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {},
      });
      expect(result.valid).toBe(false);
    });

    it("rejects invalid step ID characters", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a b",
        steps: {
          "a b": { name: "A", interactive: false, runtime: { type: "shell", command: "echo" } },
        },
      });
      expect(result.valid).toBe(false);
    });

    it("rejects unknown runtime type", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: { name: "A", interactive: false, runtime: { type: "unknown" } },
        },
      });
      expect(result.valid).toBe(false);
    });

    it("accepts all three runtime types", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: {
            name: "A",
            interactive: true,
            runtime: { type: "claude-code", model: "sonnet" },
            on_success: [{ step: "b" }, { step: "c" }],
          },
          b: {
            name: "B",
            interactive: false,
            runtime: { type: "shell", command: "npm", args: ["test"] },
            on_success: [{ step: "c" }],
          },
          c: {
            name: "C",
            interactive: false,
            runtime: { type: "custom", adapter: "./my-adapter" },
            join: ["a", "b"],
          },
        },
      });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  });

  describe("semantic validation", () => {
    function minimal(overrides: Record<string, unknown> = {}) {
      return {
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: { name: "A", interactive: false, runtime: { type: "shell", command: "echo" } },
        },
        ...overrides,
      };
    }

    it("errors when entry points to non-existent step", () => {
      const result = validate(minimal({ entry: "nonexistent" }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("nonexistent") })
      );
    });

    it("errors when transition references non-existent step", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: {
            name: "A",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_success: [{ step: "missing" }],
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("missing") })
      );
    });

    it("errors when join references non-existent step", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: {
            name: "A",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_success: [{ step: "b" }],
          },
          b: {
            name: "B",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            join: ["a", "nonexistent"],
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("nonexistent") })
      );
    });

    it("warns about unreachable steps", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: { name: "A", interactive: false, runtime: { type: "shell", command: "echo" } },
          orphan: { name: "Orphan", interactive: false, runtime: { type: "shell", command: "echo" } },
        },
      });
      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("orphan") })
      );
    });

    it("errors when template references non-existent step", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: {
            name: "A",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            prompt: "Results: ${steps.missing.output.data}",
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("missing") })
      );
    });

    it("warns when template references undeclared output", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: {
            name: "A",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_success: [{ step: "b" }],
            outputs: { summary: { type: "text" } },
          },
          b: {
            name: "B",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            prompt: "Got: ${steps.a.output.nonexistent}",
          },
        },
      });
      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("nonexistent") })
      );
    });

    it("validates templates in transition messages", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: {
            name: "A",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_failure: [{ step: "a", message: "Error: ${steps.ghost.output.log}" }],
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("ghost") })
      );
    });

    it("errors when step has no runtime and no default runtime", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: { name: "A", interactive: false },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("no runtime") })
      );
    });

    it("errors when parallel siblings have on_failure targeting different steps", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: {
            name: "A",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_success: [{ step: "b" }, { step: "c" }],
          },
          b: {
            name: "B",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_failure: [{ step: "a" }],
          },
          c: {
            name: "C",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_failure: [{ step: "d" }],
          },
          d: {
            name: "D",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("Parallel") })
      );
    });

    it("accepts non-parallel steps with on_failure targeting different steps", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: {
            name: "A",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_success: [{ step: "b" }],
            on_failure: [{ step: "a" }],
          },
          b: {
            name: "B",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_failure: [{ step: "c" }],
          },
          c: {
            name: "C",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
          },
        },
      });
      expect(result.valid).toBe(true);
    });

    it("accepts when all parallel siblings on_failure target the same step", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        steps: {
          a: {
            name: "A",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_success: [{ step: "b" }, { step: "c" }],
          },
          b: {
            name: "B",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_failure: [{ step: "a" }],
          },
          c: {
            name: "C",
            interactive: false,
            runtime: { type: "shell", command: "echo" },
            on_failure: [{ step: "a" }],
          },
        },
      });
      expect(result.valid).toBe(true);
    });

    it("accepts step without runtime when defaults.runtime is set", () => {
      const result = validate({
        version: "1",
        name: "test",
        entry: "a",
        defaults: { runtime: { type: "shell", command: "echo" } },
        steps: {
          a: { name: "A", interactive: false },
        },
      });
      expect(result.valid).toBe(true);
    });
  });
});
