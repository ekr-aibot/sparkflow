import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, existsSync, utimesSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOldPastedImages } from "../src/web/prune-pasted.js";

describe("pruneOldPastedImages", () => {
  it("deletes files older than maxAgeMs and keeps fresh files", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-test-"));
    const pastedDir = join(dir, ".sparkflow", "pasted");
    mkdirSync(pastedDir, { recursive: true });

    const oldFile = join(pastedDir, "old.png");
    const newFile = join(pastedDir, "new.png");
    writeFileSync(oldFile, "old");
    writeFileSync(newFile, "new");

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    try {
      pruneOldPastedImages(dir);
      expect(existsSync(oldFile)).toBe(false);
      expect(existsSync(newFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing when the pasted directory does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-test-"));
    try {
      expect(() => pruneOldPastedImages(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects a custom maxAgeMs", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-test-"));
    const pastedDir = join(dir, ".sparkflow", "pasted");
    mkdirSync(pastedDir, { recursive: true });

    const file = join(pastedDir, "file.png");
    writeFileSync(file, "data");

    // Set mtime to 2 seconds ago; prune with a 1 second window → should delete.
    const twoSecsAgo = new Date(Date.now() - 2000);
    utimesSync(file, twoSecsAgo, twoSecsAgo);

    try {
      pruneOldPastedImages(dir, 1000);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
