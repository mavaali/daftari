// fanout.ts — broadcast a single tool call to every child vault concurrently.
//
// Per-child failures (thrown exceptions or isError responses) are captured as
// ok: false rows rather than propagating. The caller decides how to surface
// them (the mergers pass errors through without failing the aggregate result).

import type { ChildPool } from "../children.js";
import type { VaultResult } from "./merge.js";

export async function fanoutCall<T = unknown>(
  pool: ChildPool,
  tool: string,
  args: Record<string, unknown>,
): Promise<VaultResult<T>[]> {
  // Strip the router-level `vault` arg — children don't know about it.
  const rest = { ...args };
  delete rest.vault;

  const calls = pool.all().map(async (c): Promise<VaultResult<T>> => {
    try {
      const r = await c.callTool(tool, rest);
      if (r.isError) {
        const text = (r.content?.[0] as { text?: string })?.text ?? "unknown error";
        return { vault: c.name, ok: false, error: text };
      }
      // The typed result rides `structuredContent` (daftari spec 2026-07-26,
      // Decision 3). `content` is the model-facing channel and carries a
      // prose summary for tools that declare one, so it is only a fallback
      // — for children old enough to predate structured output, where a
      // single text block still holds JSON.
      if (r.structuredContent !== undefined) {
        return { vault: c.name, ok: true, value: r.structuredContent as T };
      }
      const text = (r.content?.[0] as { text?: string })?.text ?? "null";
      return { vault: c.name, ok: true, value: JSON.parse(text) as T };
    } catch (e) {
      return {
        vault: c.name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  return Promise.all(calls);
}
