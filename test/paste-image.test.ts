import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneOldPastedImages } from "../src/web/paste-utils.js";

describe("pruneOldPastedImages", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("removes files older than maxAgeMs", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "prune-test-"));
    const pastedDir = join(tmpDir, ".sparkflow", "pasted");
    mkdirSync(pastedDir, { recursive: true });

    const oldFile = join(pastedDir, "old.png");
    const freshFile = join(pastedDir, "fresh.png");
    writeFileSync(oldFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(freshFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    pruneOldPastedImages(tmpDir, 7 * 24 * 60 * 60 * 1000);

    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  it("keeps files younger than maxAgeMs", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "prune-test-"));
    const pastedDir = join(tmpDir, ".sparkflow", "pasted");
    mkdirSync(pastedDir, { recursive: true });

    const recentFile = join(pastedDir, "recent.png");
    writeFileSync(recentFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(recentFile, threeDaysAgo, threeDaysAgo);

    pruneOldPastedImages(tmpDir, 7 * 24 * 60 * 60 * 1000);

    expect(existsSync(recentFile)).toBe(true);
  });

  it("does nothing when pasted directory does not exist", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "prune-test-"));
    const dir = tmpDir;
    expect(() => pruneOldPastedImages(dir)).not.toThrow();
  });

  it("does nothing when pasted directory is empty", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "prune-test-"));
    const dir = tmpDir;
    const pastedDir = join(dir, ".sparkflow", "pasted");
    mkdirSync(pastedDir, { recursive: true });
    expect(() => pruneOldPastedImages(dir)).not.toThrow();
  });
});
