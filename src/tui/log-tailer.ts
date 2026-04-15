import { createReadStream, stat, watch, type FSWatcher } from "node:fs";

/**
 * Tails a log file, emitting complete lines as they arrive.
 * Supports resuming from a byte offset (for rehydrate).
 */
export class LogTailer {
  private path: string;
  private offset: number;
  private watcher: FSWatcher | null = null;
  private buffer = "";
  private reading = false;
  private onLine: (line: string) => void;
  private stopped = false;

  constructor(path: string, startOffset: number, onLine: (line: string) => void) {
    this.path = path;
    this.offset = startOffset;
    this.onLine = onLine;
  }

  get bytesRead(): number {
    return this.offset;
  }

  start(): void {
    this.readNew();
    try {
      this.watcher = watch(this.path, () => {
        this.readNew();
      });
    } catch {
      // File may not exist yet; retry on a timer.
      const retry = setInterval(() => {
        if (this.stopped) {
          clearInterval(retry);
          return;
        }
        try {
          this.watcher = watch(this.path, () => this.readNew());
          clearInterval(retry);
          this.readNew();
        } catch {
          // keep retrying
        }
      }, 200);
    }
  }

  private readNew(): void {
    if (this.reading || this.stopped) return;
    this.reading = true;
    stat(this.path, (err, st) => {
      if (err || !st) {
        this.reading = false;
        return;
      }
      if (st.size <= this.offset) {
        this.reading = false;
        return;
      }
      const stream = createReadStream(this.path, { start: this.offset, end: st.size - 1 });
      let chunkBytes = 0;
      stream.on("data", (chunk) => {
        const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        chunkBytes += Buffer.byteLength(s, "utf-8");
        this.buffer += s;
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          try { this.onLine(line); } catch { /* swallow */ }
        }
      });
      stream.on("end", () => {
        this.offset += chunkBytes;
        this.reading = false;
        // In case another change happened while we were reading.
        if (!this.stopped) this.readNew();
      });
      stream.on("error", () => {
        this.reading = false;
      });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
  }
}
