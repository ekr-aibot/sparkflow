#!/usr/bin/env node

/**
 * Deterministic stand-in for `claude` CLI used by E2E tests.
 * Supports --input-format stream-json and --output-format stream-json.
 */

import { writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
appendFileSync("/tmp/fake-claude.log", `ARGS: ${JSON.stringify(args)}\n`);

// Check if we are in stream-json mode
const isStreamJson = args.includes("--input-format") && args.includes("stream-json");

if (!isStreamJson) {
  console.error("fake-claude only supports --input-format stream-json");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  appendFileSync("/tmp/fake-claude.log", `LINE: ${line}\n`);
  try {
    const m = JSON.parse(line);
    if (m.type === "user") {
      const userMsg = m.message?.content || "";
      
      // Simulate file creation for sparkflow E2E tests
      if (userMsg.includes("add.js")) {
        writeFileSync("add.js", "module.exports = (a, b) => a + b;");
        writeFileSync("add.test.js", "const add = require('./add.js'); console.assert(add(2, 3) === 5); console.log('PASS');");
      } else if (userMsg.includes("multiply.js")) {
        writeFileSync("multiply.js", "module.exports = (a, b) => a * b;");
        writeFileSync("multiply.test.js", "const multiply = require('./multiply.js'); console.assert(multiply(3, 4) === 12); console.log('PASS');");
      }

      // Output assistant events
      process.stdout.write(JSON.stringify({ 
        type: "assistant", 
        message: { role: "assistant", content: "I've created the requested files." } 
      }) + "\n");

      // Output the final result event
      process.stdout.write(JSON.stringify({
        type: "result",
        result: "Successfully created the files and tests.",
        is_error: false
      }) + "\n");
    }
  } catch (err) {
    appendFileSync("/tmp/fake-claude.log", `ERROR: ${err.message}\n`);
  }
});

// If the adapter closes stdin without sending anything, we just exit
rl.on("close", () => {
  process.exit(0);
});
