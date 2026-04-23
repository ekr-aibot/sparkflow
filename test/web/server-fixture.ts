import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface WebServerHandle {
  url: string;
  token: string;
  port: number;
  proc: ChildProcess;
  cwd: string;
  stop: () => Promise<void>;
}

const READY_RE = /ready at (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+))/;

async function waitForEngine(port: number, token: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/repos`, {
        headers: { Cookie: `sf_token=${token}` },
      });
      if (r.ok) {
        const body = await r.json() as { repos: unknown[] };
        if (body.repos.length > 0) return;
      }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out waiting for engine daemon to attach");
}

/** Spawns `sparkflow --web` with fake-chat as the chat command and waits for the ready banner. */
export async function startWebServer(
  opts: { extraArgs?: string[]; extraEnv?: Record<string, string>; chatTool?: "claude" | "gemini" } = {},
): Promise<WebServerHandle> {
  const repoRoot = resolve(__dirname, "..", "..");
  const sparkflowEntry = join(repoRoot, "dist", "src", "tui", "index.js");
  const fakeChat = join(repoRoot, "test", "web", "fake-chat.mjs");
  const cwd = mkdtempSync(join(tmpdir(), "sparkflow-e2e-"));

  // Isolate each test run with its own SPARKFLOW_HOME so a detached
  // frontend daemon from a previous test doesn't get discovered (and
  // waitForEngine doesn't see a stale repo from the previous run).
  // Also avoids interference with the user's real ~/.sparkflow state
  // when running locally.
  const sparkflowHome = mkdtempSync(join(tmpdir(), "sparkflow-e2e-home-"));

  const chatToolArgs = opts.chatTool ? ["--chat-tool", opts.chatTool] : [];

  const proc = spawn(
    process.execPath,
    [
      sparkflowEntry,
      "--web",
      "--cwd", cwd,
      ...chatToolArgs,
      "--chat-command", process.execPath,
      "--chat-args", fakeChat,
      ...(opts.extraArgs ?? []),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SPARKFLOW_HOME: sparkflowHome, ...(opts.extraEnv ?? {}) },
    },
  );

  const errChunks: string[] = [];
  const outChunks: string[] = [];
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.setEncoding("utf8");
  proc.stderr?.on("data", (c) => { errChunks.push(c); });
  proc.stdout?.on("data", (c) => { outChunks.push(c); });

  const ready = await new Promise<{ url: string; port: number; token: string }>((res, rej) => {
    const onData = () => {
      const combined = errChunks.join("") + outChunks.join("");
      const m = combined.match(READY_RE);
      if (m) {
        cleanup();
        res({ url: m[1], port: parseInt(m[2], 10), token: m[3] });
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      rej(new Error(`sparkflow --web exited before ready (code=${code}):\nstderr:\n${errChunks.join("")}\nstdout:\n${outChunks.join("")}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      rej(new Error(`Timed out waiting for ready banner. Captured:\nstderr:\n${errChunks.join("")}\nstdout:\n${outChunks.join("")}`));
    }, 20000);
    const cleanup = () => {
      clearTimeout(timer);
      proc.stderr?.off("data", onData);
      proc.stdout?.off("data", onData);
      proc.off("exit", onExit);
    };
    proc.stderr?.on("data", onData);
    proc.stdout?.on("data", onData);
    proc.on("exit", onExit);
  });

  // The ready banner is written BEFORE the engine daemon starts connecting.
  // Poll /repos until at least one engine attaches so PTY bridge is available.
  await waitForEngine(ready.port, ready.token);

  const stop = async (): Promise<void> => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exit = new Promise<void>((res) => proc.once("exit", () => res()));
      try { proc.kill("SIGINT"); } catch { /* ignore */ }
      await Promise.race([
        exit,
        new Promise<void>((res) => setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* ignore */ }
          res();
        }, 3000)),
      ]);
    }
    // Kill the detached frontend daemon so it doesn't linger past the test.
    // dashboard.json's pid field is written on startup.
    try {
      const info = JSON.parse(readFileSync(join(sparkflowHome, "dashboard.json"), "utf-8")) as { pid?: number };
      if (info.pid && info.pid > 0) {
        try { process.kill(info.pid, "SIGTERM"); } catch { /* already dead */ }
      }
    } catch { /* no dashboard.json — nothing to kill */ }
    try { rmSync(sparkflowHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { url: ready.url, token: ready.token, port: ready.port, proc, cwd, stop };
}
