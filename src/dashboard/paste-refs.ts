const PASTE_REF_RE = /@(\.sparkflow\/pasted\/[A-Za-z0-9_.-]+\.(?:png|jpg|jpeg|gif|webp))\b/g;

export function extractPastedImageRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PASTE_REF_RE)) {
    out.add(m[1]);
  }
  return [...out];
}
