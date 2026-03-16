import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

// Same regex used in validate.ts
const TEMPLATE_RE =
  /(?<!\$)\$\{steps\.([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_-]+)\}/g;

/**
 * Resolve template interpolation in a string, replacing
 * `${steps.<id>.output.<field>}` with actual values from stepOutputs.
 *
 * - Missing step or output throws.
 * - `$${` escapes to literal `${`.
 * - JSON values are inserted via JSON.stringify.
 */
export function resolveTemplate(
  text: string,
  stepOutputs: Map<string, Record<string, unknown>>
): string {
  const resolved = text.replace(TEMPLATE_RE, (_match, stepId: string, field: string) => {
    const outputs = stepOutputs.get(stepId);
    if (!outputs) {
      throw new Error(`Template references step "${stepId}" which has no outputs`);
    }
    if (!(field in outputs)) {
      throw new Error(
        `Template references output "${field}" on step "${stepId}" which does not exist`
      );
    }
    const value = outputs[field];
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value);
  });

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
