import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Same regex used in validate.ts
const TEMPLATE_RE =
  /(?<!\$)\$\{steps\.([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_-]+)\}/g;

// Matches ${item} and ${item.field} (field may use dot-paths, e.g. ${item.issue.number})
const ITEM_TEMPLATE_RE =
  /(?<!\$)\$\{item(?:\.([a-zA-Z0-9_.-]+))?\}/g;

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

/**
 * Resolve template interpolation in a string.
 *
 * Supported forms:
 *   ${steps.<id>.output.<field>} — output of a prior step
 *   ${item}                      — current foreach item (only when itemContext is set)
 *   ${item.<field>}              — nested field on the item
 *
 * `$${` escapes to a literal `${`.
 */
export function resolveTemplate(
  text: string,
  stepOutputs: Map<string, Record<string, unknown>>,
  itemContext?: unknown
): string {
  let resolved = text.replace(TEMPLATE_RE, (_match, stepId: string, field: string) => {
    const outputs = stepOutputs.get(stepId);
    if (!outputs) {
      return `[no output from step "${stepId}"]`;
    }
    if (!(field in outputs)) {
      return `[no output "${field}" from step "${stepId}"]`;
    }
    return stringify(outputs[field]);
  });

  if (itemContext !== undefined) {
    resolved = resolved.replace(ITEM_TEMPLATE_RE, (_match, path?: string) => {
      return stringify(resolveItemPath(itemContext, path));
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
