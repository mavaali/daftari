// src/import/langgraph-store.ts
//
// `daftari import langgraph-store <vault> --dsn <postgres> [flags]` — read a
// LangGraph BaseStore (the `store` table langgraph-checkpoint-postgres
// creates) and derive vault claim notes from its memories. Read-only by
// construction: the adapter issues a single SELECT and forces the session
// into read-only mode; there is no write path to the foreign store. The vault
// side mirrors backfill's two-step UX: --plan previews, --apply writes one
// commit.
//
// Derivation (spec: PLAN-langgraph-adapter Phase 2):
//   semantic memories  -> claim notes (one file per store row)
//   episodic memories  -> skipped in v1, counted (provenance-only)
//   procedural         -> skipped in v1, counted
// LangMem's default schema stores everything as kind "Memory" with
// { content: string } — treated as semantic. Unknown shapes are skipped and
// counted, never guessed at.

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dump } from "js-yaml";
import { commit, ensureGitRepo } from "../utils/git.js";

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E = Error>(error: E): Result<never, E> => ({ ok: false, error });

// One row of langgraph's `store` table. `prefix` is the dot-joined namespace
// tuple (verified against langgraph-checkpoint-postgres 3.1.0's DDL).
export interface StoreRow {
  prefix: string;
  key: string;
  value: unknown;
  created_at: string; // ISO timestamp
  updated_at: string;
}

// Injected query runner: the CLI wires a live pg client, tests wire a stub.
// The adapter never constructs SQL from user input without parameters.
export type QueryRunner = (sql: string, params: unknown[]) => Promise<StoreRow[]>;

export interface LanggraphImportOptions {
  vaultRoot: string;
  dsn: string;
  namespace?: string; // dot-joined prefix filter, e.g. "v1.pricing" or "v1"
  collection: string; // target folder / collection name in the vault
  agent: string; // acting identity for the apply commit
  apply: boolean;
  yes: boolean;
}

export interface DerivedNote {
  relPath: string;
  title: string;
  body: string; // full file contents (frontmatter + body)
  sourceRef: string; // langgraph-store:<prefix>/<key> — tension nodes trace here
  session: string; // last namespace segment, the session/user attribution
}

export interface ImportPlan {
  notes: DerivedNote[];
  skipped: { kind: string; count: number }[];
  byPrefix: Record<string, number>;
}

// ---------------------------------------------------------------- derivation

// Keep only characters that make stable, portable filenames.
export function slugifyKey(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "memory"
  );
}

function isoDate(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 10)
    : d.toISOString().slice(0, 10);
}

// LangMem store values look like { kind: "Memory", content: { content: "..." } }.
// Returns the memory text for semantic rows, or the kind to count as skipped.
function classify(value: unknown): { kind: string; text: string | null } {
  if (typeof value !== "object" || value === null) return { kind: "unknown", text: null };
  const v = value as Record<string, unknown>;
  const kind = typeof v.kind === "string" ? v.kind : "unknown";
  const lower = kind.toLowerCase();
  if (lower.includes("episod") || lower.includes("procedur")) return { kind, text: null };
  const content = v.content;
  if (typeof content === "string") return { kind, text: content };
  if (typeof content === "object" && content !== null) {
    const inner = (content as Record<string, unknown>).content;
    if (typeof inner === "string") return { kind, text: inner };
  }
  return { kind, text: null };
}

export function deriveNotes(rows: StoreRow[], opts: LanggraphImportOptions): ImportPlan {
  const notes: DerivedNote[] = [];
  const skippedCounts = new Map<string, number>();
  const byPrefix: Record<string, number> = {};

  for (const row of rows) {
    const { kind, text } = classify(row.value);
    if (text === null) {
      skippedCounts.set(kind, (skippedCounts.get(kind) ?? 0) + 1);
      continue;
    }
    byPrefix[row.prefix] = (byPrefix[row.prefix] ?? 0) + 1;

    const session = row.prefix.split(".").pop() ?? row.prefix;
    const title = text.split(/\s+/).slice(0, 10).join(" ");
    const sourceRef = `langgraph-store:${row.prefix}/${row.key}`;
    const relPath = join(
      opts.collection,
      session,
      `${slugifyKey(title)}--${row.key.slice(0, 8)}.md`,
    );

    const frontmatter = {
      title,
      domain: "accumulation",
      collection: opts.collection,
      status: "draft",
      confidence: "medium",
      created: isoDate(row.created_at),
      updated: isoDate(row.updated_at),
      updated_by: opts.agent,
      provenance: "direct",
      sources: [sourceRef],
      superseded_by: null,
      ttl_days: null,
      tags: ["langgraph-import", `session:${session}`],
    };

    const body = [
      "---",
      dump(frontmatter).trimEnd(),
      "---",
      "",
      text.trim(),
      "",
      "## Provenance",
      "",
      `- **Store:** langgraph \`store\` table (read-only import)`,
      `- **Namespace:** \`${row.prefix}\``,
      `- **Memory id:** \`${row.key}\``,
      `- **Memory kind:** ${kind}`,
      `- **Store created_at:** ${row.created_at}`,
      `- **Store updated_at:** ${row.updated_at}`,
      "",
    ].join("\n");

    notes.push({ relPath, title, body, sourceRef, session });
  }

  const skipped = [...skippedCounts.entries()].map(([kind, count]) => ({ kind, count }));
  return { notes, skipped, byPrefix };
}

// -------------------------------------------------------------------- store

// Single parameterized SELECT. The namespace filter matches the prefix itself
// or any descendant namespace (dot-joined encoding, case-sensitive exact
// match — mirrors langgraph's own prefix semantics).
export async function readStoreRows(
  query: QueryRunner,
  namespace?: string,
): Promise<Result<StoreRow[]>> {
  try {
    const rows = namespace
      ? await query(
          "SELECT prefix, key, value, created_at::text, updated_at::text FROM store WHERE prefix = $1 OR prefix LIKE $2 ORDER BY prefix, key",
          [namespace, `${namespace}.%`],
        )
      : await query(
          "SELECT prefix, key, value, created_at::text, updated_at::text FROM store ORDER BY prefix, key",
          [],
        );
    return ok(rows);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

// Connects via pg (dynamic import — pg is only needed for this adapter) and
// hardens the session read-only *in addition to* whatever role the DSN uses.
// Returns a QueryRunner plus a close function.
export async function connectReadOnly(
  dsn: string,
): Promise<Result<{ query: QueryRunner; close: () => Promise<void> }>> {
  let pg: typeof import("pg");
  try {
    pg = await import("pg");
  } catch {
    return err(
      new Error(
        "the 'pg' package is required for langgraph-store imports — install it with: npm install pg",
      ),
    );
  }
  const client = new pg.default.Client({ connectionString: dsn });
  try {
    await client.connect();
    // Belt and suspenders: even a read-write DSN cannot write through this
    // session. The boundary posture is enforceable, not advisory.
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    await client.query("SET default_transaction_read_only = on");
  } catch (e) {
    await client.end().catch(() => {});
    return err(e instanceof Error ? e : new Error(String(e)));
  }
  const query: QueryRunner = async (sql, params) => {
    const res = await client.query(sql, params);
    return res.rows as StoreRow[];
  };
  return ok({ query, close: () => client.end() });
}

// -------------------------------------------------------------------- runner

export function renderPlan(plan: ImportPlan, opts: LanggraphImportOptions): string {
  const lines: string[] = [];
  lines.push(`langgraph-store import plan (dry-run — nothing written)`);
  lines.push(``);
  lines.push(`  claim notes to create: ${plan.notes.length}`);
  for (const [prefix, n] of Object.entries(plan.byPrefix)) {
    lines.push(`    ${prefix}: ${n}`);
  }
  for (const s of plan.skipped) {
    lines.push(`  skipped (${s.kind}): ${s.count} — not compiled in v1, logged only`);
  }
  if (plan.notes.length > 0) {
    lines.push(``);
    lines.push(`  sample:`);
    for (const note of plan.notes.slice(0, 5)) {
      lines.push(`    ${note.relPath}`);
    }
    lines.push(``);
    lines.push(`  apply with:`);
    lines.push(
      `    daftari import langgraph-store <vault> --dsn <dsn> --apply${opts.namespace ? ` --namespace ${opts.namespace}` : ""} --yes`,
    );
  }
  return lines.join("\n") + "\n";
}

// CLI entry: parses langgraph-store-specific flags and orchestrates
// plan/apply. `vault` has already been resolved and existence-checked by
// runImport. Returns a process exit code.
export async function runLanggraphImport(vaultRoot: string, argv: string[]): Promise<number> {
  let dsn: string | undefined;
  let namespace: string | undefined;
  let collection = "langgraph";
  let agent = `human:${process.env.USER ?? "unknown"}`;
  let apply = false;
  let plan = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dsn") dsn = argv[++i];
    else if (a.startsWith("--dsn=")) dsn = a.slice(6);
    else if (a === "--namespace") namespace = argv[++i];
    else if (a.startsWith("--namespace=")) namespace = a.slice(12);
    else if (a === "--collection") collection = argv[++i] ?? collection;
    else if (a.startsWith("--collection=")) collection = a.slice(13);
    else if (a === "--agent") agent = argv[++i] ?? agent;
    else if (a.startsWith("--agent=")) agent = a.slice(8);
    else if (a === "--apply") apply = true;
    else if (a === "--plan") plan = true;
    else if (a === "--yes") yes = true;
    else {
      process.stderr.write(`daftari import langgraph-store: unknown flag '${a}'\n`);
      return 1;
    }
  }

  if (!dsn) {
    process.stderr.write("daftari import langgraph-store: --dsn <postgres-url> is required\n");
    return 1;
  }
  if (plan === apply) {
    process.stderr.write("daftari import langgraph-store: pass exactly one of --plan or --apply\n");
    return 1;
  }
  if (apply && !yes) {
    process.stderr.write(
      "daftari import langgraph-store: --apply writes notes and commits — confirm with --yes\n",
    );
    return 1;
  }

  const conn = await connectReadOnly(dsn);
  if (!conn.ok) {
    process.stderr.write(`daftari import langgraph-store: ${conn.error.message}\n`);
    return 1;
  }
  try {
    const rows = await readStoreRows(conn.value.query, namespace);
    if (!rows.ok) {
      process.stderr.write(`daftari import langgraph-store: ${rows.error.message}\n`);
      return 1;
    }
    const opts: LanggraphImportOptions = {
      vaultRoot,
      dsn,
      namespace,
      collection,
      agent,
      apply,
      yes,
    };
    const derived = deriveNotes(rows.value, opts);
    if (!apply) {
      process.stdout.write(renderPlan(derived, opts));
      return 0;
    }
    const result = await applyPlan(derived, opts);
    if (!result.ok) {
      process.stderr.write(`daftari import langgraph-store: ${result.error.message}\n`);
      return 1;
    }
    process.stdout.write(
      `langgraph-store import: wrote ${result.value.written} claim notes` +
        (result.value.commit ? ` (commit ${result.value.commit})` : "") +
        "\n",
    );
    for (const s of derived.skipped) {
      process.stdout.write(`  skipped (${s.kind}): ${s.count} — not compiled in v1\n`);
    }
    return 0;
  } finally {
    await conn.value.close();
  }
}

export async function applyPlan(
  plan: ImportPlan,
  opts: LanggraphImportOptions,
): Promise<Result<{ written: number; commit: string | null }>> {
  const ensured = await ensureGitRepo(opts.vaultRoot);
  if (!ensured.ok) return err(ensured.error);

  const relPaths: string[] = [];
  for (const note of plan.notes) {
    const abs = join(opts.vaultRoot, note.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    await writeFile(abs, note.body, "utf-8");
    relPaths.push(note.relPath);
  }
  if (relPaths.length === 0) return ok({ written: 0, commit: null });

  const committed = await commit(
    opts.vaultRoot,
    relPaths,
    `import(langgraph-store): ${relPaths.length} memories${opts.namespace ? ` from ${opts.namespace}` : ""}`,
    opts.agent,
  );
  if (!committed.ok) return err(committed.error);
  return ok({ written: relPaths.length, commit: committed.value.hash });
}
