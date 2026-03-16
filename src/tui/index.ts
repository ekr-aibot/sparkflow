#!/usr/bin/env node

import { resolve } from "node:path";
import { App } from "./app.js";

function usage(): never {
  console.log(`Usage: sparkflow [options]

Options:
  --chat-command <cmd>   Chat tool command (default: "claude")
  --chat-args <args>     Extra args for chat tool (comma-separated)
  --cwd <dir>            Working directory (default: current directory)`);
  process.exit(0);
}

function parseArgs(argv: string[]): { chatCommand: string; chatArgs: string[]; cwd: string } {
  let chatCommand = "claude";
  let chatArgs: string[] = [];
  let cwd = process.cwd();

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--help":
      case "-h":
        usage();
        break;
      case "--chat-command":
        chatCommand = argv[++i];
        if (!chatCommand) {
          console.error("Error: --chat-command requires a value");
          process.exit(1);
        }
        break;
      case "--chat-args":
        chatArgs = (argv[++i] ?? "").split(",").filter(Boolean);
        break;
      case "--cwd":
        cwd = resolve(argv[++i] ?? ".");
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }

  return { chatCommand, chatArgs, cwd };
}

const args = parseArgs(process.argv.slice(2));

const app = new App({
  chatCommand: args.chatCommand,
  chatArgs: args.chatArgs,
  cwd: args.cwd,
});

app.start().catch((err) => {
  // Restore terminal on error
  process.stdout.write("\x1b[r");
  process.stdout.write("\x1b[?1049l");
  console.error("Fatal error:", err);
  process.exit(1);
});
