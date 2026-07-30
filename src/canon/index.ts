// Canon orchestrator — wires the belief-layer modules with RBAC.
//
// computeCanon loads all vault data in a single consistent snapshot, applies
// access control to restrict candidate docs and tensions, computes visibility
// and unindexed flags, delegates resolution to resolveCanon (pure), and
// attaches a vault_receipt over the cited paths. The receipt is resilient:
// if building it fails (e.g. in a bare temp vault without git), the canon
// result is still returned with receipt: null rather than propagating the
// failure.
//
// v1 known limitation: the receipt's git anchor is pinned inside vaultReceipt
// at call end, not captured up front; acceptable under the working-tree read
// strategy for a quiet vault; revisit if used in a concurrently-written vault.

import type { AccessContext } from "../access/rbac.js";
import { canRead } from "../access/rbac.js";
import { listEdges } from "../curation/edges.js";
import { listTensions } from "../curation/tension.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { ok, type Result } from "../frontmatter/types.js";
import { buildRegistry, resolveHolder } from "../holders/registry.js";
import { type VaultReceiptResult, vaultReceipt } from "../tools/receipt.js";
import { loadConfig } from "../utils/config.js";
import { resolveCanon } from "./resolve.js";
import { topicEgoGraphFrom } from "./topic.js";
import type { CanonDoc, CanonResult } from "./types.js";

export interface ComputeCanonArgs {
  seed: string;
  holders?: string[];
  asOf?: string;
  depth?: number;
}

export type ComputeCanonResult = CanonResult & { receipt: VaultReceiptResult | null };

// Top-level directory of a vault-relative path — used for RBAC when a doc's
// collection frontmatter is absent (mirrors receipt.ts's topCollection).
function topCollection(relPath: string): string {
  return relPath.split("/")[0] ?? "";
}

export async function computeCanon(
  vaultRoot: string,
  args: ComputeCanonArgs,
  access?: AccessContext,
): Promise<Result<ComputeCanonResult, Error>> {
  const asOf = args.asOf ?? new Date().toISOString().slice(0, 10);
  const depth = args.depth ?? 2;

  // Step 1: load documents, tensions, and edges — one consistent snapshot.
  // All three are loaded here and reused throughout; no subsequent listTensions
  // or listEdges calls are made, eliminating write-window inconsistency.
  const allDocsRes = await loadDocuments(vaultRoot);
  if (!allDocsRes.ok) return allDocsRes;

  const tensionsRes = await listTensions(vaultRoot);
  if (!tensionsRes.ok) return tensionsRes;
  const allTensions = tensionsRes.value;

  const edgesRes = await listEdges(vaultRoot, {});
  if (!edgesRes.ok) return edgesRes;
  const allEdges = edgesRes.value;

  // Step 2: topic ego-graph — candidate paths, using pre-loaded data.
  const candidateSet = new Set(topicEgoGraphFrom(allTensions, allEdges, args.seed, depth));
  const allDocsMap = new Map(allDocsRes.value.map((d) => [d.path, d]));

  // Step 3: build CanonDoc[] for candidate paths present in the vault.
  const candidateDocs: CanonDoc[] = [];
  for (const path of candidateSet) {
    const doc = allDocsMap.get(path);
    if (!doc) continue;
    candidateDocs.push({
      path,
      holder: doc.frontmatter.updated_by || "unknown:unattributed",
      valid_from: doc.frontmatter.valid_from,
      valid_until: doc.frontmatter.valid_until,
      updated: doc.frontmatter.updated,
      collection: doc.frontmatter.collection || topCollection(path),
    });
  }

  // Pre-RBAC set: all topic candidate paths that exist in the vault.
  // Used for tension filtering — a tension is "touching" the topic if
  // either endpoint is a vault-resident candidate doc (regardless of
  // whether that doc's collection is readable by the current caller).
  const existingCandidatePaths = new Set(candidateDocs.map((d) => d.path));

  // Step 4: RBAC — filter candidate docs to those whose collection is readable.
  // If access is undefined, treat as full access (no filtering).
  const visibleCandidates = access
    ? candidateDocs.filter((d) => canRead(access.role, d.collection))
    : candidateDocs;

  // Helper: is a given vault path readable under the current access context?
  // A path not present in allDocsMap is treated as unreadable.
  function readable(path: string): boolean {
    if (!access) return true;
    const doc = allDocsMap.get(path);
    if (!doc) return false;
    const collection = doc.frontmatter.collection || topCollection(path);
    return canRead(access.role, collection);
  }

  // Step 5: compute visibility flags using the already-loaded tensions.
  // A tension touches the topic if either endpoint is a vault-resident
  // candidate doc — tested against the PRE-RBAC existingCandidatePaths set
  // so that tensions between two hidden docs are not silently omitted.
  const touchingTensions = allTensions.filter(
    (t) => existingCandidatePaths.has(t.sourceA) || existingCandidatePaths.has(t.sourceB),
  );

  const visibleTensions: { sourceA: string; sourceB: string }[] = [];
  let hiddenTensionCount = 0;

  for (const t of touchingTensions) {
    const bothVisible = readable(t.sourceA) && readable(t.sourceB);
    if (bothVisible) {
      visibleTensions.push({ sourceA: t.sourceA, sourceB: t.sourceB });
    } else {
      // At least one side is unreadable (covers one-side-hidden AND both-sides-hidden).
      // We only COUNT the tension; we never expose its claims or paths in output.
      hiddenTensionCount += 1;
    }
  }

  const partialVisibility = hiddenTensionCount > 0;

  // Step 6: unindexed paths — visible candidates that appear in NO tension and NO edge
  // (vault-wide, never consolidated anywhere), using the already-loaded allTensions and allEdges.
  const consolidatedPaths = new Set<string>();
  for (const t of allTensions) {
    consolidatedPaths.add(t.sourceA);
    consolidatedPaths.add(t.sourceB);
  }
  for (const e of allEdges) {
    consolidatedPaths.add(e.fromPath);
    consolidatedPaths.add(e.toPath);
  }

  const unindexedPaths = visibleCandidates
    .filter((d) => !consolidatedPaths.has(d.path))
    .map((d) => d.path);

  // Step 7: build holder registry from config (empty on error or missing config).
  let holderAliases: Record<string, string> = {};
  const configRes = loadConfig(vaultRoot);
  if (configRes.ok) {
    holderAliases = configRes.value.holderAliases;
  }
  const registry = buildRegistry(holderAliases);

  // Step 8: determine holders.
  let holders: string[];
  if (args.holders !== undefined) {
    holders = args.holders;
  } else {
    const holderSet = new Set(visibleCandidates.map((d) => resolveHolder(registry, d.holder)));
    holders = [...holderSet];
  }

  // Step 9: resolve canon (pure).
  const canonResult = resolveCanon(
    visibleCandidates,
    holders,
    asOf,
    registry,
    visibleTensions,
    { partial_visibility: partialVisibility, hidden_tension_count: hiddenTensionCount },
    unindexedPaths,
  );

  // Step 10: build receipt over all cited paths (settled citations + contested trajectory paths).
  const citedPaths: string[] = [];
  const citedSet = new Set<string>();

  for (const s of canonResult.settled) {
    for (const p of s.citations) {
      if (!citedSet.has(p)) {
        citedSet.add(p);
        citedPaths.push(p);
      }
    }
  }
  for (const c of canonResult.contested) {
    for (const node of c.trajectory) {
      if (!citedSet.has(node.path)) {
        citedSet.add(node.path);
        citedPaths.push(node.path);
      }
    }
  }

  // Receipt is resilient: failures (e.g. bare vault with no git or missing
  // files) do not propagate — canon result is returned with receipt: null.
  let receipt: VaultReceiptResult | null = null;
  if (citedPaths.length > 0) {
    const receiptRes = await vaultReceipt(vaultRoot, { paths: citedPaths }, access);
    if (receiptRes.ok) {
      receipt = receiptRes.value;
    }
    // On error: leave receipt as null and continue.
  }

  return ok({ ...canonResult, receipt });
}
