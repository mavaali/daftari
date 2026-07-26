// vault_receipt — compile an epistemic receipt for the documents an answer
// cites.
//
// The receipt is the vault's metadata weaponized into a single attachable
// artifact: for each cited document its status, confidence, provenance,
// freshness (decay), exact content version, the resolution of its
// supersession chain, and every unresolved tension touching it — plus a
// deterministic summary with machine-readable flags, the vault's git HEAD as
// an as-of anchor, and a content hash over the whole receipt.
//
// Discipline: the receipt only *reads* — frontmatter, the tension log, git.
// It never grades, never synthesizes prose, never mints a value. Flags are
// deterministic derivations from facts already in the vault. The optional
// `claim` is caller-supplied and carried verbatim (labeled as such); it is
// never interpolated into any Daftari-authored text.

import { type AccessContext, canRead } from "../access/rbac.js";
import { computeDecay, type DecayState } from "../curation/decay.js";
import {
  AGING_TIERS,
  type AgingTier,
  agingTier,
  DEFAULT_TENSION_STATUS,
  listTensions,
  TENSION_KINDS,
  type TensionEntry,
  type TensionKind,
} from "../curation/tension.js";
import { visibleTensions } from "../curation/tension-access.js";
import { parseDocument } from "../frontmatter/parser.js";
import { CONFIDENCES, err, ok, PROVENANCES, type Result, STATUSES } from "../frontmatter/types.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import { log as gitLog, isGitRepo } from "../utils/git.js";
import { sha256Hex } from "../utils/hash.js";
import { DECAY_SCHEMA, type ToolDefinition } from "./read.js";
import { openIndexForAccessOrNull } from "./search.js";

export const MAX_RECEIPT_PATHS = 50;
export const MAX_CLAIM_LENGTH = 2000;

// Supersession-chain resolution, filesystem-walked (receipts must work even
// while the index is building — read tools go to the filesystem). Mirrors
// resolveCurrentSource's semantics: strict RBAC (any unreadable hop degrades
// to a path-free marker), cycle and dangling detection. No snippet — a
// receipt points, it does not carry content.
export type ChainResolution =
  | { kind: "resolved"; path: string; title: string; hops: number }
  | { kind: "restricted" }
  | { kind: "dangling"; brokenAt: string }
  | { kind: "cycle" };

export interface ReceiptTension {
  id: string | null;
  title: string;
  kind: TensionKind;
  date: string;
  agingTier: AgingTier | null;
}

export interface ReceiptSource {
  path: string;
  title: string;
  collection: string;
  status: string;
  confidence: string;
  provenance: string;
  created: string;
  updated: string;
  sources: string[];
  // SHA-256 of the raw file bytes — pins the exact content that was cited.
  version: string;
  decay: DecayState | null;
  // Non-null iff the document is on a supersession chain (superseded_by set
  // or status superseded).
  currentSource: ChainResolution | null;
  // Unresolved tensions touching this document.
  tensions: ReceiptTension[];
}

export interface ReceiptSummary {
  sourceCount: number;
  byStatus: Record<string, number>;
  // Distinct unresolved tensions across the cited set.
  openTensions: number;
  oldestUpdated: string | null;
  newestUpdated: string | null;
  // Deterministic, sorted. Empty means: every cited document is current,
  // grounded, and uncontested as far as the vault knows.
  flags: string[];
}

export interface VaultReceiptResult {
  claim: string | null;
  sources: ReceiptSource[];
  summary: ReceiptSummary;
  // Git HEAD of the vault at receipt time — the as-of anchor. Null when the
  // vault is not a git repository (or has no commits yet).
  vaultHead: string | null;
  generatedAt: string;
  // SHA-256 over the canonical JSON of every field above. Recomputable by
  // anyone holding the receipt.
  receiptHash: string;
}

// A document's collection: frontmatter `collection`, falling back to the
// top-level directory. Tension records carry only a path, so RBAC on the
// counterpart side falls back to the path-based collection.
function topCollection(relPath: string): string {
  return relPath.split("/")[0] ?? "";
}

function tensionIdentity(t: TensionEntry): string {
  return t.id ?? `${t.date}:${t.title}`;
}

async function resolveChain(
  vaultRoot: string,
  startPath: string,
  startSupersededBy: string | null,
  access?: AccessContext,
): Promise<ChainResolution> {
  const visited = new Set<string>([startPath]);
  let hops = 0;
  let nextRel: string | null = startSupersededBy;
  let currentPath = startPath;
  let currentTitle = "";

  while (nextRel !== null) {
    hops += 1;
    const resolved = resolveVaultPath(vaultRoot, nextRel);
    if (!resolved.ok) return { kind: "dangling", brokenAt: currentPath };
    const rel = resolved.value.relPath;
    if (visited.has(rel)) return { kind: "cycle" };
    visited.add(rel);

    const file = await readFile(resolved.value.absPath);
    if (!file.ok) return { kind: "dangling", brokenAt: currentPath };
    const parsed = parseDocument(file.value);
    if (!parsed.ok) return { kind: "dangling", brokenAt: currentPath };

    const fm = parsed.value.frontmatter;
    const collection = fm.collection || topCollection(rel);
    if (access && !canRead(access.role, collection)) return { kind: "restricted" };

    currentPath = rel;
    currentTitle = fm.title;
    nextRel = fm.superseded_by;
  }

  return { kind: "resolved", path: currentPath, title: currentTitle, hops };
}

export interface VaultReceiptArgs {
  paths: string[];
  claim?: string;
}

export async function vaultReceipt(
  vaultRoot: string,
  args: VaultReceiptArgs,
  access?: AccessContext,
): Promise<Result<VaultReceiptResult, Error>> {
  if (!Array.isArray(args.paths) || args.paths.length === 0) {
    return err(new Error("vault_receipt requires a non-empty 'paths' array"));
  }
  if (args.paths.some((p) => typeof p !== "string" || p.length === 0)) {
    return err(new Error("vault_receipt 'paths' entries must be non-empty strings"));
  }
  if (args.paths.length > MAX_RECEIPT_PATHS) {
    return err(new Error(`vault_receipt accepts at most ${MAX_RECEIPT_PATHS} paths`));
  }
  if (args.claim !== undefined) {
    if (typeof args.claim !== "string") {
      return err(new Error("vault_receipt 'claim' must be a string"));
    }
    if (args.claim.length > MAX_CLAIM_LENGTH) {
      return err(new Error(`vault_receipt 'claim' exceeds ${MAX_CLAIM_LENGTH} characters`));
    }
  }

  // Unresolved tensions, read once. With an access context a tension is
  // visible only when the role can read BOTH sources' collections (the
  // vault_status precedent), judged on the canonicalized paths via the shared
  // predicate — the receipt never leaks the existence of a document in a
  // denied collection, and an alias must not widen visibility.
  const tensionScan = await listTensions(vaultRoot, DEFAULT_TENSION_STATUS);
  if (!tensionScan.ok) return tensionScan;
  let tensionEntries = tensionScan.value;
  if (access) {
    const accessDb = openIndexForAccessOrNull(vaultRoot);
    try {
      tensionEntries = visibleTensions(accessDb, tensionScan.value, access);
    } finally {
      accessDb?.close();
    }
  }

  // Dedupe cited paths, preserving first-seen order.
  const citedPaths: string[] = [];
  const seen = new Set<string>();
  for (const p of args.paths) {
    const resolved = resolveVaultPath(vaultRoot, p);
    if (!resolved.ok) return resolved;
    const rel = resolved.value.relPath;
    if (seen.has(rel)) continue;
    seen.add(rel);
    citedPaths.push(rel);
  }

  const sources: ReceiptSource[] = [];
  const matchedTensionIds = new Set<string>();
  const flagSet = new Set<string>();

  for (const rel of citedPaths) {
    const resolved = resolveVaultPath(vaultRoot, rel);
    if (!resolved.ok) return resolved;
    const file = await readFile(resolved.value.absPath);
    if (!file.ok) return file;
    const parsed = parseDocument(file.value);
    if (!parsed.ok) return parsed;

    const fm = parsed.value.frontmatter;
    const collection = fm.collection || topCollection(rel);
    if (access && !canRead(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot read collection '${collection}'`,
        ),
      );
    }

    const decay = computeDecay(fm);
    const onChain = fm.superseded_by !== null || fm.status === "superseded";
    const currentSource = onChain
      ? await resolveChain(vaultRoot, rel, fm.superseded_by, access)
      : null;

    const matched = tensionEntries.filter((t) => t.sourceA === rel || t.sourceB === rel);
    for (const t of matched) matchedTensionIds.add(tensionIdentity(t));

    if (fm.status === "deprecated") flagSet.add("cites-deprecated");
    if (fm.status === "archived") flagSet.add("cites-archived");
    if (fm.status === "draft") flagSet.add("cites-draft");
    if (onChain) flagSet.add("cites-superseded");
    if (fm.confidence === "low") flagSet.add("cites-low-confidence");
    if (decay?.level === "warn") flagSet.add("cites-stale");
    if (decay?.level === "aging") flagSet.add("cites-aging");
    if (matched.length > 0) flagSet.add("cites-contested");
    if (currentSource !== null && currentSource.kind !== "resolved") {
      flagSet.add("supersession-unresolved");
    }

    sources.push({
      path: rel,
      title: fm.title,
      collection,
      status: fm.status,
      confidence: fm.confidence,
      provenance: fm.provenance,
      created: fm.created,
      updated: fm.updated,
      sources: fm.sources,
      version: sha256Hex(file.value),
      decay,
      currentSource,
      tensions: matched.map((t) => ({
        id: t.id ?? null,
        title: t.title,
        kind: t.kind,
        date: t.date,
        agingTier: agingTier(t),
      })),
    });
  }

  const byStatus: Record<string, number> = {};
  for (const s of sources) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  }
  const updatedDates = sources.map((s) => s.updated).filter((d) => d.length > 0);
  updatedDates.sort();

  const summary: ReceiptSummary = {
    sourceCount: sources.length,
    byStatus,
    openTensions: matchedTensionIds.size,
    oldestUpdated: updatedDates[0] ?? null,
    newestUpdated: updatedDates[updatedDates.length - 1] ?? null,
    flags: [...flagSet].sort(),
  };

  // The as-of anchor: the vault's HEAD commit. Belief archaeology starts
  // here — a receipt plus this hash reproduces the exact vault state the
  // answer was compiled against.
  let vaultHead: string | null = null;
  if (await isGitRepo(vaultRoot)) {
    const head = await gitLog(vaultRoot, { limit: 1 });
    if (head.ok && head.value.length > 0) vaultHead = (head.value[0] as { hash: string }).hash;
  }

  const claim = args.claim !== undefined && args.claim.length > 0 ? args.claim : null;
  const generatedAt = new Date().toISOString();
  const payload = { claim, sources, summary, vaultHead, generatedAt };

  return ok({ ...payload, receiptHash: sha256Hex(JSON.stringify(payload)) });
}

// ---------------------------------------------------------------------------
// MCP tool definition
// ---------------------------------------------------------------------------

export const receiptTools: ToolDefinition[] = [
  {
    name: "vault_receipt",
    title: "Compile an epistemic receipt",
    annotations: { readOnlyHint: true },
    description:
      "Compile an epistemic receipt for the vault documents an answer relies " +
      "on. For each cited path: status, confidence, provenance, freshness " +
      "(decay), an exact content-version hash, the resolution of its " +
      "supersession chain, and any unresolved tensions touching it. Plus a " +
      "summary with deterministic flags (e.g. cites-stale, cites-contested, " +
      "cites-superseded — empty flags mean current, grounded, uncontested), " +
      "the vault's git HEAD as an as-of anchor, and a recomputable SHA-256 " +
      "over the receipt. Attach the receipt to the answer so downstream " +
      "consumers can see what it stands on. Read-only; facts are derived " +
      "from frontmatter, the tension log, and git — never invented.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_RECEIPT_PATHS,
          description:
            "Vault-relative paths of the documents the answer cites, e.g. " +
            "competitive-intel/foo.md",
        },
        claim: {
          type: "string",
          maxLength: MAX_CLAIM_LENGTH,
          description:
            "Optional one-line statement of the answer the receipt attests. " +
            "Carried verbatim (caller-supplied) and covered by the receipt hash.",
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
    // The receipt is a citable artifact: every field below is derived, never
    // invented, so the schema is the derivation's shape. `additionalProperties`
    // stays open on the source objects (frontmatter-derived values), closed
    // nowhere the vault could legitimately grow a field.
    outputSchema: {
      type: "object",
      properties: {
        claim: {
          type: ["string", "null"],
          description: "Caller-supplied, carried verbatim; null when not provided",
        },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Canonical vault-relative path" },
              title: { type: "string" },
              collection: { type: "string" },
              status: { type: "string", enum: [...STATUSES] },
              confidence: { type: "string", enum: [...CONFIDENCES] },
              provenance: { type: "string", enum: [...PROVENANCES] },
              created: { type: "string", description: "YYYY-MM-DD" },
              updated: { type: "string", description: "YYYY-MM-DD" },
              sources: { type: "array", items: { type: "string" } },
              version: {
                type: "string",
                description: "SHA-256 (hex) of the raw file bytes — pins the cited content",
              },
              decay: DECAY_SCHEMA,
              // Non-null iff the document is on a supersession chain. An
              // unreadable hop degrades to the path-free `restricted` marker.
              currentSource: {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      kind: { const: "resolved" },
                      path: { type: "string" },
                      title: { type: "string" },
                      hops: { type: "integer", minimum: 1 },
                    },
                    required: ["kind", "path", "title", "hops"],
                  },
                  {
                    type: "object",
                    properties: { kind: { const: "restricted" } },
                    required: ["kind"],
                  },
                  {
                    type: "object",
                    properties: {
                      kind: { const: "dangling" },
                      brokenAt: { type: "string" },
                    },
                    required: ["kind", "brokenAt"],
                  },
                  {
                    type: "object",
                    properties: { kind: { const: "cycle" } },
                    required: ["kind"],
                  },
                  { type: "null" },
                ],
              },
              tensions: {
                type: "array",
                description: "Unresolved tensions touching this document",
                items: {
                  type: "object",
                  properties: {
                    id: { type: ["string", "null"], description: "Null for legacy entries" },
                    title: { type: "string" },
                    kind: { type: "string", enum: [...TENSION_KINDS] },
                    date: { type: "string", description: "YYYY-MM-DD" },
                    agingTier: { type: ["string", "null"], enum: [...AGING_TIERS, null] },
                  },
                  required: ["id", "title", "kind", "date", "agingTier"],
                },
              },
            },
            required: [
              "path",
              "title",
              "collection",
              "status",
              "confidence",
              "provenance",
              "created",
              "updated",
              "sources",
              "version",
              "decay",
              "currentSource",
              "tensions",
            ],
          },
        },
        summary: {
          type: "object",
          properties: {
            sourceCount: { type: "integer", minimum: 0 },
            byStatus: {
              type: "object",
              description: "Cited-document count per status",
              propertyNames: { enum: [...STATUSES] },
              additionalProperties: { type: "integer", minimum: 0 },
            },
            openTensions: {
              type: "integer",
              minimum: 0,
              description: "Distinct unresolved tensions across the cited set",
            },
            oldestUpdated: { type: ["string", "null"] },
            newestUpdated: { type: ["string", "null"] },
            flags: {
              type: "array",
              items: { type: "string" },
              description:
                "Deterministic, sorted. Empty means every cited document is current, " +
                "grounded, and uncontested as far as the vault knows",
            },
          },
          required: [
            "sourceCount",
            "byStatus",
            "openTensions",
            "oldestUpdated",
            "newestUpdated",
            "flags",
          ],
        },
        vaultHead: {
          type: ["string", "null"],
          description:
            "Git HEAD of the vault at receipt time — the as-of anchor. Null when " +
            "the vault is not a git repository (or has no commits yet)",
        },
        generatedAt: { type: "string", description: "ISO 8601" },
        receiptHash: {
          type: "string",
          description: "SHA-256 over the canonical JSON of every field above",
        },
      },
      required: ["claim", "sources", "summary", "vaultHead", "generatedAt", "receiptHash"],
    },
    handler: (vaultRoot, args, access) =>
      vaultReceipt(
        vaultRoot,
        {
          paths: Array.isArray(args.paths) ? (args.paths as string[]) : [],
          claim: typeof args.claim === "string" ? args.claim : undefined,
        },
        access,
      ),
  },
];
