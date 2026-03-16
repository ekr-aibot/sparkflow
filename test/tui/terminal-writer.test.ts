import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TerminalWriter } from "../../src/tui/terminal-writer.js";

describe("TerminalWriter", () => {
  let writer: TerminalWriter;
  let chunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    chunks = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdoutSpy = vi.spyOn(process.stdout, "write" as any).mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as any);
    writer = new TerminalWriter();
  });

  afterEach(() => {
    stdoutSpy?.mockRestore();
  });

  it("batches multiple write() calls into a single flush", async () => {
    writer.write("hello");
    writer.write(" world");

    expect(chunks).toEqual([]);

    await Promise.resolve();
    expect(chunks).toEqual(["hello world"]);
  });

  it("writeSync flushes immediately", () => {
    writer.writeSync("now");
    expect(chunks).toEqual(["now"]);
  });

  it("writeSync flushes pending writes first", () => {
    writer.write("queued");
    writer.writeSync("urgent");

    expect(chunks).toEqual(["queuedurgent"]);
  });

  // --- Persistent status renderer ---

  it("appends status render after every PTY data flush", async () => {
    writer.setStatusRenderer(() => "[STATUS]", "\x1b[1;20r");
    writer.write("pty data");

    await Promise.resolve();
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe("pty data\x1b[1;20r[STATUS]");
  });

  it("re-sets scroll region before status render", async () => {
    writer.setStatusRenderer(() => "[STATUS]", "\x1b[1;19r");
    writer.write("data");

    await Promise.resolve();
    // Scroll region should precede status render
    const out = chunks[0];
    const scrollIdx = out.indexOf("\x1b[1;19r");
    const statusIdx = out.indexOf("[STATUS]");
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(scrollIdx);
  });

  it("renderStatus triggers a flush with status even without PTY data", async () => {
    writer.setStatusRenderer(() => "[STATUS]", "\x1b[1;20r");
    writer.renderStatus();

    await Promise.resolve();
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe("\x1b[1;20r[STATUS]");
  });

  it("status render fires on every flush, not just once", async () => {
    let count = 0;
    writer.setStatusRenderer(() => `[STATUS-${++count}]`, "\x1b[1;20r");

    writer.write("a");
    await Promise.resolve();
    expect(chunks[0]).toContain("[STATUS-1]");

    writer.write("b");
    await Promise.resolve();
    expect(chunks[1]).toContain("[STATUS-2]");
  });

  it("setScrollRegion updates the sequence used", async () => {
    writer.setStatusRenderer(() => "[S]", "\x1b[1;20r");
    writer.setScrollRegion("\x1b[1;15r");
    writer.write("x");

    await Promise.resolve();
    expect(chunks[0]).toContain("\x1b[1;15r");
    expect(chunks[0]).not.toContain("\x1b[1;20r");
  });

  // --- Escape sequence safety ---

  it("defers status render when PTY data ends mid-CSI", async () => {
    writer.setStatusRenderer(() => "[STATUS]", "\x1b[1;20r");
    writer.write("text\x1b[33");

    await Promise.resolve();
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe("text\x1b[33");
    expect(chunks[0]).not.toContain("[STATUS]");

    // Complete the sequence
    writer.write("m more");
    await Promise.resolve();
    expect(chunks[1]).toContain("m more");
    expect(chunks[1]).toContain("[STATUS]");
  });

  it("defers status render when PTY data ends with bare ESC", async () => {
    writer.setStatusRenderer(() => "[STATUS]", "\x1b[1;20r");
    writer.write("text\x1b");

    await Promise.resolve();
    expect(chunks[0]).toBe("text\x1b");
    expect(chunks[0]).not.toContain("[STATUS]");

    writer.write("[0m");
    await Promise.resolve();
    expect(chunks[1]).toContain("[STATUS]");
  });

  it("does not defer when PTY data ends with complete escape", async () => {
    writer.setStatusRenderer(() => "[STATUS]", "\x1b[1;20r");
    writer.write("text\x1b[33m");

    await Promise.resolve();
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("[STATUS]");
  });

  it("does not defer when PTY data is plain text", async () => {
    writer.setStatusRenderer(() => "[STATUS]", "\x1b[1;20r");
    writer.write("plain text");

    await Promise.resolve();
    expect(chunks[0]).toContain("[STATUS]");
  });

  it("handles incomplete OSC sequence", async () => {
    writer.setStatusRenderer(() => "[STATUS]", "\x1b[1;20r");
    writer.write("text\x1b]0;title");

    await Promise.resolve();
    expect(chunks[0]).not.toContain("[STATUS]");

    writer.write("\x07more");
    await Promise.resolve();
    expect(chunks[1]).toContain("[STATUS]");
  });

  it("handles CSI with multiple params", async () => {
    writer.setStatusRenderer(() => "[STATUS]", "\x1b[1;20r");
    writer.write("text\x1b[38;5");

    await Promise.resolve();
    expect(chunks[0]).not.toContain("[STATUS]");

    writer.write(";200m");
    await Promise.resolve();
    expect(chunks[1]).toContain("[STATUS]");
  });
});
