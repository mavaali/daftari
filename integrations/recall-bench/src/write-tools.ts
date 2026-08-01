// Write-capable tool surface for authoring agent loops.
//
// Composes the existing read-only buildToolSurface with four write tools:
//   vault_write, vault_supersede  — from dist/tools/write.js
//   vault_tension_log             — from dist/tools/curation.js
//   vault_tension_clusters        — from dist/tools/curation.js
//
// The handler throws on a Result error so the agent loop surfaces failures
// rather than silently swallowing them.

import { buildToolSurface } from "../../../dist/eval/tool-surface.js";
import { vaultWrite, vaultSupersede, writeTools } from "../../../dist/tools/write.js";
import {
  vaultTensionLog,
  vaultTensionClusters,
  curationTools,
} from "../../../dist/tools/curation.js";
import type { ToolDefinition } from "../../../dist/tools/read.js";

// Tool names added by this surface (beyond the read surface).
const WRITE_TOOL_NAMES = new Set([
  "vault_write",
  "vault_supersede",
  "vault_tension_log",
  "vault_tension_clusters",
]);

// Pull the ToolDefinition entries for the four write tools from the canonical
// arrays, so the defs stay in sync with the implementation automatically.
function selectDefs(
  pool: ToolDefinition[],
  names: string[],
): ToolDefinition[] {
  return names
    .map((n) => pool.find((d) => d.name === n))
    .filter((d): d is ToolDefinition => d !== undefined);
}

const writeSurfaceDefs: ToolDefinition[] = [
  ...selectDefs(writeTools, ["vault_write", "vault_supersede"]),
  ...selectDefs(curationTools, ["vault_tension_log", "vault_tension_clusters"]),
];

// Unwrap a Result, throwing on error. Mirrors the unwrap pattern in
// dist/eval/tool-surface.js but lives here to avoid reaching into internals.
function unwrapResult<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export interface WriteSurface {
  defs: ToolDefinition[];
  handler: (name: string, input: unknown) => Promise<unknown>;
}

export function buildWriteToolSurface(vaultRoot: string): WriteSurface {
  const readSurface = buildToolSurface(vaultRoot);

  const defs: ToolDefinition[] = [...readSurface.defs, ...writeSurfaceDefs];

  const handler = async (name: string, input: unknown): Promise<unknown> => {
    // biome-ignore lint/suspicious/noExplicitAny: tool inputs are structural JSON from the LLM
    const inp = (input ?? {}) as Record<string, unknown>;

    switch (name) {
      case "vault_write":
        return unwrapResult(await vaultWrite(vaultRoot, inp, undefined));

      case "vault_supersede":
        return unwrapResult(await vaultSupersede(vaultRoot, inp, undefined));

      case "vault_tension_log":
        return unwrapResult(await vaultTensionLog(vaultRoot, inp, undefined));

      case "vault_tension_clusters":
        return unwrapResult(await vaultTensionClusters(vaultRoot, inp, undefined));

      default:
        return readSurface.handler(name, input);
    }
  };

  return { defs, handler };
}
