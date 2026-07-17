// vault_tier1 — "what does this change to unit X affect?", answered
// deterministically (#232 Tier 1). Gathers the unit's dependents across all
// three edge provenance classes (compiled consumes, declared sources, earned
// derives_from), derives the changed-field set from the unit's latest
// provenance entry (or an explicit changed_fields override), and dispatches
// per the through-line spec's class-bounded verdict rule. Zero LLM calls —
// the summary's resolved_at_tier1 says whether any dependent still needs
// the tier-2 semantic queue.
//
// RBAC (#217, same rule as vault_consumes/vault_edges): any-read gate; a
// verdict names the anchor and one dependent, so it is listed only when the
// caller can read BOTH — invisible verdicts are omitted from the list, the
// counts, and the summary, never redacted. An unreadable anchor yields an
// empty result, indistinguishable from a nonexistent one.

import { relative, resolve } from "node:path";
import { type AccessContext, hasAnyRead } from "../access/rbac.js";
import { listConsumesEdges, reverseConsumes } from "../curation/consumes.js";
import { listEdges } from "../curation/edges.js";
import { readProvenanceLog } from "../curation/provenance.js";
import { sourceReadable } from "../curation/tension-access.js";
import { buildReverseSourceMap } from "../curation/tension-blast.js";
import {
  changedFieldsFromProvenance,
  contentChangedFields,
  type Tier1Summary,
  type Tier1Verdict,
  tier1Dispatch,
  tier1Summary,
} from "../curation/tier1.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { resolveVaultPath } from "../storage/local.js";
import type { ToolDefinition } from "./read.js";
import { openIndexForAccessOrNull } from "./search.js";

export interface Tier1Result {
  unit: string;
  changed_fields: string[];
  // Where the change came from: "provenance" (latest logged write to the
  // unit) or "explicit" (caller-supplied changed_fields).
  change_source: "provenance" | "explicit";
  verdicts: Tier1Verdict[];
  summary: Tier1Summary;
}

function canonicalRelPath(vaultRoot: string, relPath: string): Result<string, Error> {
  const resolved = resolveVaultPath(vaultRoot, relPath.trim());
  if (!resolved.ok) return resolved;
  return ok(relative(resolve(vaultRoot), resolved.value.absPath));
}

export async function vaultTier1(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<Tier1Result, Error>> {
  if (access && !hasAnyRead(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot use vault_tier1`));
  }

  if (typeof args.unit !== "string" || args.unit.trim().length === 0) {
    return err(new Error("vault_tier1 requires a non-empty 'unit' argument"));
  }
  const unit = canonicalRelPath(vaultRoot, args.unit);
  if (!unit.ok) return unit;

  // Anchor readability is decided BEFORE anything is derived from the unit.
  // changed_fields comes from the unit's provenance — metadata about a doc
  // the caller may not read — and the no-provenance error would otherwise
  // confirm whether an unreadable path has write history. An unreadable
  // anchor must behave byte-identically to a nonexistent one on every path.
  let anchorReadable = true;
  if (access) {
    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      anchorReadable = sourceReadable(db, access, unit.value);
    } finally {
      db?.close();
    }
  }
  const noProvenanceError = () =>
    err(
      new Error(
        `vault_tier1: no provenance entry for ${unit.value} — pass 'changed_fields' ` +
          `explicitly to describe the change`,
      ),
    );

  // The changed-field set: explicit override, else the unit's latest logged
  // write. Explicit lets a caller ask "what WOULD touching these fields
  // affect" before writing anything.
  let changedFields: string[];
  let changeSource: "provenance" | "explicit";
  if (args.changed_fields !== undefined && args.changed_fields !== null) {
    if (
      !Array.isArray(args.changed_fields) ||
      !args.changed_fields.every((f) => typeof f === "string")
    ) {
      return err(new Error("vault_tier1 'changed_fields' must be an array of strings"));
    }
    changedFields = contentChangedFields(args.changed_fields);
    changeSource = "explicit";
  } else {
    // Unreadable anchor: the exact error a provenance-less path produces —
    // the log is never read, so the response cannot depend on whether the
    // hidden path has history.
    if (!anchorReadable) return noProvenanceError();
    const log = await readProvenanceLog(vaultRoot);
    if (!log.ok) return log;
    const writes = log.value.filter((e) => e.file === unit.value && e.action !== "rejected_stale");
    const latest = writes[writes.length - 1];
    if (!latest) return noProvenanceError();
    changedFields = changedFieldsFromProvenance(latest);
    changeSource = "provenance";
  }

  // Dependents per edge class.
  const allConsumes = await listConsumesEdges(vaultRoot);
  if (!allConsumes.ok) return allConsumes;
  const compiled = reverseConsumes(allConsumes.value, unit.value);

  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;
  const declaredDependents = [...(buildReverseSourceMap(loaded.value).get(unit.value) ?? [])];

  // derives_from: `to` is the premise, so the unit's dependents are the
  // from-paths of live (non-revoked) edges pointing at it.
  const earned = await listEdges(vaultRoot, { toPath: unit.value });
  if (!earned.ok) return earned;
  const earnedDependents = earned.value
    .filter((e) => e.status !== "revoked")
    .map((e) => e.fromPath);

  let verdicts = tier1Dispatch({
    unit: unit.value,
    changedFields,
    compiled,
    declaredDependents,
    earnedDependents,
  });

  // #217 decision A: both endpoints readable or the verdict is omitted —
  // from the list AND the summary counts. (The unreadable-anchor case only
  // reaches here with caller-supplied changed_fields; its verdicts empty out
  // entirely, matching a nonexistent anchor's dependent-less result.)
  if (access) {
    if (!anchorReadable) {
      verdicts = [];
    } else {
      const db = openIndexForAccessOrNull(vaultRoot);
      try {
        verdicts = verdicts.filter((v) => sourceReadable(db, access, v.artifact));
      } finally {
        db?.close();
      }
    }
  }

  return ok({
    unit: unit.value,
    changed_fields: changedFields,
    change_source: changeSource,
    verdicts,
    summary: tier1Summary(verdicts),
  });
}

export const tier1Tools: ToolDefinition[] = [
  {
    name: "vault_tier1",
    title: "Type-directed change dispatch (tier 1)",
    annotations: { readOnlyHint: true },
    description:
      "Deterministic, LLM-free compatibility dispatch for a changed document " +
      "(#232 tier 1). Walks the unit's dependents across all three edge " +
      "provenance classes and returns a class-bounded verdict per dependent: " +
      "compiled consumes edges give certain 'unaffected'/'affected' (field " +
      "overlap vs. the change), declared sources give 'possibly-affected' (a " +
      "claim), earned derives_from edges give 'semantic-review' (the tier-2 " +
      "queue — an inference never decides). A bookkeeping-only change is " +
      "'unaffected' everywhere. The change is derived from the unit's latest " +
      "provenance entry (frontmatter diff + body_changed), or pass " +
      "changed_fields to ask about a hypothetical change ('body' counts as a " +
      "field). summary.resolved_at_tier1 is true when nothing needs semantic " +
      "review — the change was fully decided without an LLM.",
    inputSchema: {
      type: "object",
      properties: {
        unit: {
          type: "string",
          description: "Vault-relative path of the changed (or about-to-change) document",
        },
        changed_fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional explicit change description: frontmatter keys and/or " +
            "'body'. Omit to derive from the unit's latest provenance entry.",
        },
      },
      required: ["unit"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultTier1(vaultRoot, args, access),
  },
];
