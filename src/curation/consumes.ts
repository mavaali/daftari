// Compiled dependency graph (#233) — `consumes` edges, the third edge
// provenance class alongside declared (`sources` frontmatter) and earned
// (`derives_from`). See the 2026-07-17 through-line spec: a compiled edge is
// mechanically certain — the run demonstrably read these inputs before
// writing this artifact — which is what licenses hard tier-0/1 verdicts on
// it, unlike a declared claim or an earned inference.
//
// Producer: run correlation, not a compiler. When a write carrying a
// `run_id` lands, every path that run read beforehand (read-log.ts) becomes
// one consumes edge (artifact —consumes→ unit). No LLM, no parsing of the
// artifact; uninstrumented writes simply have no compiled edges.
//
// Store: append-only .daftari/consumes.jsonl is CANONICAL — never a SQLite
// table, because index.db is ephemeral by house rule and compile history
// must survive a reindex. Same pattern as edges.jsonl. Edges are never
// deleted or rewritten: each compile of an artifact appends a fresh edge
// group stamped with (run_id, compile_ts), and "current" is derived at read
// time as the newest compile group per artifact. History of "what did this
// artifact depend on at compile N" is a free scan of the log.
//
// v1 vocabulary, deliberately coarse (#233 discussion):
// - edge_type reflects the CONSUMPTION MODE the producer observed. The only
//   v1 mode is "whole-doc-read" (vault_read serves the entire document).
//   Future modes (field-level reads, search-hit reads) extend the taxonomy;
//   an edge always carries the mode that minted it — never untyped.
// - fields is ["*"] for whole-doc consumption: the run read everything, so
//   tier-1 field-level skips are not licensed for these edges. Honest over
//   precise; the edge-type-distribution experiment decides if finer
//   granularity pays.

import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import { readReadLog, readsForRun } from "./read-log.js";

export const CONSUMES_EDGE_TYPES = ["whole-doc-read"] as const;
export type ConsumesEdgeType = (typeof CONSUMES_EDGE_TYPES)[number];

export interface ConsumesEdge {
  artifact: string; // the written document
  unit: string; // a document the run read before writing the artifact
  edge_type: ConsumesEdgeType;
  fields: string[]; // ["*"] = whole doc (v1)
  run_id: string;
  compile_ts: string; // ISO 8601 — when the write landed
}

export function consumesPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "consumes.jsonl");
}

// Mints the consumes edges for one landed write: one edge per unique path
// the run read (excluding the artifact itself — a read-modify-write is not a
// self-dependency). A run that read nothing mints nothing. Append-only; a
// re-compile of the same artifact appends a new edge group rather than
// touching the old one.
export async function mintConsumesEdges(
  vaultRoot: string,
  input: { artifact: string; runId: string; timestamp?: string },
): Promise<Result<{ minted: number }, Error>> {
  const log = await readReadLog(vaultRoot);
  if (!log.ok) return log;
  const units = readsForRun(log.value, input.runId).filter((p) => p !== input.artifact);
  if (units.length === 0) return ok({ minted: 0 });

  const compileTs = input.timestamp ?? new Date().toISOString();
  const lines = units.map((unit) =>
    JSON.stringify({
      artifact: input.artifact,
      unit,
      edge_type: "whole-doc-read",
      fields: ["*"],
      run_id: input.runId,
      compile_ts: compileTs,
    } satisfies ConsumesEdge),
  );
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    await appendFile(consumesPath(vaultRoot), `${lines.join("\n")}\n`);
    return ok({ minted: units.length });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot append consumes edges: ${reason}`));
  }
}

// Reads every edge back, append order. Missing log → empty; corrupt lines
// skipped.
export async function listConsumesEdges(vaultRoot: string): Promise<Result<ConsumesEdge[], Error>> {
  let raw: string;
  try {
    raw = await readFile(consumesPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read consumes log: ${reason}`));
  }
  const edges: ConsumesEdge[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ConsumesEdge;
      if (typeof parsed.artifact === "string" && typeof parsed.unit === "string") {
        edges.push(parsed);
      }
    } catch {
      // Skip a corrupt line; the log is append-only and best-effort.
    }
  }
  return ok(edges);
}

// Collapses the append-only history to the CURRENT edge set: for each
// artifact, the edges of its newest compile group (latest compile_ts; ties
// resolved by append order — later lines supersede). Superseded groups stay
// in the log untouched; supersession is derived, never written.
export function currentConsumesEdges(all: ConsumesEdge[]): ConsumesEdge[] {
  const latestTs = new Map<string, string>();
  for (const e of all) {
    const seen = latestTs.get(e.artifact);
    if (seen === undefined || e.compile_ts >= seen) latestTs.set(e.artifact, e.compile_ts);
  }
  return all.filter((e) => latestTs.get(e.artifact) === e.compile_ts);
}

// Forward query: the units the artifact's current compile consumed.
export function forwardConsumes(all: ConsumesEdge[], artifact: string): ConsumesEdge[] {
  return currentConsumesEdges(all).filter((e) => e.artifact === artifact);
}

// Reverse query: the artifacts whose current compile consumed the unit —
// the dependents a change to the unit may break (tier dispatch reads this).
export function reverseConsumes(all: ConsumesEdge[], unit: string): ConsumesEdge[] {
  return currentConsumesEdges(all).filter((e) => e.unit === unit);
}
