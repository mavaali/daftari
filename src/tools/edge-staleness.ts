// vault_staleness — the query surface over edge staleness (#234).
//
// Two modes:
//
//   { artifact } — the full three-class upstream report for one document:
//     every compiled / declared / earned edge classified against its own
//     baseline (current / pending-compatible / pending-broken /
//     pending-unchecked), by running tier-1 dispatch at query time. There is
//     no verdict store — the classes are derived, so they can never go stale
//     themselves.
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

    const rows = upstreamStaleness({
      artifact: artifact.value,
      consumes: consumes.value,
      provenance: provenance.value,
      declaredUnits,
      earned,
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
    handler: (vaultRoot, args, access) => vaultStaleness(vaultRoot, args, access),
  },
];
