import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectConfig } from "../config/project-config.js";

// Same regex used in validate.ts
const TEMPLATE_RE =
  /(?<!\$)\$\{steps\.([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_-]+)\}/g;

// Matches ${item} and ${item.field} (field may use dot-paths, e.g. ${item.issue.number})
const ITEM_TEMPLATE_RE =
  /(?<!\$)\$\{item(?:\.([a-zA-Z0-9_.-]+))?\}/g;

// Matches ${config.<dot.path>} (e.g. ${config.git.pull_remote})
const CONFIG_TEMPLATE_RE =
  /(?<!\$)\$\{config\.([a-zA-Z0-9_.]+)\}/g;

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function resolveItemPath(item: unknown, path: string | undefined): unknown {
  if (!path) return item;
  let cur: unknown = item;
  for (const segment of path.split(".")) {
    if (cur == null || typeof cur !== "object") {
      return `[item path "${path}" not resolvable]`;
    }
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function resolveConfigPath(config: Record<string, unknown>, path: string): unknown {
  let cur: unknown = config;
  for (const segment of path.split(".")) {
    if (cur == null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/**
 * Resolve template interpolation in a string.
 *
 * Supported forms:
 *   ${steps.<id>.output.<field>} — output of a prior step
 *   ${item}                      — current foreach item (only when itemContext is set)
 *   ${item.<field>}              — nested field on the item
 *   ${config.<dot.path>}         — value from merged project config (only when config is set)
 *
 * `$${` escapes to a literal `${`.
 */
export function resolveTemplate(
  text: string,
  stepOutputs: Map<string, Record<string, unknown>>,
  itemContext?: unknown,
  config?: ProjectConfig
): string {
  let resolved = text.replace(TEMPLATE_RE, (_match, stepId: string, field: string) => {
    const outputs = stepOutputs.get(stepId);
    if (!outputs) {
      return `(step "${stepId}" did not run)`;
    }
    if (!(field in outputs)) {
      process.stderr.write(
        `[sparkflow] warn: \${steps.${stepId}.output.${field}} — field "${field}" not found in outputs of step "${stepId}"\n`
      );
      return `(no \`${field}\` output from step "${stepId}")`;
    }
    return stringify(outputs[field]);
  });

  if (itemContext !== undefined) {
    resolved = resolved.replace(ITEM_TEMPLATE_RE, (_match, path?: string) => {
      return stringify(resolveItemPath(itemContext, path));
    });
  }

  if (config !== undefined) {
    resolved = resolved.replace(CONFIG_TEMPLATE_RE, (_match, path: string) => {
      const value = resolveConfigPath(config as Record<string, unknown>, path);
      if (value === undefined) {
        return `<sparkflow:missing-config path="${path}">`;
      }
      return stringify(value);
    });
  }

  // Handle escape: $${ → ${
  return resolved.replace(/\$\$\{/g, "${");
}

/**
 * Resolve a prompt value. If it looks like a file path (starts with "./"
 * or ends with ".md"), read the file relative to workflowDir.
 * Otherwise return the string as-is.
 */
export function resolvePrompt(prompt: string, workflowDir: string): string {
  if (prompt.startsWith("./") || prompt.endsWith(".md")) {
    return readFileSync(resolve(workflowDir, prompt), "utf-8");
  }
  return prompt;
}
