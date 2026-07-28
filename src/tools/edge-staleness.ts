// vault_staleness — the query surface over edge staleness (#234).
//
// Two modes:
//
//   { artifact } — the full three-class upstream report for one document:
//     every compiled / declared / earned edge classified against its own
//     baseline (current / pending-compatible / pending-broken /
//     pending-unchecked), by running tier-1 dispatch at query time — the
//     tier-1 layer stores no verdicts, so it can never go stale. Recorded
//     tier-2 SEMANTIC verdicts (#232, the one judgment that must be stored
//     because it cannot be recomputed) refine the pending-unchecked
//     residual, and only while they cover the unit's current change.
//
//   { days? } — the vault-global broken-read report over the read log: what
//     fraction of served reads (vault_read and vault_search hits) carried at
//     least one pending-broken compiled upstream at serve time. This is the
//     #234 acceptance query — one scan, no joins. Vault-global aggregates
//     stay unfiltered by design (the lint rule); the per-artifact mode is
//     the filtered surface.
//
// RBAC (#217, same rule as vault_consumes/vault_tier1): any-read gate; the
// per-artifact report lists only edges whose upstream unit the caller can
// read — pending edges to unreadable units are coarsened into a
// none/some/many bucket, never an exact count. An unreadable anchor yields
// the empty report, indistinguishable from a nonexistent one.

import { type AccessContext, hasAnyRead } from "../access/rbac.js";
import { listConsumesEdges } from "../curation/consumes.js";
import {
  splitUpstreamVisibility,
  summarizeUpstream,
  type UpstreamStaleness,
  type UpstreamStalenessSummary,
  upstreamStaleness,
} from "../curation/edge-staleness.js";
import { listEdges } from "../curation/edges.js";
import { readProvenanceLog } from "../curation/provenance.js";
import { readReadLog } from "../curation/read-log.js";
import { sourceReadable } from "../curation/tension-access.js";
import type { HiddenDownstream } from "../curation/tension-blast.js";
import { readTier2Verdicts } from "../curation/tier2.js";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { canonicalVaultRelPath, readFile, resolveVaultPath } from "../storage/local.js";
import type { ToolDefinition } from "./read.js";
import { openIndexForAccessOrNull } from "./search.js";

export interface ArtifactStalenessResult {
  mode: "artifact";
  artifact: string;
  edges: UpstreamStaleness[];
  hidden_pending: HiddenDownstream;
  // Over the VISIBLE edges only — hidden ones surface solely through the
  // coarse bucket above, never through counts (#217).
  summary: UpstreamStalenessSummary;
}

export interface BrokenReadToolSlice {
  serves: number;
  broken_serves: number;
}

export interface BrokenReadReport {
  mode: "report";
  window_days: number;
  // Instrumented serves in the window (read-log entries carrying a
  // broken_upstream count) and how many of them served a document with at
  // least one pending-broken compiled upstream.
  serves: number;
  broken_serves: number;
  broken_read_rate: number | null; // null when nothing was instrumented
  by_tool: Record<string, BrokenReadToolSlice>;
  // In-window entries that predate the telemetry (no broken_upstream field).
  // Reported so a low rate over a mostly-uninstrumented window cannot pass
  // for a healthy one.
  uninstrumented: number;
}

async function artifactReport(
  vaultRoot: string,
  artifactRaw: string,
  access?: AccessContext,
): Promise<Result<ArtifactStalenessResult, Error>> {
  const artifact = canonicalVaultRelPath(vaultRoot, artifactRaw);
  if (!artifact.ok) return artifact;

  const empty = (): ArtifactStalenessResult => ({
    mode: "artifact",
    artifact: artifact.value,
    edges: [],
    hidden_pending: "none",
    summary: summarizeUpstream([]),
  });

  const db = access ? openIndexForAccessOrNull(vaultRoot) : null;
  try {
    // Unreadable anchor: the empty report, byte-identical to a document with
    // no upstream edges — nothing below is computed, so the response cannot
    // depend on what the hidden document's history looks like.
    if (access && !sourceReadable(db, access, artifact.value)) return ok(empty());

    const consumes = await listConsumesEdges(vaultRoot);
    if (!consumes.ok) return consumes;
    const provenance = await readProvenanceLog(vaultRoot);
    if (!provenance.ok) return provenance;

    // Declared units come from the artifact's own frontmatter. A missing or
    // unparsable document simply declares nothing — its compiled/earned
    // history (if any) still reports.
    let declaredUnits: string[] = [];
    const resolved = resolveVaultPath(vaultRoot, artifact.value);
    if (resolved.ok) {
      const file = await readFile(resolved.value.absPath);
      if (file.ok) {
        const parsed = parseDocument(file.value);
        if (parsed.ok) declaredUnits = parsed.value.frontmatter.sources;
      }
    }

    const earnedEdges = await listEdges(vaultRoot, { fromPath: artifact.value });
    if (!earnedEdges.ok) return earnedEdges;
    const earned = earnedEdges.value
      .filter((e) => e.status !== "revoked")
      .map((e) => ({ unit: e.toPath, lastRederived: e.lastRederived }));

    // Tier-2 verdicts refine the pending-unchecked residual (#232): a
    // covered pair reports the judged class instead of re-queueing.
    const verdicts = await readTier2Verdicts(vaultRoot);
    if (!verdicts.ok) return verdicts;

    const rows = upstreamStaleness({
      artifact: artifact.value,
      consumes: consumes.value,
      provenance: provenance.value,
      declaredUnits,
      earned,
      verdicts: verdicts.value,
    });

    const { visible, hiddenPending } = access
      ? splitUpstreamVisibility(rows, (unit) => sourceReadable(db, access, unit))
      : { visible: rows, hiddenPending: "none" as const };

    return ok({
      mode: "artifact",
      artifact: artifact.value,
      edges: visible,
      hidden_pending: hiddenPending,
      summary: summarizeUpstream(visible),
    });
  } finally {
    db?.close();
  }
}

async function brokenReadReport(
  vaultRoot: string,
  windowDays: number,
): Promise<Result<BrokenReadReport, Error>> {
  const log = await readReadLog(vaultRoot);
  if (!log.ok) return log;

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  let serves = 0;
  let brokenServes = 0;
  let uninstrumented = 0;
  const byTool: Record<string, BrokenReadToolSlice> = {};
  for (const e of log.value) {
    if (e.timestamp < cutoff) continue;
    if (e.broken_upstream === undefined) {
      uninstrumented += 1;
      continue;
    }
    serves += 1;
    let slice = byTool[e.tool];
    if (!slice) {
      slice = { serves: 0, broken_serves: 0 };
      byTool[e.tool] = slice;
    }
    slice.serves += 1;
    if (e.broken_upstream > 0) {
      brokenServes += 1;
      slice.broken_serves += 1;
    }
  }

  return ok({
    mode: "report",
    window_days: windowDays,
    serves,
    broken_serves: brokenServes,
    broken_read_rate: serves > 0 ? brokenServes / serves : null,
    by_tool: byTool,
    uninstrumented,
  });
}

export async function vaultStaleness(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<ArtifactStalenessResult | BrokenReadReport, Error>> {
  if (access && !hasAnyRead(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot use vault_staleness`));
  }

  if (args.artifact !== undefined && args.artifact !== null) {
    if (typeof args.artifact !== "string" || args.artifact.trim().length === 0) {
      return err(new Error("vault_staleness 'artifact' must be a non-empty string"));
    }
    if (args.days !== undefined && args.days !== null) {
      return err(new Error("vault_staleness takes 'days' only without 'artifact'"));
    }
    return artifactReport(vaultRoot, args.artifact, access);
  }

  let days = 30;
  if (args.days !== undefined && args.days !== null) {
    if (typeof args.days !== "number" || !Number.isFinite(args.days) || args.days <= 0) {
      return err(new Error("vault_staleness 'days' must be a positive number"));
    }
    days = args.days;
  }
  return brokenReadReport(vaultRoot, days);
}

// One classified upstream edge (UpstreamStaleness).
const upstreamStalenessSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    unit: { type: "string", description: "Vault-relative path of the upstream document" },
    edge_class: {
      type: "string",
      enum: ["compiled", "declared", "earned"],
      description: "Edge provenance class the row was classified under",
    },
    staleness: {
      type: "string",
      enum: ["current", "pending-unchecked", "pending-compatible", "pending-broken"],
      description: "Compatibility class of the change since this edge's baseline",
    },
    baseline: {
      type: ["string", "null"],
      description:
        "ISO 8601 instant the classification measured change from; null when " +
        "no baseline is derivable (which forces pending-unchecked)",
    },
    changed_fields: {
      type: "array",
      items: { type: "string" },
      description:
        "Content fields the unit's writes touched since the baseline " +
        "(bookkeeping stripped). Empty for current and bookkeeping-only churn.",
    },
    reason: { type: "string", description: "Why this class was assigned" },
  },
  required: ["unit", "edge_class", "staleness", "baseline", "changed_fields", "reason"],
};

// #217: pending edges to units the caller cannot read are reported ONLY as
// this coarse bucket — never an exact count, which for a small cell would
// disclose linked existence. Do not widen this to a number.
const hiddenPendingSchema: Record<string, unknown> = {
  type: "string",
  enum: ["none", "some", "many"],
  description:
    "Coarsened remainder over upstream units outside your read scope that " +
    "have pending changes. Never an exact count (#217).",
};

const artifactStalenessSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    mode: { type: "string", const: "artifact" },
    artifact: { type: "string", description: "Canonical vault-relative path of the anchor" },
    edges: {
      type: "array",
      items: upstreamStalenessSchema,
      description: "Upstream edges whose unit the caller can read, unit then class ordered",
    },
    hidden_pending: hiddenPendingSchema,
    summary: {
      type: "object",
      description: "Counts over the VISIBLE edges only — hidden ones never enter a count",
      properties: {
        current: { type: "integer" },
        pending_unchecked: { type: "integer" },
        pending_compatible: { type: "integer" },
        pending_broken: { type: "integer" },
      },
      required: ["current", "pending_unchecked", "pending_compatible", "pending_broken"],
    },
  },
  required: ["mode", "artifact", "edges", "hidden_pending", "summary"],
};

const brokenReadReportSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    mode: { type: "string", const: "report" },
    window_days: { type: "number", description: "Report window in days" },
    serves: {
      type: "integer",
      description: "Instrumented serves in the window (read-log entries carrying broken_upstream)",
    },
    broken_serves: {
      type: "integer",
      description: "Of those, serves of a document with at least one pending-broken upstream",
    },
    broken_read_rate: {
      type: ["number", "null"],
      description: "broken_serves / serves; null when nothing in the window was instrumented",
    },
    by_tool: {
      type: "object",
      description: "The same two counters sliced by serving tool, keyed by tool name",
      additionalProperties: {
        type: "object",
        properties: {
          serves: { type: "integer" },
          broken_serves: { type: "integer" },
        },
        required: ["serves", "broken_serves"],
      },
    },
    uninstrumented: {
      type: "integer",
      description:
        "In-window entries predating the telemetry (no broken_upstream field), " +
        "so a low rate over a mostly-uninstrumented window cannot pass for a healthy one",
    },
  },
  required: [
    "mode",
    "window_days",
    "serves",
    "broken_serves",
    "broken_read_rate",
    "by_tool",
    "uninstrumented",
  ],
};

// ---------------------------------------------------------------------------
// Compact `content` summary + resource links (spec 2026-07-26, Decision 3,
// PR 1 gap closure). Two modes, discriminated by `mode` — see
// ArtifactStalenessResult / BrokenReadReport above. No new prose is written
// over what summarizeUpstream already computed for the artifact mode; this
// just renders its counts plus the coarsened hidden-pending bucket verbatim
// (#217 — never sharpened into a number).
// ---------------------------------------------------------------------------

function summarizeStaleness(value: unknown): string {
  const r = value as ArtifactStalenessResult | BrokenReadReport;
  if (r.mode === "artifact") {
    const s = r.summary;
    return (
      `${r.artifact}: ${s.current} current, ${s.pending_unchecked} pending-unchecked, ` +
      `${s.pending_compatible} pending-compatible, ${s.pending_broken} pending-broken ` +
      `(hidden_pending: ${r.hidden_pending})`
    );
  }
  const rate = r.broken_read_rate === null ? "n/a" : `${(r.broken_read_rate * 100).toFixed(1)}%`;
  return (
    `broken-read rate over ${r.window_days}d: ${rate} (${r.broken_serves}/${r.serves} serves) ` +
    `— ${r.uninstrumented} uninstrumented`
  );
}

// Artifact mode: the anchor plus every visible upstream unit. Report mode
// names no document — by_tool is keyed by tool name, not a path.
function docLinksStaleness(value: unknown): string[] {
  const r = value as ArtifactStalenessResult | BrokenReadReport;
  if (r.mode !== "artifact") return [];
  return [r.artifact, ...r.edges.map((e) => e.unit)];
}

export const edgeStalenessTools: ToolDefinition[] = [
  {
    name: "vault_staleness",
    title: "Edge staleness — pending upstream changes and the broken-read rate",
    annotations: { readOnlyHint: true },
    description:
      "Edge staleness (#234): is a document stale WITH RESPECT TO its " +
      "upstream inputs, and does it matter? Pass 'artifact' for the " +
      "per-document report: every compiled/declared/earned upstream edge " +
      "classified by running tier-1 dispatch (#232) against the change " +
      "since that edge's baseline — current, pending-compatible (change " +
      "certifiably misses), pending-broken (compiled input changed; the " +
      "document serves pre-change context — the only incident class), or " +
      "pending-unchecked (structure cannot decide; the tier-2 residual). " +
      "Without 'artifact': the vault-global broken-read report over the " +
      "read log — what fraction of served reads (vault_read + search hits, " +
      "last 'days' days, default 30) carried at least one pending-broken " +
      "upstream at serve time. Distinct from TTL decay (doc age) and audit " +
      "staleness (link mtime ordering): this is per-edge compatibility, " +
      "advisory, derived at query time.",
    inputSchema: {
      type: "object",
      properties: {
        artifact: {
          type: "string",
          description: "Vault-relative path — report this document's upstream staleness",
        },
        days: {
          type: "number",
          description: "Report window in days for the vault-global broken-read rate (default 30)",
        },
      },
      additionalProperties: false,
    },
    // Two modes, discriminated by `mode`: the per-artifact report or the
    // vault-global broken-read report.
    outputSchema: {
      type: "object",
      oneOf: [artifactStalenessSchema, brokenReadReportSchema],
    },
    summarize: summarizeStaleness,
    docLinks: docLinksStaleness,
    handler: (vaultRoot, args, access) => vaultStaleness(vaultRoot, args, access),
  },
];
