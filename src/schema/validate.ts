import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SparkflowWorkflow, Step, Transition } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowSchema = JSON.parse(
  readFileSync(resolve(__dirname, "workflow.schema.json"), "utf-8")
);

// ── Types ───────────────────────────────────────────────────────────

export interface ValidationDiagnostic {
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationDiagnostic[];
  warnings: ValidationDiagnostic[];
}

// ── JSON Schema validation ──────────────────────────────────────────

const ajv = new Ajv({ allErrors: true });
const validateSchema = ajv.compile(workflowSchema);

// ── Template parsing ────────────────────────────────────────────────

const TEMPLATE_RE = /(?<!\$)\$\{steps\.([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_-]+)\}/g;

interface TemplateRef {
  stepId: string;
  outputField: string;
}

function extractTemplateRefs(text: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_RE.exec(text)) !== null) {
    refs.push({ stepId: match[1], outputField: match[2] });
  }
  return refs;
}

// ── Semantic validation ─────────────────────────────────────────────

function validateTemplateRefs(
  text: string,
  fieldPath: string,
  stepIds: Set<string>,
  steps: Record<string, Step>,
  diagnostics: ValidationDiagnostic[]
): void {
  for (const ref of extractTemplateRefs(text)) {
    if (!stepIds.has(ref.stepId)) {
      diagnostics.push({
        severity: "error",
        message: `Template references non-existent step "${ref.stepId}"`,
        path: fieldPath,
      });
    } else {
      const targetStep = steps[ref.stepId];
      if (!targetStep.outputs || !(ref.outputField in targetStep.outputs)) {
        diagnostics.push({
          severity: "warning",
          message: `Template references undeclared output "${ref.outputField}" on step "${ref.stepId}"`,
          path: fieldPath,
        });
      }
    }
  }
}

function validateTransitions(
  transitions: Transition[],
  fieldPath: string,
  stepIds: Set<string>,
  steps: Record<string, Step>,
  diagnostics: ValidationDiagnostic[]
): void {
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    if (!stepIds.has(t.step)) {
      diagnostics.push({
        severity: "error",
        message: `Transition references non-existent step "${t.step}"`,
        path: `${fieldPath}[${i}].step`,
      });
    }
    if (t.message) {
      validateTemplateRefs(
        t.message,
        `${fieldPath}[${i}].message`,
        stepIds,
        steps,
        diagnostics
      );
    }
  }
}

function semanticValidation(workflow: SparkflowWorkflow): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const stepIds = new Set(Object.keys(workflow.steps));

  // Entry must exist
  if (!stepIds.has(workflow.entry)) {
    diagnostics.push({
      severity: "error",
      message: `Entry step "${workflow.entry}" does not exist in steps`,
      path: "entry",
    });
  }

  // Collect all steps that are targets of transitions (to detect unreachable)
  const reachable = new Set<string>([workflow.entry]);

  for (const [id, step] of Object.entries(workflow.steps)) {
    const base = `steps.${id}`;

    // Runtime must be set on step or defaults
    if (!step.runtime && !workflow.defaults?.runtime) {
      diagnostics.push({
        severity: "error",
        message: `Step "${id}" has no runtime and no default runtime is configured`,
        path: `${base}.runtime`,
      });
    }

    // Validate join references
    if (step.join) {
      for (const joinId of step.join) {
        if (!stepIds.has(joinId)) {
          diagnostics.push({
            severity: "error",
            message: `Join references non-existent step "${joinId}"`,
            path: `${base}.join`,
          });
        }
      }
    }

    // Validate transitions
    if (step.on_success) {
      validateTransitions(step.on_success, `${base}.on_success`, stepIds, workflow.steps, diagnostics);
      for (const t of step.on_success) {
        reachable.add(t.step);
      }
    }
    if (step.on_failure) {
      validateTransitions(step.on_failure, `${base}.on_failure`, stepIds, workflow.steps, diagnostics);
      for (const t of step.on_failure) {
        reachable.add(t.step);
      }
    }

    // Validate templates in prompt
    if (step.prompt) {
      validateTemplateRefs(step.prompt, `${base}.prompt`, stepIds, workflow.steps, diagnostics);
    }
  }

  // Warn about unreachable steps
  for (const id of stepIds) {
    if (!reachable.has(id)) {
      // Also check if the step is referenced in any join
      let referencedInJoin = false;
      for (const step of Object.values(workflow.steps)) {
        if (step.join?.includes(id)) {
          referencedInJoin = true;
          break;
        }
      }
      if (!referencedInJoin) {
        diagnostics.push({
          severity: "warning",
          message: `Step "${id}" is unreachable — no transition or entry points to it`,
          path: `steps.${id}`,
        });
      }
    }
  }

  return diagnostics;
}

// ── Public API ──────────────────────────────────────────────────────

export function validate(data: unknown): ValidationResult {
  const errors: ValidationDiagnostic[] = [];
  const warnings: ValidationDiagnostic[] = [];

  // JSON Schema validation
  const schemaValid = validateSchema(data);
  if (!schemaValid) {
    for (const err of validateSchema.errors ?? []) {
      errors.push({
        severity: "error",
        message: err.message ?? "Schema validation error",
        path: err.instancePath || undefined,
      });
    }
    return { valid: false, errors, warnings };
  }

  // Semantic validation (only if structurally valid)
  const workflow = data as SparkflowWorkflow;
  const diagnostics = semanticValidation(workflow);

  for (const d of diagnostics) {
    if (d.severity === "error") {
      errors.push(d);
    } else {
      warnings.push(d);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
