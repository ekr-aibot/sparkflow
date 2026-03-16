import type { JobInfo } from "./types.js";
import type { TerminalWriter } from "./terminal-writer.js";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

const STATE_COLORS: Record<string, string> = {
  running: COLORS.yellow,
  succeeded: COLORS.green,
  failed: COLORS.red,
  blocked: COLORS.magenta,
};

function elapsed(startTime: number, endTime?: number): string {
  const ms = (endTime ?? Date.now()) - startTime;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

export class StatusPane {
  private height = 0;
  private totalRows = 0;
  private totalCols = 0;
  private writer: TerminalWriter | null = null;

  setWriter(writer: TerminalWriter): void {
    this.writer = writer;
  }

  setDimensions(cols: number, rows: number): void {
    this.totalCols = cols;
    this.totalRows = rows;
  }

  setHeight(n: number): void {
    this.height = n;
  }

  getHeight(): number {
    return this.height;
  }

  render(jobs: JobInfo[]): void {
    if (this.height === 0 || this.totalRows === 0) return;

    const startRow = this.totalRows - this.height + 1;

    // Save cursor
    let out = "\x1b7";

    // Draw header line
    const headerText = "─── sparkflow jobs ───";
    const padding = "─".repeat(Math.max(0, this.totalCols - headerText.length));
    out += `\x1b[${startRow};1H${COLORS.dim}${headerText}${padding}${COLORS.reset}`;

    // Draw job lines
    const maxJobLines = this.height - 1;
    for (let i = 0; i < maxJobLines; i++) {
      const row = startRow + 1 + i;
      out += `\x1b[${row};1H\x1b[2K`; // move to row, clear line
      if (i < jobs.length) {
        const job = jobs[i];
        const color = STATE_COLORS[job.state] ?? COLORS.reset;
        const step = job.currentStep ? `/${job.currentStep}` : "";
        const name = job.workflowName || job.workflowPath;
        const stateLabel = job.state.toUpperCase();
        const time = elapsed(job.startTime, job.endTime);
        const question = job.pendingQuestion ? ` ? ${job.pendingQuestion}` : "";
        const line = `${COLORS.dim}${job.id.slice(0, 8)}${COLORS.reset} ${COLORS.cyan}[${name}${step}]${COLORS.reset} ${color}${stateLabel}${COLORS.reset} ${job.summary}${question} ${COLORS.dim}(${time})${COLORS.reset}`;

        // Truncate to terminal width (rough — ANSI codes make this imprecise but acceptable)
        out += line;
      }
    }

    // Restore cursor
    out += "\x1b8";

    if (this.writer) {
      this.writer.writeSync(out);
    } else {
      process.stdout.write(out);
    }
  }
}
