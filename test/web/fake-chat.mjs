#!/usr/bin/env node

// Deterministic chat stand-in used by the web-mode e2e tests. Prints a
// distinctive ready marker, then echoes every byte it reads from stdin back
// out with an `ECHO:` prefix so tests can assert round-trip over the
// WebSocket + PTY.

process.stdout.write("SF_TEST_READY\r\n");

// No line-buffering — stream every chunk so tests see output as it arrives.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  process.stdout.write(`ECHO:${chunk}`);
});

process.stdin.on("end", () => process.exit(0));
