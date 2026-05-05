import { describe, it, expect } from "vitest";
import { extractPastedImageRefs } from "../../src/dashboard/paste-refs.js";

describe("extractPastedImageRefs", () => {
  it("returns [] for empty string", () => {
    expect(extractPastedImageRefs("")).toEqual([]);
  });

  it("returns [] for plain text with no refs", () => {
    expect(extractPastedImageRefs("fix the login page")).toEqual([]);
  });

  it("extracts a single .png ref", () => {
    expect(extractPastedImageRefs("see @.sparkflow/pasted/2026-01-01T00-00-00-000Z-abcd1234.png")).toEqual([
      ".sparkflow/pasted/2026-01-01T00-00-00-000Z-abcd1234.png",
    ]);
  });

  it("extracts a single .jpg ref", () => {
    expect(extractPastedImageRefs("@.sparkflow/pasted/img.jpg")).toEqual([".sparkflow/pasted/img.jpg"]);
  });

  it("extracts a single .jpeg ref", () => {
    expect(extractPastedImageRefs("@.sparkflow/pasted/img.jpeg")).toEqual([".sparkflow/pasted/img.jpeg"]);
  });

  it("extracts a single .gif ref", () => {
    expect(extractPastedImageRefs("@.sparkflow/pasted/img.gif")).toEqual([".sparkflow/pasted/img.gif"]);
  });

  it("extracts a single .webp ref", () => {
    expect(extractPastedImageRefs("@.sparkflow/pasted/img.webp")).toEqual([".sparkflow/pasted/img.webp"]);
  });

  it("extracts multiple refs interleaved with prose", () => {
    const text = `
Fix the layout issue shown in @.sparkflow/pasted/before.png
and make it look like @.sparkflow/pasted/after.jpg instead.
    `.trim();
    expect(extractPastedImageRefs(text)).toEqual([
      ".sparkflow/pasted/before.png",
      ".sparkflow/pasted/after.jpg",
    ]);
  });

  it("deduplicates repeated refs", () => {
    const text = "@.sparkflow/pasted/foo.png and again @.sparkflow/pasted/foo.png";
    expect(extractPastedImageRefs(text)).toEqual([".sparkflow/pasted/foo.png"]);
  });

  it("ignores refs with disallowed extensions", () => {
    expect(extractPastedImageRefs("@.sparkflow/pasted/script.exe")).toEqual([]);
    expect(extractPastedImageRefs("@.sparkflow/pasted/data.json")).toEqual([]);
    expect(extractPastedImageRefs("@.sparkflow/pasted/binary.bin")).toEqual([]);
  });

  it("ignores a path-traversal attempt", () => {
    // The regex only matches filenames without slashes after the directory
    expect(extractPastedImageRefs("@.sparkflow/pasted/../etc/passwd.png")).toEqual([]);
  });

  it("matches ref at start of line", () => {
    expect(extractPastedImageRefs("@.sparkflow/pasted/start.png do this")).toEqual([
      ".sparkflow/pasted/start.png",
    ]);
  });

  it("matches ref at end of line", () => {
    expect(extractPastedImageRefs("see this @.sparkflow/pasted/end.png")).toEqual([
      ".sparkflow/pasted/end.png",
    ]);
  });
});
