import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function pruneOldPastedImages(cwd: string, maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  const dir = join(cwd, ".sparkflow", "pasted");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.mtimeMs < cutoff) unlinkSync(p);
    } catch { /* ignore individual file errors */ }
  }
}
