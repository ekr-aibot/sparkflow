/**
 * Verifies that startWebServer().stop() terminates all spawned daemons —
 * the engine daemon and the detached frontend daemon — so test runs don't
 * leak processes under /tmp/sparkflow-e2e-home-*.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startWebServer } from "./server-fixture.js";

function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

test("stop() terminates the engine daemon and frontend daemon", async () => {
  const server = await startWebServer();
  let enginePid = -1;
  let frontendPid = -1;

  // Read daemon PIDs before stopping. Both files are guaranteed to exist here
  // because startWebServer() waits for the engine to attach before returning,
  // and the PID is written synchronously before the engine begins connecting.
  try {
    enginePid = parseInt(
      readFileSync(join(server.sparkflowHome, "engine-daemon.pid"), "utf-8").trim(), 10,
    );
    const dashInfo = JSON.parse(
      readFileSync(join(server.sparkflowHome, "dashboard.json"), "utf-8"),
    ) as { pid: number };
    frontendPid = dashInfo.pid;

    expect(enginePid).toBeGreaterThan(0);
    expect(frontendPid).toBeGreaterThan(0);
    expect(isAlive(enginePid)).toBe(true);
    expect(isAlive(frontendPid)).toBe(true);
  } catch (err) {
    await server.stop();
    throw err;
  }

  await server.stop();

  // Engine daemon: proc waited for it to exit before returning from stop()
  // (signal forwarding in tui/index.ts keeps proc alive until the engine
  // exits), so the engine must be dead immediately after stop() resolves.
  expect(isAlive(enginePid)).toBe(false);

  // Frontend daemon: stop() sends SIGTERM but doesn't await the process exit.
  // Poll briefly to let it die.
  const deadline = Date.now() + 2000;
  while (isAlive(frontendPid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(isAlive(frontendPid)).toBe(false);
});
