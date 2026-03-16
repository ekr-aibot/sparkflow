/**
 * Serializes all writes to stdout so PTY output and status pane
 * renders never interleave.
 *
 * After every PTY data flush, re-establishes the scroll region and
 * re-renders the status pane. This makes the layout robust against
 * the inner PTY application (e.g. claude) resetting scroll regions,
 * clearing the screen, or otherwise disrupting the terminal state.
 *
 * Status renders are deferred if the PTY output stream is mid-escape-
 * sequence to avoid corrupting the terminal's escape parser.
 */

/** Escape parser states */
const enum EscState {
  Normal,
  /** Saw \x1b, waiting for next byte */
  Escape,
  /** In a CSI sequence (\x1b[), collecting params */
  Csi,
  /** In an OSC sequence (\x1b]), waiting for BEL or ST */
  Osc,
  /** Saw \x1b inside OSC (possible ST = \x1b\\ ) */
  OscEscape,
}

export class TerminalWriter {
  private queue: string[] = [];
  private scheduled = false;
  private escState: EscState = EscState.Normal;
  private statusRenderer: (() => string) | null = null;
  private scrollRegion: string = "";

  /**
   * Set a persistent status renderer that runs after every PTY flush.
   * Also sets the scroll region escape sequence to re-apply.
   */
  setStatusRenderer(
    renderer: () => string,
    scrollRegionSeq: string,
  ): void {
    this.statusRenderer = renderer;
    this.scrollRegion = scrollRegionSeq;
  }

  /**
   * Update the scroll region sequence (e.g. on resize).
   */
  setScrollRegion(seq: string): void {
    this.scrollRegion = seq;
  }

  /**
   * Queue PTY data for writing. Flushed on next microtask.
   */
  write(data: string): void {
    this.queue.push(data);
    this.scheduleFlush();
  }

  /**
   * Write data immediately, flushing any pending queue first.
   */
  writeSync(data: string): void {
    this.queue.push(data);
    this.flush();
  }

  /**
   * Request an immediate status re-render (e.g. on job update).
   */
  renderStatus(): void {
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;

    // Combine all queued PTY data
    const ptyData = this.queue.join("");
    this.queue.length = 0;

    if (ptyData.length === 0 && !this.statusRenderer) return;

    // Update escape state by scanning PTY data
    if (ptyData.length > 0) {
      this.updateEscState(ptyData);
    }

    // If mid-escape, write PTY data only and try again next flush
    if (this.escState !== EscState.Normal) {
      if (ptyData.length > 0) {
        process.stdout.write(ptyData);
      }
      return;
    }

    // At a clean boundary: write PTY data + restore scroll region + status
    if (this.statusRenderer) {
      const status = this.statusRenderer();
      process.stdout.write(ptyData + this.scrollRegion + status);
    } else if (ptyData.length > 0) {
      process.stdout.write(ptyData);
    }
  }

  /**
   * Scan data and update the escape sequence parser state.
   */
  private updateEscState(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      switch (this.escState) {
        case EscState.Normal:
          if (ch === 0x1b) this.escState = EscState.Escape;
          break;

        case EscState.Escape:
          if (ch === 0x5b) { // [
            this.escState = EscState.Csi;
          } else if (ch === 0x5d) { // ]
            this.escState = EscState.Osc;
          } else {
            this.escState = EscState.Normal;
          }
          break;

        case EscState.Csi:
          // Final byte: 0x40-0x7e
          if (ch >= 0x40 && ch <= 0x7e) {
            this.escState = EscState.Normal;
          }
          break;

        case EscState.Osc:
          if (ch === 0x07) {
            this.escState = EscState.Normal;
          } else if (ch === 0x1b) {
            this.escState = EscState.OscEscape;
          }
          break;

        case EscState.OscEscape:
          if (ch === 0x5c) { // backslash = ST
            this.escState = EscState.Normal;
          } else {
            this.escState = EscState.Osc;
          }
          break;
      }
    }
  }
}
