import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Creates a fake 'claude' binary in the given directory.
 * It responds to prompts by creating files as requested in the e2e tests.
 */
export function createFakeClaude(dir: string): string {
  const scriptPath = join(dir, "claude");
  const content = `#!/usr/bin/env node
const fs = require('fs');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('claude-code/0.1.0\\n');
  process.exit(0);
}

// In e2e tests, we use --print and --input-format stream-json.
// We should read from stdin.
const rl = require('readline').createInterface({ input: process.stdin });

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === 'user') {
      const text = msg.message.content;
      
      // Fake logic for 'author writes code, tester runs it'
      if (text.includes('add.js')) {
        fs.writeFileSync('add.js', 'module.exports = (a, b) => a + b;\\n');
        fs.writeFileSync('add.test.js', \`
const add = require('./add.js');
console.assert(add(2, 3) === 5, '2+3 should be 5');
console.log('PASS');
\`);
      }
      
      // Fake logic for 'plan is provided to all steps'
      if (text.includes('multiply.js') || (process.env.SPARKFLOW_PLAN && process.env.SPARKFLOW_PLAN.includes('multiply.js'))) {
        fs.writeFileSync('multiply.js', 'module.exports = (a, b) => a * b;\\n');
        fs.writeFileSync('multiply.test.js', \`
const multiply = require('./multiply.js');
console.assert(multiply(3, 4) === 12, '3*4 should be 12');
console.log('PASS');
\`);
      }

      // Emit success result
      process.stdout.write(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'I have created the files.'
      }) + '\\n');
    }
  } catch (e) {}
});

rl.on('close', () => {
  process.exit(0);
});
`;
  writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}

/**
 * Creates a fake 'codex' binary in the given directory.
 * It waits for EOF on stdin before responding.
 */
export function createFakeCodex(dir: string): string {
  const scriptPath = join(dir, "codex");
  const content = `#!/usr/bin/env node
const fs = require('fs');

const args = process.argv.slice(2);

// Real codex exec v0.130.0+ waits for EOF.
let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch (e) {}

// Fake logic for e2e
if (input.includes('add.js')) {
  fs.writeFileSync('add.js', 'module.exports = (a, b) => a + b;\\n');
  fs.writeFileSync('add.test.js', \`
const add = require('./add.js');
console.assert(add(2, 3) === 5, '2+3 should be 5');
console.log('PASS');
\`);
}

// Emit session start
process.stdout.write(JSON.stringify({
  type: 'session_start',
  session_id: 'fake-codex-session-123'
}) + '\\n');

// Emit assistant message
process.stdout.write(JSON.stringify({
  type: 'assistant_message',
  content: 'I have created the files.'
}) + '\\n');

// Emit result
process.stdout.write(JSON.stringify({
  type: 'result',
  result: 'I have created the files.'
}) + '\\n');

process.exit(0);
`;
  writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}
