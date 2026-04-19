import { watch, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

export interface StartWorkflowRequest {
  workflow_path: string;
  plan_text?: string;
  slug?: string;
}

export type StartWorkflowFn = (
  req: StartWorkflowRequest
) => Promise<{ job_id?: string; error?: string }>;

/**
 * Watch a directory for dispatch-queue request files. Each `*.json` file
 * (excluding `*.result.json`) is treated as a start_workflow request.
 * On receipt, calls startWorkflow, writes a sibling `*.result.json`, then
 * deletes the request file.
 *
 * Returns a close function that stops the watcher.
 */
export function watchDispatchQueue(queueDir: string, startWorkflow: StartWorkflowFn): () => void {
  mkdirSync(queueDir, { recursive: true });

  async function processFile(filename: string): Promise<void> {
    if (!filename.endsWith(".json") || filename.endsWith(".result.json")) return;

    const reqPath = join(queueDir, filename);
    const resultPath = join(queueDir, basename(filename, ".json") + ".result.json");

    let content: string;
    try {
      content = readFileSync(reqPath, "utf-8");
    } catch {
      return; // file already consumed by a concurrent event
    }

    async function finish(result: { job_id?: string; error?: string }): Promise<void> {
      writeFileSync(resultPath, JSON.stringify(result));
      try { unlinkSync(reqPath); } catch { /* already gone */ }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[dispatch-queue] invalid JSON in ${filename}: ${msg}\n`);
      await finish({ error: `invalid JSON: ${msg}` });
      return;
    }

    const req = parsed as Record<string, unknown>;
    if (!req.workflow_path || typeof req.workflow_path !== "string") {
      const msg = "missing required field: workflow_path";
      process.stderr.write(`[dispatch-queue] ${msg} in ${filename}\n`);
      await finish({ error: msg });
      return;
    }

    try {
      const result = await startWorkflow({
        workflow_path: req.workflow_path,
        plan_text: typeof req.plan_text === "string" ? req.plan_text : undefined,
        slug: typeof req.slug === "string" ? req.slug : undefined,
      });
      if (result.error) {
        process.stderr.write(`[dispatch-queue] start_workflow failed for ${filename}: ${result.error}\n`);
      } else {
        process.stderr.write(`[dispatch-queue] started job ${result.job_id} from ${filename}\n`);
      }
      await finish(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[dispatch-queue] error processing ${filename}: ${msg}\n`);
      await finish({ error: msg });
    }
  }

  function onEvent(_eventType: string, filename: string | null): void {
    if (filename) {
      processFile(filename).catch((err) => {
        process.stderr.write(`[dispatch-queue] unhandled error for ${filename}: ${err}\n`);
      });
    }
  }

  // Drain files present at startup before the watcher starts
  try {
    for (const file of readdirSync(queueDir)) {
      processFile(file).catch((err) => {
        process.stderr.write(`[dispatch-queue] startup drain error for ${file}: ${err}\n`);
      });
    }
  } catch { /* directory may not exist yet, mkdirSync above handles it */ }

  const watcher = watch(queueDir, onEvent);
  return () => watcher.close();
}
