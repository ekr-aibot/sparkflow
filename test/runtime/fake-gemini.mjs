#!/usr/bin/env node

// Deterministic stand-in for `gemini` used by the runtime tests. Reads the
// prompt from stdin and behaves according to flags / env:
//
//   --emit-json       : print a canned JSON blob, ignore stdin
//   --exit-code <n>   : exit with <n> (default 0)
//   --sleep <secs>    : sleep for <secs> before exiting (for timeout tests)
//   --emit-stderr <s> : print <s> on stderr before exiting
//
// By default it echoes the stdin prompt prefixed with "GEMINI:".

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
let emitJson = false;
let exitCode = 0;
let sleepSecs = 0;
let emitStderr = "";

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--emit-json") emitJson = true;
  else if (argv[i] === "--exit-code") exitCode = parseInt(argv[++i], 10);
  else if (argv[i] === "--sleep") sleepSecs = parseFloat(argv[++i]);
  else if (argv[i] === "--emit-stderr") emitStderr = argv[++i];
}

let stdin = "";
if (!process.stdin.isTTY) {
  try { stdin = readFileSync(0, "utf-8"); } catch { /* no stdin */ }
}

async function main() {
  if (sleepSecs > 0) {
    await new Promise((r) => setTimeout(r, sleepSecs * 1000));
  }
  if (emitStderr) process.stderr.write(emitStderr + "\n");
  if (emitJson) {
    process.stdout.write(JSON.stringify({ answer: "forty-two", confidence: 0.9 }));
  } else {
    process.stdout.write(`GEMINI:${stdin}`);
  }
  process.exit(exitCode);
}

main();
