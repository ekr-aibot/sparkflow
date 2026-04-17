#!/usr/bin/env node

// Deterministic chat stand-in used by the web-mode e2e tests. Prints a
// distinctive ready marker, then echoes every byte it reads from stdin back
// out with an `ECHO:` prefix so tests can assert round-trip over the
// WebSocket + PTY.
//
// Also prints markers the tests use to verify the spawn shape:
//   - SF_SAW_CLAUDE_FLAGS=1 if --mcp-config or --append-system-prompt are in argv
//   - SF_SAW_GEMINI_FILES=1 if .gemini/settings.json and GEMINI.md exist in cwd

import { existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv;
const sawClaudeFlags = argv.includes("--mcp-config") || argv.includes("--append-system-prompt");
const sawGeminiFiles = existsSync(join(process.cwd(), ".gemini", "settings.json"))
  && existsSync(join(process.cwd(), "GEMINI.md"));

if (sawClaudeFlags) process.stdout.write("SF_SAW_CLAUDE_FLAGS=1\r\n");
if (sawGeminiFiles) process.stdout.write("SF_SAW_GEMINI_FILES=1\r\n");

process.stdout.write("SF_TEST_READY\r\n");

// No line-buffering — stream every chunk so tests see output as it arrives.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  process.stdout.write(`ECHO:${chunk}`);
});

process.stdin.on("end", () => process.exit(0));
