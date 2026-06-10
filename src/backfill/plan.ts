// Plan generation and the plan file for `daftari backfill` (§11.1).
//
// `generatePlan` walks the vault (or a scope), classifies every doc, derives
// proposed frontmatter for the non-conformant ones, and writes one PlanEntry
// per line to .daftari/backfill-plan.jsonl. It modifies no markdown file — the
// plan is a staging surface a human ratifies per folder via `--apply`. The run
// is idempotent: re-running overwrites the plan cleanly.
//
// The plan file is transient state (the apply commit is the durable audit
// trail), so backfill never commits it.

import { readFile as fsReadFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { fileGitMeta } from "../utils/git.js";
import { detectCollisions } from "./collisions.js";
import { projectCoverage } from "./coverage.js";
import { classifyDoc, deriveProposed } from "./derive.js";
import type { BackfillSummary, PlanEntry } from "./types.js";

export function planPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "backfill-plan.jsonl");
}

// The folder a doc is ratified under: its first path component. Root-level docs
// (no `/`) have no folder and yield "".
export function scopeOf(relPath: string): string {
  const slash = relPath.indexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

// fs mtime as a YYYY-MM-DD string, the fallback when git has no history.
async function mtimeDate(absPath: string): Promise<string> {
  const s = await stat(absPath);
  return s.mtime.toISOString().slice(0, 10);
}

export interface GeneratePlanOptions {
  // Restrict the walk to a single folder (first path component). Absent walks
  // the whole vault.
  scope?: string;
  identityMap: Record<string, string>;
  // CLI invoker identity, used as the last-resort updated_by fallback.
  invoker: string;
  // Optional progress hook, called once per file visited with the running
  // count and the total. The walk runs two git subprocesses per non-conformant
  // doc, sequentially — a large wiki can take tens of seconds, so the CLI wires
  // this to a throttled stderr heartbeat. Kept out of generatePlan so the
  // function stays pure and testable.
  onProgress?: (done: number, total: number) => void;
}

export interface GeneratePlanResult {
  summary: BackfillSummary;
  entries: PlanEntry[];
  planPath: string;
}

// Walks the vault and writes the backfill plan. Returns the summary and the
// entries written.
export async function generatePlan(
  vaultRoot: string,
  opts: GeneratePlanOptions,
): Promise<Result<GeneratePlanResult, Error>> {
  const listed = await listFiles(vaultRoot);
  if (!listed.ok) return listed;

  const entries: PlanEntry[] = [];
  const summary: BackfillSummary = {
    missing: 0,
    partial: 0,
    conformant: 0,
    rootSkipped: 0,
    byScope: {},
    planned: 0,
    coverage: {},
    collisions: [],
  };

  const total = listed.value.length;
  let visited = 0;
  for (const relPath of listed.value) {
    visited += 1;
    opts.onProgress?.(visited, total);
    const scope = scopeOf(relPath);
    if (opts.scope !== undefined && scope !== opts.scope) continue;

    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) return resolved;
    const source = await readFile(resolved.value);
    if (!source.ok) return source;

    const parsed = parseDocument(source.value);
    // A doc with unparseable YAML can't be classified or merged safely — leave
    // it for the human. Surface it as partial so the count reflects work left.
    if (!parsed.ok) {
      summary.partial += 1;
      continue;
    }

    const classification = classifyDoc(parsed.value.raw);
    if (classification === "conformant") {
      summary.conformant += 1;
      continue;
    }

    // Non-conformant but unaddressable: a root-level doc has no collection
    // folder, and backfill is folder-scoped. Count it and move on.
    if (scope === "") {
      summary.rootSkipped += 1;
      continue;
    }

    if (classification === "missing") summary.missing += 1;
    else summary.partial += 1;

    const git = await fileGitMeta(vaultRoot, relPath);
    const { proposed, derivation } = deriveProposed({
      relPath,
      body: parsed.value.content,
      raw: parsed.value.raw,
      git,
      mtimeDate: await mtimeDate(resolved.value),
      identityMap: opts.identityMap,
      invoker: opts.invoker,
    });

    entries.push({
      path: relPath,
      current: parsed.value.raw,
      proposed,
      derivation,
      scope,
      collisions: detectCollisions(parsed.value.raw),
    });
    summary.byScope[scope] = (summary.byScope[scope] ?? 0) + 1;
    summary.planned += 1;
  }

  // Per-scope coverage + a flat collision list for the summary (#116).
  const byScopeEntries = new Map<string, PlanEntry[]>();
  for (const e of entries) {
    const list = byScopeEntries.get(e.scope) ?? [];
    list.push(e);
    byScopeEntries.set(e.scope, list);
    for (const c of e.collisions) summary.collisions.push({ ...c, path: e.path });
  }
  for (const [scope, scoped] of byScopeEntries) {
    summary.coverage[scope] = projectCoverage(scoped);
  }

  const path = planPath(vaultRoot);
  const written = await writePlan(path, entries);
  if (!written.ok) return written;

  return ok({ summary, entries, planPath: path });
}

// Serializes entries to JSONL (one entry per line). An empty plan writes an
// empty file — a valid, re-readable plan with zero entries.
export async function writePlan(path: string, entries: PlanEntry[]): Promise<Result<void, Error>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    await writeFile(path, entries.length > 0 ? `${body}\n` : "", "utf-8");
    return ok(undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot write backfill plan: ${reason}`));
  }
}

// Reads a plan file back into entries. A missing plan is an error — apply
// requires a plan to have been generated first. A malformed line fails loud.
export async function readPlan(path: string): Promise<Result<PlanEntry[], Error>> {
  let text: string;
  try {
    text = await fsReadFile(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return err(new Error(`no backfill plan at ${path} — run 'daftari backfill --plan' first`));
    }
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read backfill plan: ${reason}`));
  }

  const entries: PlanEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const preview = line.length > 80 ? `${line.slice(0, 80)}…` : line;
      return err(new Error(`malformed backfill plan: line ${i + 1} is not valid JSON: ${preview}`));
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as PlanEntry).path !== "string" ||
      typeof (parsed as PlanEntry).scope !== "string" ||
      typeof (parsed as PlanEntry).proposed !== "object"
    ) {
      return err(new Error(`malformed backfill plan: line ${i + 1} is missing required fields`));
    }
    const entry = parsed as PlanEntry;
    if (!Array.isArray(entry.collisions)) entry.collisions = [];
    entries.push(entry);
  }
  return ok(entries);
}
