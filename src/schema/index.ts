export type {
  SparkflowWorkflow,
  Step,
  StepDefaults,
  Transition,
  Runtime,
  ClaudeCodeRuntime,
  ShellRuntime,
  CustomRuntime,
  WorktreeConfig,
  OutputDeclaration,
} from "./types.js";

export { validate } from "./validate.js";
export type { ValidationResult, ValidationDiagnostic } from "./validate.js";
