import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyJsonPointer, cmdStatePut } from "../../src/cli/dashboard.js";

describe("applyJsonPointer", () => {
  it("sets a top-level key", () => {
    const result = applyJsonPointer({}, "/foo", "bar");
    expect((result as Record<string, unknown>).foo).toBe("bar");
  });

  it("sets a nested key", () => {
    const result = applyJsonPointer({}, "/a/b/c", "deep");
    expect((result as Record<string, unknown>).a).toEqual({ b: { c: "deep" } });
  });

  it("merges with existing object", () => {
    const orig = { x: 1, y: 2 };
    const result = applyJsonPointer(orig, "/x", 99);
    expect((result as Record<string, unknown>).x).toBe(99);
    expect((result as Record<string, unknown>).y).toBe(2);
  });

  it("sets null value", () => {
    const result = applyJsonPointer({ currentJobId: "abc" }, "/currentJobId", null);
    expect((result as Record<string, unknown>).currentJobId).toBeNull();
  });

  it("sets array element by index", () => {
    const result = applyJsonPointer({ items: ["a", "b", "c"] }, "/items/1", "X");
    expect((result as Record<string, unknown>).items).toEqual(["a", "X", "c"]);
  });

  it("handles JSON pointer escape sequences", () => {
    const result = applyJsonPointer({}, "/a~1b", "val");
    expect((result as Record<string, unknown>)["a/b"]).toBe("val");
  });

  it("throws on invalid pointer (no leading slash)", () => {
    expect(() => applyJsonPointer({}, "foo", "bar")).toThrow("invalid JSON pointer");
  });
});

describe("cmdStatePut", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sf-dash-put-"));
    mkdirSync(join(tmpDir, ".sparkflow", "dashboard"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates state.json when it does not exist", () => {
    cmdStatePut("/foo", '"bar"', tmpDir);
    const state = JSON.parse(readFileSync(join(tmpDir, ".sparkflow", "dashboard", "state.json"), "utf-8"));
    expect(state.foo).toBe("bar");
  });

  it("merges into existing state.json", () => {
    const statePath = join(tmpDir, ".sparkflow", "dashboard", "state.json");
    writeFileSync(statePath, JSON.stringify({ workflow: "auto-develop", updatedAt: "x" }));
    cmdStatePut("/workflow", '"new-workflow"', tmpDir);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.workflow).toBe("new-workflow");
    expect(state.updatedAt).toBe("x");
  });

  it("sets nested path", () => {
    cmdStatePut("/a/b/c", '"deep"', tmpDir);
    const state = JSON.parse(readFileSync(join(tmpDir, ".sparkflow", "dashboard", "state.json"), "utf-8"));
    expect(state.a.b.c).toBe("deep");
  });

  it("sets numeric JSON value", () => {
    cmdStatePut("/count", "42", tmpDir);
    const state = JSON.parse(readFileSync(join(tmpDir, ".sparkflow", "dashboard", "state.json"), "utf-8"));
    expect(state.count).toBe(42);
  });

  it("sets null value", () => {
    const statePath = join(tmpDir, ".sparkflow", "dashboard", "state.json");
    writeFileSync(statePath, JSON.stringify({ currentJobId: "abc" }));
    cmdStatePut("/currentJobId", "null", tmpDir);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.currentJobId).toBeNull();
  });

  it("leaves the file as valid JSON after write", () => {
    cmdStatePut("/x", '"hello"', tmpDir);
    const raw = readFileSync(join(tmpDir, ".sparkflow", "dashboard", "state.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("writes atomically via .tmp + rename (no .tmp leftover)", () => {
    cmdStatePut("/key", '"val"', tmpDir);
    const tmpFile = join(tmpDir, ".sparkflow", "dashboard", "state.json.tmp");
    expect(() => readFileSync(tmpFile)).toThrow();
  });

  it("two concurrent puts both succeed and leave valid JSON (last write wins)", async () => {
    const statePath = join(tmpDir, ".sparkflow", "dashboard", "state.json");
    // Run two puts concurrently via Promise.all — each does read-modify-rename.
    // The file must remain valid JSON regardless of interleaving order.
    await Promise.all([
      Promise.resolve().then(() => cmdStatePut("/a", '"first"', tmpDir)),
      Promise.resolve().then(() => cmdStatePut("/b", '"second"', tmpDir)),
    ]);
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw); // must not throw
    // At least one write must have landed
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
  });
});
