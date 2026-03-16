import * as pty from "node-pty";

export class PtyPane {
  private ptyProcess: pty.IPty;
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<(code: number) => void> = [];

  constructor(
    command: string,
    args: string[],
    options: { env?: Record<string, string>; cwd?: string; cols: number; rows: number }
  ) {
    this.ptyProcess = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? (process.env as Record<string, string>),
    });

    this.ptyProcess.onData((data) => {
      for (const cb of this.dataCallbacks) cb(data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      for (const cb of this.exitCallbacks) cb(exitCode);
    });
  }

  resize(cols: number, rows: number): void {
    this.ptyProcess.resize(cols, rows);
  }

  write(data: string): void {
    this.ptyProcess.write(data);
  }

  onData(cb: (data: string) => void): void {
    this.dataCallbacks.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    this.exitCallbacks.push(cb);
  }

  kill(): void {
    this.ptyProcess.kill();
  }

  get pid(): number {
    return this.ptyProcess.pid;
  }
}
