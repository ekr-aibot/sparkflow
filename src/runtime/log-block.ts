/**
 * Shared log-block types and formatters for Claude and Gemini stream-json events.
 *
 * Each runtime emits LogBlocks, which get logged with a kind-specific suffix so
 * the web viewer's non-verbose filter can hide tool noise:
 *   text        → [step]
 *   tool        → [step:tool]
 *   tool_result → [step:tool_result]
 *   meta        → [step:meta]
 */

export interface LogBlock {
  kind: "text" | "tool" | "tool_result" | "meta";
  text: string;
}

export function suffixFor(kind: LogBlock["kind"]): string {
  switch (kind) {
    case "text": return "";
    case "tool": return ":tool";
    case "tool_result": return ":tool_result";
    case "meta": return ":meta";
  }
}

export function formatClaudeEvent(event: Record<string, unknown>): LogBlock[] {
  const type = event.type as string;

  if (type === "assistant") {
    const msg = event.message as Record<string, unknown> | undefined;
    if (!msg) return [];
    const content = msg.content as Array<Record<string, unknown>> | undefined;
    if (!content) return [];

    const blocks: LogBlock[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        const text = String(block.text);
        for (const line of text.split(/\r?\n/)) {
          if (line.length > 0) blocks.push({ kind: "text", text: line });
        }
      } else if (block.type === "tool_use") {
        const input = block.input ? JSON.stringify(block.input) : "";
        blocks.push({ kind: "tool", text: `[tool: ${block.name as string}] ${input}` });
      } else if (block.type === "tool_result") {
        blocks.push({ kind: "tool_result", text: "[tool_result]" });
      }
    }
    return blocks;
  }

  if (type === "result") {
    const result = event.result;
    if (result) return [{ kind: "meta", text: `result: ${String(result).slice(0, 200)}` }];
    return [];
  }

  return [];
}

export function formatGeminiEvent(event: Record<string, unknown>): LogBlock[] {
  if (!event || typeof event !== "object") return [];
  const type = event.type as string | undefined;
  if (!type) return [];

  if (type === "init") return [];

  if (type === "message") {
    if (event.role !== "assistant") return [];
    if (event.delta === true) return [];

    let text: string;
    const content = event.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = (content as Array<Record<string, unknown>>)
        .filter(p => p.type === "text")
        .map(p => String(p.text ?? ""))
        .join("");
    } else {
      return [];
    }

    const blocks: LogBlock[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) blocks.push({ kind: "text", text: line });
    }
    return blocks;
  }

  if (type === "tool_use") {
    const toolName = (event.tool_name as string | undefined) ?? "<unknown>";
    const parameters = event.parameters ?? {};
    return [{ kind: "tool", text: `[tool: ${toolName}] ${JSON.stringify(parameters)}` }];
  }

  if (type === "tool_result") {
    const status = event.status as string | undefined;
    if (!status || status === "ok" || status === "success") {
      return [{ kind: "tool_result", text: "[tool_result]" }];
    }
    return [{ kind: "tool_result", text: `[tool_result status=${status}]` }];
  }

  if (type === "result") {
    const stats = event.stats as Record<string, unknown> | undefined;
    const status = event.status as string | undefined;
    const parts: string[] = [];
    if (status) parts.push(`status=${status}`);
    if (stats?.total_tokens !== undefined) parts.push(`tokens=${stats.total_tokens}`);
    if (stats?.duration_ms !== undefined) parts.push(`duration=${stats.duration_ms}ms`);
    if (parts.length === 0) return [];
    return [{ kind: "meta", text: `result: ${parts.join(", ")}` }];
  }

  return [];
}
