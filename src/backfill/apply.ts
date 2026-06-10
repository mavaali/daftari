// Plan application for `daftari backfill` (§11.1).
//
// `applyPlan` reads the plan, takes only the entries under the given scope
// (per-folder ratification), and writes each doc's proposed frontmatter through
// the same primitives the write tools use: validate, serialize, then one git
// commit for the whole scope. The body is taken from the file on disk at apply
// time, so a body edited between plan and apply is preserved; only frontmatter
// is filled.
//
// --scope is required (the CLI enforces it) so a whole-vault write can never
// happen by accident. The run is idempotent: a doc whose on-disk content
// already equals the proposed serialization is left untouched, so re-applying
// an already-applied folder is a no-op (and never produces an empty commit).

import { writeFile } from "node:fs/promises";
import { recordProvenance } from "../curation/provenance.js";
import { parseDocument } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../frontmatter/schema.js";
import { ok, type Result } from "../frontmatter/types.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import { serializeDocument } from "../tools/write.js";
import { loadConfig, type SchemaExtension } from "../utils/config.js";
import { commit } from "../utils/git.js";
import { detectCollisions } from "./collisions.js";
import { planPath, readPlan } from "./plan.js";
import type { PlanEntry } from "./types.js";

// One doc the apply step could not write, with why — surfaced to the operator
// without aborting the whole scope.
export interface SkippedDoc {
  path: string;
  reason: string;
}

export interface ApplyResult {
  scope: string;
  // Docs whose frontmatter was written.
  applied: string[];
  // Docs already at their proposed state — no change needed (idempotence).
  unchanged: string[];
  // Docs that could not be written (e.g. a preserved field is itself invalid).
  skipped: SkippedDoc[];
  // Short commit hash, or null when nothing changed or auto_commit is off.
  commit: string | null;
}

// Serializes one plan entry against the file's current body. Returns the new
// file text, or a reason it cannot be written.
function renderEntry(
  entry: PlanEntry,
  currentText: string,
  extensions: SchemaExtension[],
): Result<string, Error> {
  const parsed = parseDocument(currentText);
  if (!parsed.ok) return parsed;

  // Guard: never write frontmatter the validator would reject. A non-conformant
  // doc whose *present* field is itself malformed (so preservation carries the
  // bad value through) is reported, not written.
  const { report } = validateFrontmatter(entry.proposed as unknown as Record<string, unknown>);
  if (!report.valid) {
    const collisions = detectCollisions(parsed.value.raw);
    if (collisions.length > 0) {
      const c = collisions[0] as (typeof collisions)[number];
      const more = collisions.length > 1 ? ` (and ${collisions.length - 1} more)` : "";
      return {
        ok: false,
        error: new Error(
          `collision: '${c.field}: ${c.value}' conflicts with Daftari's built-in ${c.field} ` +
            `(one of: ${c.expected.join(", ")})${more} — rename the field ` +
            `(e.g. ${c.field} → wiki_${c.field}) to keep your value; Daftari's ${c.field} ` +
            `then applies on re-run`,
        ),
      };
    }
    const summary = report.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    return { ok: false, error: new Error(`proposed frontmatter is invalid: ${summary}`) };
  }

  // Preserve any config-extension fields present on disk by passing the current
  // raw frontmatter through to the serializer.
  const text = serializeDocument(
    entry.proposed,
    parsed.value.content,
    extensions,
    parsed.value.raw,
  );
  return ok(text);
}

// Applies all plan entries under `scope`. Writes only changed docs and commits
// them in a single commit authored by `agent`.
export async function applyPlan(
  vaultRoot: string,
  scope: string,
  agent: string,
): Promise<Result<ApplyResult, Error>> {
  const plan = await readPlan(planPath(vaultRoot));
  if (!plan.ok) return plan;

  const config = loadConfig(vaultRoot);
  if (!config.ok) return config;
  const extensions = config.value.schemaExtensions;

  const inScope = plan.value.filter((e) => e.scope === scope);

  const applied: string[] = [];
  const unchanged: string[] = [];
  const skipped: SkippedDoc[] = [];

  for (const entry of inScope) {
    const resolved = resolveVaultPath(vaultRoot, entry.path);
    if (!resolved.ok) {
      skipped.push({ path: entry.path, reason: resolved.error.message });
      continue;
    }
    const existing = await readFile(resolved.value);
    if (!existing.ok) {
      skipped.push({ path: entry.path, reason: existing.error.message });
      continue;
    }

    const rendered = renderEntry(entry, existing.value, extensions);
    if (!rendered.ok) {
      skipped.push({ path: entry.path, reason: rendered.error.message });
      continue;
    }

    // Idempotence: identical bytes → no write, no stage, no commit churn.
    if (rendered.value === existing.value) {
      unchanged.push(entry.path);
      continue;
    }

    try {
      await writeFile(resolved.value, rendered.value, "utf-8");
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      skipped.push({ path: entry.path, reason: `write failed: ${reason}` });
      continue;
    }
    applied.push(entry.path);
  }

  // One commit for the whole scope. Skipped entirely when nothing changed (no
  // empty commits) or when the vault is configured with auto_commit: false.
  let commitHash: string | null = null;
  if (applied.length > 0 && config.value.autoCommit) {
    const message =
      `vault_backfill: ${scope} — ${applied.length} ` +
      `${applied.length === 1 ? "doc" : "docs"} frontmatter backfilled by ${agent}`;
    const committed = await commit(vaultRoot, applied, message, agent);
    if (!committed.ok) return committed;
    commitHash = committed.value.hash;
  }

  // Advisory provenance, per applied doc. Best-effort: a log failure does not
  // fail the backfill (the commit is the durable record).
  for (const path of applied) {
    await recordProvenance(vaultRoot, {
      tool: "vault_backfill",
      file: path,
      agent,
      action: "backfill",
    });
  }

  return ok({ scope, applied, unchanged, skipped, commit: commitHash });
}
