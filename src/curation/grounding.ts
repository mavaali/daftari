// Grounding at risk (nlzr) — one-hop upstream-at-risk propagation.
//
// A document's grounding is at risk when a vault document it cites in
// `sources` (one hop up, explicit `vault:` or a legacy string that resolves)
// is itself in trouble:
//
//   contested      — party to an unresolved tension the caller can see. A
//                    contested derives_from edge counts through this: an edge
//                    contest always logs a tension (tools/edges.ts).
//   ttl-expired    — past its ttl_days since `updated` (computeStaleness, the
//                    same clock vault_read's decay banner uses).
//   validity-ended — past its valid_until (computeValidity, half-open).
//   superseded     — status superseded, or a superseded_by pointer.
//   retracted      — status deprecated or archived.
//
// The state is DERIVED, never stored: every surface (vault_receipt,
// vault_read, vault_search, the sleep wake list, the board) asks this module,
// so the classification has exactly one definition. Surfaces differ only in
// how they gather a source's state — the receipt and sleep read frontmatter,
// read/search read the index — and in the caller's vantage.
//
// RBAC: callers pass only sources the caller can read, and only tensions the
// caller can see. An unreadable source contributes nothing here — no path, no
// title, no state; the receipt's coarse `cites-unreadable-source` flag stays
// the only (existing) signal that one exists. One hop only, by design: a
// source's own sources are its own grounding's business.
//
// Advisory and Daftari-authored: no document-supplied string except the
// vault-relative source path (already visible to the caller) and tension ids
// is interpolated into `detail`, the banner, or the summary.

import { type AccessContext, canRead } from "../access/rbac.js";
import type { Frontmatter } from "../frontmatter/types.js";
import { contestedFor } from "../search/contested.js";
import { type IndexDb, outgoingSourceRows } from "../storage/index-db.js";
import { canonicalRel } from "../utils/paths.js";
import { resolveVaultSourceRef } from "./source-refs.js";
import { computeStaleness } from "./staleness.js";
import type { TensionEntry } from "./tension.js";
import { computeValidity } from "./validity.js";
import { buildPathIndexes, type LoadedDoc } from "./vault-docs.js";

export const GROUNDING_RISK_KINDS = [
  "contested",
  "ttl-expired",
  "validity-ended",
  "superseded",
  "retracted",
] as const;
export type GroundingRiskKind = (typeof GROUNDING_RISK_KINDS)[number];

// What the classifier needs to know about one readable, cited source.
export interface GroundingSourceState {
  path: string;
  status: string;
  supersededBy: string | null;
  updated: string;
  ttlDays: number | null;
  validFrom: string | null;
  validUntil: string | null;
  // Ids of the visible unresolved tensions touching the source (legacy
  // entries have none), and the true visible count.
  tensionIds: string[];
  tensionCount: number;
}

export interface GroundingRiskReason {
  source: string;
  kind: GroundingRiskKind;
  detail: string;
  tensionIds?: string[]; // contested
  expiredOn?: string; // ttl-expired: the day the TTL ran out; validity-ended: valid_until
}

export interface GroundingAtRisk {
  reasons: GroundingRiskReason[];
  banner: string;
}

const MS_PER_DAY = 86_400_000;

function addDays(dateISO: string, days: number): string | null {
  const t = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function isRetired(s: GroundingSourceState): boolean {
  return (
    s.status === "superseded" ||
    s.supersededBy !== null ||
    s.status === "deprecated" ||
    s.status === "archived"
  );
}

// The reasons one source puts its dependents at risk, in GROUNDING_RISK_KINDS
// order. Empty means healthy. A retired source reports its retirement only:
// a lapsed TTL or interval on a document nobody maintains any more is noise.
export function sourceRiskReasons(s: GroundingSourceState, now: Date): GroundingRiskReason[] {
  const out: GroundingRiskReason[] = [];

  if (s.tensionCount > 0) {
    const n = s.tensionCount;
    const ids = s.tensionIds.length > 0 ? `: ${s.tensionIds.join(", ")}` : "";
    out.push({
      source: s.path,
      kind: "contested",
      detail: `contested — party to ${n} unresolved tension${n === 1 ? "" : "s"}${ids}`,
      tensionIds: [...s.tensionIds],
    });
  }

  if (!isRetired(s)) {
    const st = computeStaleness({ updated: s.updated, ttl_days: s.ttlDays }, now);
    if (st.expired && st.ttlDays !== null) {
      const expiredOn = addDays(s.updated, Math.max(st.ttlDays, 0)) ?? s.updated;
      out.push({
        source: s.path,
        kind: "ttl-expired",
        detail: `past its ${st.ttlDays}d TTL — expired ${expiredOn} (last updated ${s.updated})`,
        expiredOn,
      });
    }
    const v = computeValidity(
      { valid_from: s.validFrom, valid_until: s.validUntil },
      now.toISOString().slice(0, 10),
    );
    if (v?.state === "expired" && s.validUntil !== null) {
      out.push({
        source: s.path,
        kind: "validity-ended",
        detail: `validity ended ${v.until}`,
        expiredOn: String(v.until),
      });
    }
  }

  if (s.status === "superseded" || s.supersededBy !== null) {
    out.push({
      source: s.path,
      kind: "superseded",
      detail: "superseded — a newer version of this source exists",
    });
  }
  if (s.status === "deprecated" || s.status === "archived") {
    out.push({ source: s.path, kind: "retracted", detail: `retracted — status ${s.status}` });
  }
  return out;
}

// The banner every read-shaped surface shows. Null-free: callers only render
// it for an at-risk result.
function renderBanner(reasons: GroundingRiskReason[]): string {
  const head =
    "⚠ GROUNDING AT RISK — a source this document cites is contested, expired, or " +
    "retracted. Re-verify the claim against its sources before relying on it.";
  return `${head}\n${reasons.map((r) => `  - ${r.source} — ${r.detail}`).join("\n")}`;
}

// Aggregates per-source reasons. Null when every source is healthy (the
// silent baseline every other derived state follows). Reasons are sorted by
// source path, then kind order, so every surface lists them identically.
export function assessGrounding(
  sources: GroundingSourceState[],
  now: Date = new Date(),
): GroundingAtRisk | null {
  const reasons: GroundingRiskReason[] = [];
  const seen = new Set<string>();
  for (const s of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    reasons.push(...sourceRiskReasons(s, now));
  }
  if (reasons.length === 0) return null;
  return { reasons, banner: renderBanner(reasons) };
}

// One line for compact channels (search summaries, the wake reason):
// "grounding at risk: <source> — <detail>[; +n more]".
export function groundingSummary(g: GroundingAtRisk): string {
  const first = g.reasons[0];
  if (!first) return "";
  const more = g.reasons.length - 1;
  return `grounding at risk: ${first.source} — ${first.detail}${more > 0 ? `; +${more} more` : ""}`;
}

// The MCP output schema for a GroundingAtRisk value — shared by vault_read,
// vault_search hits and vault_receipt sources. Lives here, beside the type,
// so the tools import it without a read.ts <-> search.ts value cycle.
export const GROUNDING_AT_RISK_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "Grounding at risk: a vault source this document cites one hop up is contested, " +
    "past its TTL or validity, superseded, or retracted. Sources the caller cannot " +
    "read are omitted entirely.",
  properties: {
    reasons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string", description: "Vault-relative path of the cited source" },
          kind: { type: "string", enum: [...GROUNDING_RISK_KINDS] },
          detail: { type: "string" },
          tensionIds: { type: "array", items: { type: "string" } },
          expiredOn: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["source", "kind", "detail"],
      },
    },
    banner: { type: "string" },
  },
  required: ["reasons", "banner"],
};

// --- state builders ----------------------------------------------------------

type GroundingFrontmatter = Pick<
  Frontmatter,
  "status" | "superseded_by" | "updated" | "ttl_days" | "valid_from" | "valid_until"
>;

export function stateFromFrontmatter(
  path: string,
  fm: GroundingFrontmatter,
  tensionIds: string[],
  tensionCount: number,
): GroundingSourceState {
  return {
    path,
    status: fm.status,
    supersededBy: fm.superseded_by ?? null,
    updated: fm.updated,
    ttlDays: fm.ttl_days ?? null,
    validFrom: fm.valid_from ?? null,
    validUntil: fm.valid_until ?? null,
    tensionIds,
    tensionCount,
  };
}

// Index-backed assessment for the read/search hot path: the cited targets come
// from the materialized `doc_links` source edges (the same resolution sleep,
// lint and the receipt use — outgoingEdges), each target's state from its
// indexed row, and its tensions from the mtime-cached contested join. Cost is
// one indexed query for the edges plus one row lookup per cited source.
//
// RBAC: a target the caller cannot read is skipped before anything about it is
// looked up; contestedFor already omits tensions whose counterpart is hidden.
// A target missing from the index (deleted) is skipped too — vanished
// grounding is the receipt's cites-broken-source and sleep's source-vanished.
export function groundingFromIndex(
  vaultRoot: string,
  db: IndexDb,
  path: string,
  access?: AccessContext,
  now: Date = new Date(),
): GroundingAtRisk | null {
  const states: GroundingSourceState[] = [];
  for (const row of outgoingSourceRows(db, path)) {
    // The row's own collection is what collectionForPath would resolve (the
    // join guarantees the row exists), so this is sourceReadable's gate.
    if (access && !canRead(access.role, row.collection)) continue;
    const ct = contestedFor(vaultRoot, db, row.path, access);
    const { collection: _collection, ...state } = row;
    states.push({
      ...state,
      tensionIds: (ct?.contested ?? []).flatMap((t) => (t.id ? [t.id] : [])),
      tensionCount: ct?.contestedCount ?? 0,
    });
  }
  return assessGrounding(states, now);
}

// Frontmatter-backed assessment for whole-vault passes (the sleep wake list,
// the board): one map over the loaded docs and the tension log, then a cheap
// per-doc lookup. Sources resolve exactly as outgoingEdges resolves them
// (explicit `vault:` plus legacy strings that name a doc), one hop.
//
// `tensions` must already be filtered to what the caller may see, and
// `readable` (absent = operator vantage, everything readable) narrows both
// the resolution universe — a hidden doc must not make a basename resolve or
// go ambiguous, the receipt's rule — and the sources assessed.
export function groundingAssessor(
  docs: LoadedDoc[],
  tensions: TensionEntry[],
  opts: { now: Date; readable?: (path: string) => boolean },
): (doc: LoadedDoc) => GroundingAtRisk | null {
  const visible = opts.readable ? docs.filter((d) => opts.readable?.(d.path)) : docs;
  const byDocPath = new Map(visible.map((d) => [d.path, d]));
  const { byPath, byBasename } = buildPathIndexes(visible);
  const tensionsByDoc = new Map<string, { ids: string[]; count: number }>();
  for (const t of tensions) {
    if (t.resolved) continue;
    for (const side of new Set([canonicalRel(t.sourceA), canonicalRel(t.sourceB)])) {
      const entry = tensionsByDoc.get(side) ?? { ids: [], count: 0 };
      entry.count += 1;
      if (t.id) entry.ids.push(t.id);
      tensionsByDoc.set(side, entry);
    }
  }
  return (doc) => {
    const states: GroundingSourceState[] = [];
    for (const raw of doc.frontmatter.sources ?? []) {
      const ref = resolveVaultSourceRef(raw, doc.path, byPath, byBasename);
      const target = ref.kind === "vault" ? ref.target : null;
      if (target === null || target === doc.path) continue;
      const src = byDocPath.get(target);
      if (!src) continue;
      const t = tensionsByDoc.get(target);
      states.push(stateFromFrontmatter(target, src.frontmatter, t?.ids ?? [], t?.count ?? 0));
    }
    return assessGrounding(states, opts.now);
  };
}
