/**
 * Serializes all writes to stdout so PTY output and status pane
 * renders never interleave. Batches pending writes on microtask
 * boundaries for efficiency.
 */
export class TerminalWriter {
  private queue: string[] = [];
  private scheduled = false;

  /**
   * Queue data for writing. All queued data is flushed together
   * in a single process.stdout.write() on the next microtask.
   */
  write(data: string): void {
    this.queue.push(data);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  /**
   * Write data immediately, flushing any pending queue first.
   * Use this for status pane renders that need to go out NOW
   * (not on next microtask) but still serialized with PTY output.
   */
  writeSync(data: string): void {
    this.queue.push(data);
    this.flush();
  }

  private flush(): void {
    this.scheduled = false;
    if (this.queue.length === 0) return;
    const combined = this.queue.join("");
    this.queue.length = 0;
    process.stdout.write(combined);
  }
}
