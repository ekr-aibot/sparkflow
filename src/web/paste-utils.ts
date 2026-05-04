import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

export function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        aborted = true;
        chunks.length = 0;
        reject(new Error("request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on("error", (err) => reject(err));
  });
}

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
