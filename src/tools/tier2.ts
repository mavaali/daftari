// vault_tier2_queue / vault_tier2_verdict — the tier-2 protocol surface
// (#232). The server does NOT run an LLM: the calling agent is the judge.
// The queue tool prepares the constrained judgments (specific claim against
// specific usage — never "do these two documents conflict"); the verdict
// tool records the typed answer and, for a break, logs a real tension
// through the existing taxonomy. See src/curation/tier2.ts for the model.
//
// RBAC (#217): any-read gate on both tools. A queue item names two
// documents, so it is listed only when the caller can read BOTH — omission,
// no counts, no coarse remainder (lists omit; only summaries coarsen). A
// verdict on a pair the caller cannot fully read is refused with the SAME
// error a pair with nothing pending produces — no existence signal.

import { type AccessContext, hasAnyRead } from "../access/rbac.js";
import { type UpstreamStaleness, upstreamStaleness } from "../curation/edge-staleness.js";
import { listEdges } from "../curation/edges.js";
import { type ProvenanceEntry, readProvenanceLog } from "../curation/provenance.js";
import {
  addTension,
  LOGGABLE_TENSION_KINDS,
  type LoggableTensionKind,
} from "../curation/tension.js";
import { sourceReadable } from "../curation/tension-access.js";
import type { Tier1EdgeClass } from "../curation/tier1.js";
import {
  accumulateFieldChanges,
  extractUsageSpan,
  type FieldChange,
  latestUnitChangeTs,
  NO_CHANGE_TS,
  readTier2Verdicts,
  recordTier2Verdict,
  type Tier2Verdict,
} from "../curation/tier2.js";
import { type LoadedDoc, loadDocuments } from "../curation/vault-docs.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { canonicalVaultRelPath } from "../storage/local.js";
import { readRunId } from "../utils/run-id.js";
import type { ToolDefinition } from "./read.js";
import { openIndexForAccessOrNull } from "./search.js";

export interface Tier2WorkItem {
  artifact: string;
  unit: string;
  edge_class: Exclude<Tier1EdgeClass, "compiled">;
  baseline: string | null;
  changed_fields: string[];
  // Net per-field change since the baseline (first before → last after).
  // `body` appears with nulls — the log stores only the flag; read the unit
  // for its current content.
  field_changes: Record<string, FieldChange>;
  // The dependent's lines that mention the unit, with context — the
  // "specific usage" half of the constrained judgment. Null when nothing
  // matched; read the dependent in full then.
  usage_span: string | null;
  question: string;
}

export interface Tier2QueueResult {
  items: Tier2WorkItem[];
  total: number;
}

export interface Tier2VerdictResult {
  recorded: Tier2Verdict;
  tension_id: string | null;
}

// Everything the queue derivation reads, loaded once.
interface QueueSources {
  provenance: ProvenanceEntry[];
  verdicts: Tier2Verdict[];
  docs: LoadedDoc[];
  earnedByFrom: Map<string, { unit: string; lastRederived: string }[]>;
}

async function loadQueueSources(vaultRoot: string): Promise<Result<QueueSources, Error>> {
  const provenance = await readProvenanceLog(vaultRoot);
  if (!provenance.ok) return provenance;
  const verdicts = await readTier2Verdicts(vaultRoot);
  if (!verdicts.ok) return verdicts;
  const docs = await loadDocuments(vaultRoot);
  if (!docs.ok) return docs;
  const edges = await listEdges(vaultRoot);
  if (!edges.ok) return edges;
  const earnedByFrom = new Map<string, { unit: string; lastRederived: string }[]>();
  for (const e of edges.value) {
    if (e.status === "revoked") continue;
    const list = earnedByFrom.get(e.fromPath) ?? [];
    list.push({ unit: e.toPath, lastRederived: e.lastRederived });
    earnedByFrom.set(e.fromPath, list);
  }
  return ok({
    provenance: provenance.value,
    verdicts: verdicts.value,
    docs: docs.value,
    earnedByFrom,
  });
}

// The artifact's pending-unchecked rows — the tier-2 residual. Compiled
// edges are excluded at the source (consumes: []): tier 1 decides them
// mechanically and they never queue.
function residualRows(sources: QueueSources, doc: LoadedDoc): UpstreamStaleness[] {
  return upstreamStaleness({
    artifact: doc.path,
    consumes: [],
    provenance: sources.provenance,
    declaredUnits: doc.frontmatter.sources,
    earned: sources.earnedByFrom.get(doc.path) ?? [],
    verdicts: sources.verdicts,
  }).filter((r) => r.staleness === "pending-unchecked");
}

function workItem(sources: QueueSources, doc: LoadedDoc, row: UpstreamStaleness): Tier2WorkItem {
  const unitDoc = sources.docs.find((d) => d.path === row.unit);
  const fieldChanges =
    row.baseline === null
      ? accumulateFieldChanges(sources.provenance, row.unit, NO_CHANGE_TS)
      : accumulateFieldChanges(sources.provenance, row.unit, row.baseline);
  const span = extractUsageSpan(doc.content, {
    path: row.unit,
    title: unitDoc?.frontmatter.title,
  });
  const changeDesc =
    row.changed_fields.length > 0
      ? `changed [${row.changed_fields.join(", ")}]`
      : "has never been checked against this dependent";
  return {
    artifact: doc.path,
    unit: row.unit,
    edge_class: row.edge_class as Exclude<Tier1EdgeClass, "compiled">,
    baseline: row.baseline,
    changed_fields: row.changed_fields,
    field_changes: fieldChanges,
    usage_span: span,
    question:
      `${row.unit} ${changeDesc}` +
      `${row.baseline ? ` since ${row.baseline}` : ""}. ${doc.path} depends on it via a ` +
      `${row.edge_class} edge. Given field_changes and the dependent's usage ` +
      `(usage_span, or read the documents), does the dependent's claim still hold? ` +
      `Record the judgment with vault_tier2_verdict: 'still-valid', or 'broken' with a ` +
      `tension_kind (${LOGGABLE_TENSION_KINDS.join(" | ")}) and both claims.`,
  };
}

export async function vaultTier2Queue(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<Tier2QueueResult, Error>> {
  if (access && !hasAnyRead(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot use vault_tier2_queue`));
  }
  let unitFilter: string | null = null;
  if (args.unit !== undefined && args.unit !== null) {
    if (typeof args.unit !== "string" || args.unit.trim().length === 0) {
      return err(new Error("vault_tier2_queue 'unit' must be a non-empty string"));
    }
    const canon = canonicalVaultRelPath(vaultRoot, args.unit);
    if (!canon.ok) return canon;
    unitFilter = canon.value;
  }

  const sources = await loadQueueSources(vaultRoot);
  if (!sources.ok) return sources;

  const db = access ? openIndexForAccessOrNull(vaultRoot) : null;
  try {
    const items: Tier2WorkItem[] = [];
    for (const doc of sources.value.docs) {
      // #217 omission: an item names both endpoints, so both must be
      // readable. An unreadable artifact drops with all its rows; an
      // unreadable unit drops that row. No counts, no remainder.
      if (access && !sourceReadable(db, access, doc.path)) continue;
      for (const row of residualRows(sources.value, doc)) {
        if (unitFilter !== null && row.unit !== unitFilter) continue;
        if (access && !sourceReadable(db, access, row.unit)) continue;
        items.push(workItem(sources.value, doc, row));
      }
    }
    items.sort((a, b) => a.unit.localeCompare(b.unit) || a.artifact.localeCompare(b.artifact));
    return ok({ items, total: items.length });
  } finally {
    db?.close();
  }
}

export async function vaultTier2Verdict(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<Tier2VerdictResult, Error>> {
  if (access && !hasAnyRead(access.role)) {
    return err(
      new Error(`access denied: role '${access.roleName}' cannot use vault_tier2_verdict`),
    );
  }

  const str = (field: string): Result<string, Error> => {
    const v = args[field];
    if (typeof v !== "string" || v.trim().length === 0) {
      return err(new Error(`vault_tier2_verdict requires a non-empty '${field}' argument`));
    }
    return ok(v.trim());
  };
  const artifactRaw = str("artifact");
  if (!artifactRaw.ok) return artifactRaw;
  const unitRaw = str("unit");
  if (!unitRaw.ok) return unitRaw;
  const reasoning = str("reasoning");
  if (!reasoning.ok) return reasoning;
  const agent = str("agent");
  if (!agent.ok) return agent;
  const verdict = args.verdict;
  if (verdict !== "still-valid" && verdict !== "broken") {
    return err(new Error("vault_tier2_verdict 'verdict' must be 'still-valid' or 'broken'"));
  }
  const runId = readRunId(args, "vault_tier2_verdict");
  if (!runId.ok) return runId;

  let tensionKind: LoggableTensionKind | null = null;
  let claimArtifact: string | null = null;
  let claimUnit: string | null = null;
  if (verdict === "broken") {
    const kind = args.tension_kind;
    if (typeof kind !== "string" || !(LOGGABLE_TENSION_KINDS as readonly string[]).includes(kind)) {
      return err(
        new Error(
          `a 'broken' verdict requires 'tension_kind' — one of: ${LOGGABLE_TENSION_KINDS.join(", ")}`,
        ),
      );
    }
    tensionKind = kind as LoggableTensionKind;
    const ca = str("claim_artifact");
    if (!ca.ok) return ca;
    const cu = str("claim_unit");
    if (!cu.ok) return cu;
    claimArtifact = ca.value;
    claimUnit = cu.value;
  } else if (args.tension_kind !== undefined) {
    return err(new Error("'tension_kind' applies only to a 'broken' verdict"));
  }

  const artifact = canonicalVaultRelPath(vaultRoot, artifactRaw.value);
  if (!artifact.ok) return artifact;
  const unit = canonicalVaultRelPath(vaultRoot, unitRaw.value);
  if (!unit.ok) return unit;

  const noPendingError = () =>
    err(
      new Error(
        `vault_tier2_verdict: no pending semantic review for ${artifact.value} ← ${unit.value}` +
          ` — see vault_tier2_queue`,
      ),
    );

  // Disclosure: a pair the caller cannot fully read is refused with the
  // exact error a pair with nothing pending produces — decided BEFORE any
  // queue state is computed, so the response cannot depend on it.
  if (access) {
    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      if (!sourceReadable(db, access, artifact.value) || !sourceReadable(db, access, unit.value)) {
        return noPendingError();
      }
    } finally {
      db?.close();
    }
  }

  const sources = await loadQueueSources(vaultRoot);
  if (!sources.ok) return sources;
  const doc = sources.value.docs.find((d) => d.path === artifact.value);
  const candidates = doc
    ? residualRows(sources.value, doc).filter((r) => r.unit === unit.value)
    : [];
  if (candidates.length === 0) return noPendingError();

  let row: UpstreamStaleness;
  if (args.edge_class !== undefined && args.edge_class !== null) {
    const match = candidates.find((r) => r.edge_class === args.edge_class);
    if (!match) return noPendingError();
    row = match;
  } else if (candidates.length === 1) {
    row = candidates[0] as UpstreamStaleness;
  } else {
    return err(
      new Error(
        `vault_tier2_verdict: ${artifact.value} ← ${unit.value} is pending on several edge ` +
          `classes (${candidates.map((r) => r.edge_class).join(", ")}) — pass 'edge_class'`,
      ),
    );
  }

  // A break is a real tension, logged through the existing taxonomy — the
  // durable, caller-visible artifact of the judgment.
  let tensionId: string | null = null;
  if (verdict === "broken" && tensionKind && claimArtifact && claimUnit) {
    const tension = await addTension(vaultRoot, {
      title: `tier-2: ${unit.value} change breaks ${artifact.value}`,
      kind: tensionKind,
      sourceA: artifact.value,
      claimA: claimArtifact,
      sourceB: unit.value,
      claimB: claimUnit,
      loggedBy: agent.value,
    });
    if (!tension.ok) return tension;
    tensionId = tension.value.id ?? null;
  }

  const recorded = await recordTier2Verdict(vaultRoot, {
    artifact: artifact.value,
    unit: unit.value,
    edge_class: row.edge_class as Exclude<Tier1EdgeClass, "compiled">,
    judged_change_ts: latestUnitChangeTs(sources.value.provenance, unit.value) ?? NO_CHANGE_TS,
    verdict,
    ...(tensionKind ? { tension_kind: tensionKind } : {}),
    ...(tensionId ? { tension_id: tensionId } : {}),
    reasoning: reasoning.value,
    agent: agent.value,
    ...(access?.user != null ? { principal: access.user } : {}),
    ...(runId.value ? { run_id: runId.value } : {}),
  });
  if (!recorded.ok) {
    return err(
      new Error(
        `${recorded.error.message}${tensionId ? ` (tension ${tensionId} was already logged)` : ""}`,
      ),
    );
  }

  return ok({ recorded: recorded.value, tension_id: tensionId });
}

export const tier2Tools: ToolDefinition[] = [
  {
    name: "vault_tier2_queue",
    title: "Semantic-review queue (tier 2)",
    annotations: { readOnlyHint: true },
    description:
      "The tier-2 semantic-review queue (#232): every declared/earned " +
      "dependency whose upstream changed but whose compatibility the " +
      "structure could not decide (tier 1's residual — #234's " +
      "pending-unchecked class), minus pairs an existing verdict already " +
      "covers. Each item is a CONSTRAINED judgment: the net per-field " +
      "before/after since the edge's baseline, the dependent's usage span, " +
      "and the specific question to answer — never 'do these documents " +
      "conflict'. YOU are the judge: answer items with vault_tier2_verdict. " +
      "Pass 'unit' to scope the queue to one changed document. Compiled " +
      "edges never appear — tier 1 decides them mechanically.",
    inputSchema: {
      type: "object",
      properties: {
        unit: {
          type: "string",
          description: "Optional vault-relative path: only items judging this changed document",
        },
      },
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultTier2Queue(vaultRoot, args, access),
  },
  {
    name: "vault_tier2_verdict",
    title: "Record a tier-2 semantic verdict",
    annotations: { readOnlyHint: false, idempotentHint: false },
    description:
      "Record the answer to a vault_tier2_queue item (#232 tier 2). " +
      "verdict 'still-valid' certifies the dependent's use of the changed " +
      "unit still holds; 'broken' requires a tension_kind from the tension " +
      "taxonomy plus claim_artifact/claim_unit, and logs a real tension via " +
      "the existing machinery (the tension id is returned). The verdict " +
      "covers the unit's CURRENT change only — a later write to the unit " +
      "re-queues the pair automatically. Refused when the pair has nothing " +
      "pending. Staleness surfaces (vault_staleness) read verdicts: a " +
      "covered pair reports pending-compatible or pending-broken instead " +
      "of pending-unchecked.",
    inputSchema: {
      type: "object",
      properties: {
        artifact: { type: "string", description: "The dependent document being judged" },
        unit: { type: "string", description: "The changed upstream it was judged against" },
        edge_class: {
          type: "string",
          enum: ["declared", "earned"],
          description: "Required only when the pair is pending on both classes",
        },
        verdict: { type: "string", enum: ["still-valid", "broken"] },
        tension_kind: {
          type: "string",
          enum: [...LOGGABLE_TENSION_KINDS],
          description: "Required for 'broken': the tension taxonomy kind",
        },
        claim_artifact: {
          type: "string",
          description: "For 'broken': what the dependent asserts (becomes the tension's claimA)",
        },
        claim_unit: {
          type: "string",
          description: "For 'broken': what the changed unit now says (becomes claimB)",
        },
        reasoning: { type: "string", description: "The judgment's reasoning, recorded verbatim" },
        agent: {
          type: "string",
          description: "Judging agent's identity, e.g. agent:curation-loop",
        },
        run_id: { type: "string", description: "Optional trace/run identifier of the calling run" },
      },
      required: ["artifact", "unit", "verdict", "reasoning", "agent"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultTier2Verdict(vaultRoot, args, access),
  },
];
