// vault_context — task-shaped context briefs (spec 2026-07-26-context-packs-
// progressive-disclosure-design.md, Decision 2/3, final-plan Phase 2).
//
// Mirrors vaultSearch's structure (retrieve, RBAC-filter, enrich, log) but
// assembles a single token-budgeted markdown brief instead of a ranked hit
// list. No LLM call anywhere in this file — hard line, pure selection and
// templating over the index (Decision 2's "no LLM call" section).
//
// RBAC-first, omission over redaction, no existence leak (CLAUDE.md): the
// caller's readable set is applied before any budgeting, exactly as the
// tension surfaces do; a pack never names, quotes, or counts a document in
// an unreadable collection. `hidden_remainder` is a LOWER-BOUND signal over
// OBSERVABLE withholding (C4) — see the comment on `computeHiddenRemainder`.

import { type AccessContext, canRead, readableCollections } from "../access/rbac.js";
import { assembleContextPack, type ContextPack, type PackEntry } from "../context/assemble.js";
import { computeDecay } from "../curation/decay.js";
import { structuralDecay } from "../curation/structural.js";
import { bucketHiddenDownstream, type HiddenDownstream } from "../curation/tension-blast.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { CONTESTED_CAP, contestedFor } from "../search/contested.js";
import { applyCoveragePass, DEFAULT_COVERAGE_OPTIONS } from "../search/coverage.js";
import { resolveCurrentSource } from "../search/current-source.js";
import { type HybridHit, hybridSearch } from "../search/hybrid.js";
import { getDocument, type IndexDb } from "../storage/index-db.js";
import type { ToolDefinition } from "./read.js";
import {
  annotateUpstreamHits,
  ensureIndexReady,
  logServedHits,
  openIndexForActiveProvider,
  type PendingLogEntry,
} from "./search.js";

// ---------------------------------------------------------------------------
// Budget parsing (C9)
// ---------------------------------------------------------------------------

export const DEFAULT_BUDGET = 4000;
export const MIN_BUDGET = 500;
export const MAX_BUDGET = 20000;

// Non-numeric / absent / non-finite -> default (the clampPositiveInt
// silent-fallback posture, src/tools/search.ts). Below MIN_BUDGET -> error:
// silently delivering up to ~450 tokens against a stated 300 would break the
// contract the 10% headroom exists to keep. Above MAX_BUDGET -> clamp down,
// silently — the safe direction (C9).
export function parseBudget(raw: unknown): Result<number, Error> {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return ok(DEFAULT_BUDGET);
  if (raw < MIN_BUDGET) {
    return err(new Error(`vault_context: budget must be >= ${MIN_BUDGET}`));
  }
  if (raw > MAX_BUDGET) return ok(MAX_BUDGET);
  return ok(raw);
}

// ---------------------------------------------------------------------------
// Retrieval pool
// ---------------------------------------------------------------------------

// Candidate pool cap before ranking/rendering — mirrors search.ts's
// RERANK_POOL sizing rationale: bounds worst-case enrichment cost regardless
// of vault size.
const POOL_MAX = 50;
// How many of the RBAC-filtered ranked hits seed the coverage pass
// (final-plan 2.2 step 4) — deliberately wider than DEFAULT_COVERAGE_OPTIONS'
// own seedK (3): a brief's candidate pool is bigger than a search page, so
// the seed window widens to match.
const COVERAGE_SEED_K = 10;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

// One candidate after supersession dedup (final-plan 2.2 step 5), before
// head-keyed enrichment. `path` is always the entry's OWN final identity —
// the chain head for a resolved supersession, the stale doc itself for
// restricted/dangling/cycle, or the hit's own path otherwise (C3).
interface ResolvedCandidate {
  path: string;
  score: number;
  reason: string;
  snippet: string;
  supersedes?: number;
  currentSourceRestricted?: boolean;
  supersessionIssue?: "dangling" | "cycle";
}

// Supersession dedup + collapse (final-plan 2.2 step 5). A stale hit whose
// `currentSource` resolves collapses into (or joins) its head's entry —
// score = max over collapsed members, `supersedes` = collapsed count. A
// `restricted`/`dangling`/`cycle` outcome keeps the stale hit AS ITSELF,
// flagged, never substituted (the head is either unreadable or unknown).
// Returns the resolved candidates plus the count of restricted hops observed
// (C4's third hidden_remainder component).
function resolveSupersession(
  db: IndexDb,
  candidates: HybridHit[],
  access: AccessContext | undefined,
): { resolved: ResolvedCandidate[]; restrictedHops: number } {
  const heads = new Map<string, { score: number; supersedes: number; snippet: string }>();
  const standalone: ResolvedCandidate[] = [];
  let restrictedHops = 0;

  for (const hit of candidates) {
    const cs = resolveCurrentSource(db, hit.path, access);
    if (!cs) {
      standalone.push({
        path: hit.path,
        score: hit.score,
        reason: "matches task",
        snippet: hit.snippet,
      });
      continue;
    }
    if (cs.kind === "resolved") {
      const existing = heads.get(cs.path);
      if (existing) {
        existing.score = Math.max(existing.score, hit.score);
        existing.supersedes += 1;
      } else {
        // `cs.snippet` is the head's own verbatim leading content
        // (previewSnippet, src/search/current-source.ts) — daftari authors
        // the relation, never the value (Decision 3).
        heads.set(cs.path, { score: hit.score, supersedes: 1, snippet: cs.snippet });
      }
      continue;
    }
    if (cs.kind === "restricted") {
      restrictedHops += 1;
      standalone.push({
        path: hit.path,
        score: hit.score,
        reason: "matches task",
        snippet: hit.snippet,
        currentSourceRestricted: true,
      });
      continue;
    }
    // dangling | cycle — kept as itself, flagged.
    standalone.push({
      path: hit.path,
      score: hit.score,
      reason: "matches task",
      snippet: hit.snippet,
      supersessionIssue: cs.kind,
    });
  }

  const headEntries: ResolvedCandidate[] = [];
  for (const [path, { score, supersedes, snippet }] of heads) {
    headEntries.push({
      path,
      score,
      reason: `supersedes ${supersedes} older document${supersedes === 1 ? "" : "s"} matching this task`,
      snippet,
      supersedes,
    });
  }

  return { resolved: [...headEntries, ...standalone], restrictedHops };
}

// Head-keyed enrichment (final-plan 2.2 step 6 / C3): every flag is computed
// from the ENTRY'S OWN path's index row — for a collapsed chain that is the
// head, never the stale member. A missing index row (shouldn't happen for a
// `resolved` outcome; defensive) renders with no flag lines, never borrowed
// ones — the invariant assemble.ts's module comment documents.
function enrichCandidate(
  vaultRoot: string,
  db: IndexDb,
  resolved: ResolvedCandidate,
  access: AccessContext | undefined,
): PackEntry {
  const doc = getDocument(db, resolved.path);
  if (!doc) {
    return {
      path: resolved.path,
      title: resolved.path,
      score: resolved.score,
      reason: resolved.reason,
      snippet: resolved.snippet,
      ...(resolved.supersedes !== undefined ? { supersedes: resolved.supersedes } : {}),
      ...(resolved.currentSourceRestricted ? { currentSourceRestricted: true } : {}),
      ...(resolved.supersessionIssue ? { supersessionIssue: resolved.supersessionIssue } : {}),
    };
  }

  const decay = computeDecay({
    status: doc.status,
    confidence: doc.confidence,
    updated: doc.updated,
    created: doc.created,
    ttl_days: doc.ttlDays,
    superseded_by: doc.supersededBy,
  });
  const structuralRaw = structuralDecay({ db, path: resolved.path, status: doc.status, access });
  const structural = structuralRaw
    ? {
        orphan: structuralRaw.orphan,
        deprecatedStillLinked: structuralRaw.deprecated_still_linked !== null,
      }
    : null;
  const contested = contestedFor(vaultRoot, db, resolved.path, access);

  return {
    path: resolved.path,
    title: doc.title,
    score: resolved.score,
    reason: resolved.reason,
    snippet: resolved.snippet,
    ...(resolved.supersedes !== undefined ? { supersedes: resolved.supersedes } : {}),
    ...(resolved.currentSourceRestricted ? { currentSourceRestricted: true } : {}),
    ...(resolved.supersessionIssue ? { supersessionIssue: resolved.supersessionIssue } : {}),
    decay,
    structural,
    ...(contested
      ? {
          tensions: contested.contested.slice(0, CONTESTED_CAP).map((t) => ({
            kind: t.kind,
            counterpart: t.counterpart,
            claimSelf: t.claimSelf,
            claimOther: t.claimOther,
          })),
          contestedCount: contested.contestedCount,
        }
      : {}),
    provenance: { updatedBy: doc.updatedBy, updated: doc.updated },
  };
}

// C4: hidden_remainder is a LOWER-BOUND signal over OBSERVABLE withholding,
// never a completeness claim. The vector half of retrieval is KNN-pushdown
// scrubbed of unreadable collections (2026-07-26 fusion spec, Decision 3), so
// it can never produce an RBAC-droppable candidate — a semantically-relevant,
// lexically-quiet hidden document is structurally invisible to this count.
// "none" means "no withholding observed", never "nothing withheld". Counted:
// (a) RBAC-dropped BM25-side pool candidates, (b) RBAC-dropped coverage-pass
// additions, (c) restricted supersession hops.
function computeHiddenRemainder(hiddenDropped: number): HiddenDownstream {
  return bucketHiddenDownstream(hiddenDropped);
}

export async function vaultContext(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<ContextPack, Error>> {
  const task = args.task;
  if (typeof task !== "string" || task.trim().length === 0) {
    return err(new Error("vault_context requires a non-empty 'task' argument"));
  }
  const budgetResult = parseBudget(args.budget);
  if (!budgetResult.ok) return budgetResult;
  const budget = budgetResult.value;

  const ready = await ensureIndexReady(vaultRoot);
  if (!ready.ok) return ready;

  const dbResult = openIndexForActiveProvider(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  try {
    // 3. Retrieve, over-fetch, RBAC-filter (before any budgeting — CLAUDE.md).
    const searchResult = await hybridSearch(db, task, {
      limit: POOL_MAX,
      overFetch: true,
      readableCollections: access ? readableCollections(access.role) : undefined,
    });
    if (!searchResult.ok) return searchResult;

    let hiddenDropped = 0;
    const permitted = access
      ? searchResult.value.hits.filter((h) => {
          const readable = canRead(access.role, h.collection);
          if (!readable) hiddenDropped += 1;
          return readable;
        })
      : searchResult.value.hits;
    const pool = permitted.slice(0, POOL_MAX);

    // 4. Coverage pass, seeded from the top COVERAGE_SEED_K permitted hits.
    // RBAC-filter the additions the same way; a dropped addition is the B′
    // edge-attached case (2026-07-14 spec).
    const seeds = pool.slice(0, COVERAGE_SEED_K);
    const covered = applyCoveragePass(db, seeds, DEFAULT_COVERAGE_OPTIONS);
    const rawAdds = covered.slice(seeds.length);
    const poolPaths = new Set(pool.map((h) => h.path));
    const coverageAdds = rawAdds.filter((h) => !poolPaths.has(h.path));
    const permittedAdds = access
      ? coverageAdds.filter((h) => {
          const readable = canRead(access.role, h.collection);
          if (!readable) hiddenDropped += 1;
          return readable;
        })
      : coverageAdds;
    const candidates = [...pool, ...permittedAdds];

    // 5. Supersession dedup — chain heads collapse, restricted/dangling/cycle
    // hops stay as themselves and flag (C4's restricted-hop tally folds in).
    const { resolved, restrictedHops } = resolveSupersession(db, candidates, access);
    hiddenDropped += restrictedHops;

    // 6. Head-keyed enrichment (C3). No logging in this step.
    const entries: PackEntry[] = resolved.map((r) => enrichCandidate(vaultRoot, db, r, access));

    // Upstream buckets (#234), batched over one synthetic hit per final
    // entry — annotateUpstreamHits mutates pendingBrokenUpstream /
    // hiddenPendingUpstream on the hit it's given, keyed on `path`, which is
    // already the entry's own (head, for a collapsed chain) path.
    const synthHits: HybridHit[] = entries.map((e) => ({
      path: e.path,
      title: e.title,
      collection: "",
      status: "",
      score: 0,
      bm25Score: 0,
      vectorScore: 0,
      snippet: "",
      decay: null,
    }));
    const pendingEntries: PendingLogEntry[] = await annotateUpstreamHits(
      vaultRoot,
      db,
      synthHits,
      access,
    );
    const upstreamByPath = new Map(synthHits.map((h) => [h.path, h]));
    for (const entry of entries) {
      const h = upstreamByPath.get(entry.path);
      if (h?.pendingBrokenUpstream || h?.hiddenPendingUpstream) {
        entry.upstream = {
          ...(h.pendingBrokenUpstream ? { pendingBrokenUpstream: h.pendingBrokenUpstream } : {}),
          ...(h.hiddenPendingUpstream ? { hiddenPendingUpstream: h.hiddenPendingUpstream } : {}),
        };
      }
    }

    // 7. Rank, render, cut to budget — pure, deterministic (src/context/assemble.ts).
    const hiddenRemainder = computeHiddenRemainder(hiddenDropped);
    const pack = assembleContextPack(task, budget, entries, hiddenRemainder);

    // 8. Log served hits — ONLY the entries that survived the budget cut
    // (C1), keyed on the rendered (head) paths.
    const includedPaths = new Set(pack.manifest.included.map((e) => e.path));
    const pendingByPath = new Map(pendingEntries.map((e) => [e.file, e]));
    const toLog: PendingLogEntry[] = [];
    for (const path of includedPaths) {
      const pending = pendingByPath.get(path);
      toLog.push(
        pending ?? { file: path, ...(access?.user != null ? { principal: access.user } : {}) },
      );
    }
    await logServedHits(vaultRoot, "vault_context", toLog);

    return ok(pack);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// MCP tool definition
// ---------------------------------------------------------------------------

const PACK_ENTRY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string" },
    score: { type: "number" },
    reason: { type: "string" },
  },
  required: ["path", "score", "reason"],
  additionalProperties: false,
};

const CONTEXT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    task: { type: "string" },
    budget: { type: "integer" },
    estimatedTokens: {
      type: "integer",
      description: "chars/4 estimate of the whole brief, including header and footer.",
    },
    brief: {
      type: "string",
      description:
        "The model-facing markdown brief. Selected, not synthesized — every " +
        "line is an index fact (score, snippet, decay, tensions with both " +
        "claims, staleness, provenance); never a sentence daftari composed " +
        "about the truth of vault content.",
    },
    manifest: {
      type: "object",
      properties: {
        included: { type: "array", items: PACK_ENTRY_SCHEMA },
        omitted_over_budget: { type: "integer", minimum: 0 },
        hidden_remainder: {
          type: "string",
          enum: ["none", "some", "many"],
          description:
            "A LOWER-BOUND signal over observable withholding (RBAC-dropped " +
            "BM25-side candidates, dropped coverage additions, restricted " +
            "supersession hops) — never a completeness claim. The vector " +
            "half of retrieval is RBAC-pushdown-scrubbed, so a semantically- " +
            "relevant but lexically-quiet hidden document is structurally " +
            "invisible to this count; 'none' means 'no withholding " +
            "observed', not 'nothing withheld'.",
        },
      },
      required: ["included", "omitted_over_budget", "hidden_remainder"],
      additionalProperties: false,
    },
  },
  required: ["task", "budget", "estimatedTokens", "brief", "manifest"],
  additionalProperties: false,
};

function summarizeContext(value: unknown): string {
  const r = value as ContextPack;
  return r.brief;
}

function docLinksContext(value: unknown): string[] {
  const r = value as ContextPack;
  return r.manifest.included.map((e) => e.path);
}

export const contextTools: ToolDefinition[] = [
  {
    name: "vault_context",
    title: "Assemble a task context brief",
    oneLine: "Assemble a token-budgeted brief of the most relevant documents for a task.",
    annotations: { readOnlyHint: true },
    description:
      "Assemble a token-budgeted brief for a task: the most relevant current " +
      "documents, with open tensions, staleness, and provenance flagged " +
      "inline. Selects and annotates only — never synthesizes. A tension " +
      "shows both claims and status:open, never a blended verdict; " +
      "supersession points at the current source, never paraphrases it. " +
      "Cites paths; drill in with vault_read.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Free-text description of the task at hand." },
        budget: {
          type: "number",
          description:
            `Token budget for the brief. Default ${DEFAULT_BUDGET}. Must be >= ` +
            `${MIN_BUDGET} (an error otherwise — a stated budget is a contract); ` +
            `values above ${MAX_BUDGET} clamp down silently.`,
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    outputSchema: CONTEXT_OUTPUT_SCHEMA,
    summarize: summarizeContext,
    docLinks: docLinksContext,
    handler: (vaultRoot, args, access) => vaultContext(vaultRoot, args, access),
  },
];
