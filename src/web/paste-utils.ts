import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function pruneOldPastedImages(cwd: string, maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  const dir = join(cwd, ".sparkflow", "pasted");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of files) {
    const filePath = join(dir, name);
    try {
      const st = statSync(filePath);
      if (st.isFile() && st.mtimeMs < cutoff) {
        unlinkSync(filePath);
      }
    } catch {
      // best-effort; log and continue
      console.error(`[sparkflow] pruneOldPastedImages: failed to remove ${filePath}`);
    }
  }
}
