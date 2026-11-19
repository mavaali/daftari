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
// One hop upstream (0ksb): each cited document's own `sources` are checked
// too — whether each can be verified at all, whether it still resolves, and
// whether a vault source has since been superseded, retracted, or contested —
// plus the compiled-edge staleness vault_read already reports. Never deeper:
// a source's sources are its own receipt's business.
//
// Discipline: the receipt only *reads* — frontmatter, the tension log, git.
// It never grades, never synthesizes prose, never mints a value. Flags are
// deterministic derivations from facts already in the vault. The optional
// `claim` is caller-supplied and carried verbatim (labeled as such); it is
// never interpolated into any Daftari-authored text.

import {
  type AccessContext,
  canRead,
  canVerifyRepoSources,
  readableCollections,
} from "../access/rbac.js";
import { loadAttestKey, signBytes } from "../attest/sign.js";
import { computeDecay, type DecayState } from "../curation/decay.js";
import {
  type CompiledStaleContext,
  compiledUpstreamStaleness,
  loadCompiledStaleContext,
  splitUpstreamVisibility,
} from "../curation/edge-staleness.js";
import {
  assessGrounding,
  GROUNDING_AT_RISK_SCHEMA,
  type GroundingAtRisk,
  type GroundingRiskKind,
  type GroundingSourceState,
  sourceRiskReasons,
  stateFromFrontmatter,
} from "../curation/grounding.js";
import {
  explicitVaultSourceTarget,
  resolveVaultSourceRef,
  verifyRepoSourceRef,
} from "../curation/source-refs.js";
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
import { sourceReadable, sourceVerifiable, visibleTensions } from "../curation/tension-access.js";
import { buildPathIndexes } from "../curation/vault-docs.js";
import { parseDocument } from "../frontmatter/parser.js";
import { parseSourceRef } from "../frontmatter/source-ref.js";
import {
  CONFIDENCES,
  err,
  type Frontmatter,
  ok,
  PROVENANCES,
  type Result,
  STATUSES,
} from "../frontmatter/types.js";
import type { IndexDb } from "../storage/index-db.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { loadConfig } from "../utils/config.js";
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
  // 0ksb: flags derived from this document's own sources, one hop. Sorted;
  // a subset of summary.flags. Lets a consumer see which cited document a
  // summary upstream flag came from.
  upstreamFlags: string[];
  // nlzr: the named detail behind the contested/expired/superseded/retracted
  // upstream flags — which source, which reason (tension ids, expiry date).
  // Null when no readable source is at risk; unreadable sources never appear.
  groundingAtRisk: GroundingAtRisk | null;
}

export interface ReceiptSummary {
  sourceCount: number;
  byStatus: Record<string, number>;
  // Distinct unresolved tensions across the cited set.
  openTensions: number;
  oldestUpdated: string | null;
  newestUpdated: string | null;
  // Deterministic, sorted. Empty means: every cited document is current and
  // uncontested, and so is every source it cites one hop up, each of which
  // could be checked and still resolves — as far as the vault knows. See
  // UPSTREAM_FLAGS for the one-hop flags.
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
  // #298: present when the server holds a usable DAFTARI_ATTEST_KEY — an
  // Ed25519 signature over the same payload bytes receiptHash covers. The
  // operator's attestation of the snapshot, not the caller's.
  signature?: { algorithm: "ed25519"; keyId: string; publicKey: string; value: string };
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

// 0ksb: the one-hop upstream flags, each a deterministic derivation from a
// cited document's own `sources` (plus its compiled consumes edges):
//
//   cites-unverifiable-source     — a source nothing in the vault can check:
//                                   distill: (born-unverifiable), http(s)/
//                                   mailto, other URI schemes, a legacy
//                                   string that resolves to no readable doc,
//                                   or a repo: ref this caller cannot verify.
//   cites-broken-source           — a source that resolves to nothing: a
//                                   vault: doc that is gone, a repo: file that
//                                   is missing. Never shown to a caller with
//                                   hidden collections (see unreadable).
//   cites-unreadable-source       — a vault source this caller cannot read.
//                                   For a caller who cannot read everything,
//                                   a deleted source reads the same way: the
//                                   two are deliberately indistinguishable
//                                   (#217/#416 — no existence oracle), and
//                                   nothing about the source's state shows.
//   cites-superseded-upstream     — a readable source is superseded.
//   cites-retracted-upstream      — a readable source is deprecated/archived.
//   cites-contested-upstream      — a readable source is party to an
//                                   unresolved tension the caller can see.
//   cites-expired-upstream        — a readable source is past its TTL or
//                                   its valid_until (nlzr).
//   cites-pending-broken-upstream — a compiled upstream input changed
//                                   incompatibly since this doc was compiled
//                                   (the edge-staleness class vault_read
//                                   banners).
//
// repo: refs are checked for existence only — the vault holds no content hash
// for them, so an altered repo file still passes.
export const UPSTREAM_FLAGS = [
  "cites-broken-source",
  "cites-contested-upstream",
  "cites-expired-upstream",
  "cites-pending-broken-upstream",
  "cites-retracted-upstream",
  "cites-superseded-upstream",
  "cites-unreadable-source",
  "cites-unverifiable-source",
] as const;
type UpstreamFlag = (typeof UPSTREAM_FLAGS)[number];

const RISK_FLAG: Record<GroundingRiskKind, UpstreamFlag> = {
  contested: "cites-contested-upstream",
  "ttl-expired": "cites-expired-upstream",
  "validity-ended": "cites-expired-upstream",
  superseded: "cites-superseded-upstream",
  retracted: "cites-retracted-upstream",
};

interface UpstreamContext {
  vaultRoot: string;
  access?: AccessContext;
  // True when nothing can be hidden from the caller: the operator path (no
  // access context) or a wildcard read grant. Only then is "resolves to
  // nothing" safe to report as broken rather than unreadable.
  seesAll: boolean;
  // Already filtered to what the caller may see.
  tensions: TensionEntry[];
  now: Date;
  stale: CompiledStaleContext | null;
  db: () => IndexDb | null;
  repo: () => { root: string | undefined; verify: boolean };
  legacyIndexes: () => Promise<ReturnType<typeof buildPathIndexes>>;
}

async function loadSourceFrontmatter(
  vaultRoot: string,
  rel: string,
): Promise<{ fm: Frontmatter; collection: string } | null> {
  const resolved = resolveVaultPath(vaultRoot, rel);
  if (!resolved.ok) return null;
  const file = await readFile(resolved.value.absPath);
  if (!file.ok) return null;
  const parsed = parseDocument(file.value);
  if (!parsed.ok) return null;
  const fm = parsed.value.frontmatter;
  return { fm, collection: fm.collection || topCollection(rel) };
}

async function upstreamFlagsFor(
  ctx: UpstreamContext,
  rel: string,
  sources: string[],
): Promise<{ flags: UpstreamFlag[]; grounding: GroundingAtRisk | null }> {
  const flags = new Set<UpstreamFlag>();
  const states: GroundingSourceState[] = [];

  // A readable vault source's own standing: the shared grounding classifier
  // (nlzr) decides, and each reason kind maps onto its upstream flag — so the
  // receipt, vault_read, vault_search and the wake list cannot disagree.
  const flagState = (target: string, fm: Frontmatter) => {
    const touching = ctx.tensions.filter((t) => t.sourceA === target || t.sourceB === target);
    const state = stateFromFrontmatter(
      target,
      fm,
      touching.flatMap((t) => (t.id ? [t.id] : [])),
      touching.length,
    );
    states.push(state);
    for (const reason of sourceRiskReasons(state, ctx.now)) flags.add(RISK_FLAG[reason.kind]);
  };

  for (const raw of sources) {
    const parsed = parseSourceRef(raw);
    switch (parsed.kind) {
      case "distill":
      case "external":
      case "opaque":
        flags.add("cites-unverifiable-source");
        break;
      case "repo": {
        const repo = ctx.repo();
        if (!repo.verify || repo.root === undefined) {
          flags.add("cites-unverifiable-source");
          break;
        }
        const status = verifyRepoSourceRef(repo.root, parsed.target).status;
        if (status === "missing") flags.add("cites-broken-source");
        else if (status !== "exists") flags.add("cites-unverifiable-source");
        break;
      }
      case "vault": {
        // An invalid address can name no document whatever the vault holds,
        // so calling it broken discloses nothing.
        const target = explicitVaultSourceTarget(raw);
        if (target === null) {
          flags.add("cites-broken-source");
          break;
        }
        if (target === rel) break;
        const src = await loadSourceFrontmatter(ctx.vaultRoot, target);
        if (src && (!ctx.access || canRead(ctx.access.role, src.collection))) {
          flagState(target, src.fm);
        } else {
          flags.add(ctx.seesAll ? "cites-broken-source" : "cites-unreadable-source");
        }
        break;
      }
      case "legacy": {
        // Legacy strings were never promised to resolve (tier0.ts): one that
        // names no readable doc is opaque provenance — unverifiable, never
        // broken, so a hidden target and an absent one read the same.
        const { byPath, byBasename } = await ctx.legacyIndexes();
        const source = resolveVaultSourceRef(raw, rel, byPath, byBasename);
        const target = source.kind === "vault" ? source.target : null;
        if (target === rel) break;
        const src = target ? await loadSourceFrontmatter(ctx.vaultRoot, target) : null;
        if (target && src && (!ctx.access || canRead(ctx.access.role, src.collection))) {
          flagState(target, src.fm);
        } else {
          flags.add("cites-unverifiable-source");
        }
        break;
      }
    }
  }

  // Compiled consumes edges: the same classification and disclosure split
  // vault_read uses, so the two surfaces cannot disagree.
  if (ctx.stale && ctx.stale.consumes.length > 0) {
    const db = ctx.db();
    const access = ctx.access;
    const rows = compiledUpstreamStaleness(rel, ctx.stale.consumes, ctx.stale.provenance, (u) =>
      sourceVerifiable(db, access, u),
    );
    const { visible, hiddenPending } =
      access && !ctx.seesAll
        ? splitUpstreamVisibility(rows, (u) => sourceReadable(db, access, u))
        : { visible: rows, hiddenPending: "none" as const };
    if (visible.some((r) => r.staleness === "pending-broken")) {
      flags.add("cites-pending-broken-upstream");
    }
    if (visible.some((r) => r.staleness === "unverifiable")) flags.add("cites-broken-source");
    if (hiddenPending !== "none") flags.add("cites-unreadable-source");
  }

  return { flags: [...flags].sort(), grounding: assessGrounding(states, ctx.now) };
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

  // One lazily opened index handle serves the tension visibility gate and the
  // compiled-edge staleness join; a receipt that needs neither never opens it.
  let db: IndexDb | null | undefined;
  const getDb = () => {
    if (db === undefined) db = openIndexForAccessOrNull(vaultRoot);
    return db;
  };
  try {
    return await compileReceipt(vaultRoot, args, access, tensionScan.value, getDb);
  } finally {
    db?.close();
  }
}

async function compileReceipt(
  vaultRoot: string,
  args: VaultReceiptArgs,
  access: AccessContext | undefined,
  allTensions: TensionEntry[],
  getDb: () => IndexDb | null,
): Promise<Result<VaultReceiptResult, Error>> {
  const tensionEntries = access ? visibleTensions(getDb(), allTensions, access) : allTensions;

  // Inputs to the one-hop upstream check, each loaded at most once and only
  // when a cited document's sources need it.
  const stale = await loadCompiledStaleContext(vaultRoot);
  let repo: { root: string | undefined; verify: boolean } | undefined;
  let legacy: ReturnType<typeof buildPathIndexes> | undefined;
  const upstream: UpstreamContext = {
    vaultRoot,
    access,
    seesAll: !access || readableCollections(access.role) === undefined,
    tensions: tensionEntries,
    now: new Date(),
    stale,
    db: getDb,
    repo: () => {
      if (repo === undefined) {
        const cfg = loadConfig(vaultRoot);
        repo = {
          root: cfg.ok ? cfg.value.repoRoot : undefined,
          verify: !access || canVerifyRepoSources(access.role),
        };
      }
      return repo;
    },
    // Filesystem universe (receipts work while the index builds), narrowed to
    // the caller's readable path prefixes so a hidden doc cannot make a bare
    // basename ambiguous or resolve it.
    legacyIndexes: async () => {
      if (legacy === undefined) {
        const files = await listFiles(vaultRoot);
        const paths = files.ok ? files.value : [];
        const visible = access
          ? paths.filter((p) => canRead(access.role, topCollection(p)))
          : paths;
        legacy = buildPathIndexes(visible.map((path) => ({ path })));
      }
      return legacy;
    },
  };

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
    const { flags: upstreamFlags, grounding } = await upstreamFlagsFor(upstream, rel, fm.sources);
    for (const f of upstreamFlags) flagSet.add(f);

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
      upstreamFlags,
      groundingAtRisk: grounding,
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
  const payloadBytes = JSON.stringify(payload);
  const receiptHash = sha256Hex(payloadBytes);

  // #298: operator-key receipt signing. When DAFTARI_ATTEST_KEY names a
  // usable Ed25519 key, the receipt carries a signature over the EXACT
  // payload bytes already hashed above — zero new canonicalization. Under
  // serve, every principal's receipt is signed by the one operator key:
  // the signature means "the operator's server attests this snapshot",
  // never "the caller attests it". The payload is RBAC-filtered before
  // signing, so the signature discloses nothing new. Set-but-unusable key
  // is a loud failure, never a silent unsigned receipt.
  const keyPath = process.env.DAFTARI_ATTEST_KEY;
  if (keyPath !== undefined && keyPath.length > 0) {
    const key = loadAttestKey(keyPath);
    if (!key.ok) {
      // Detail (which names the operator's filesystem path) goes to stderr,
      // never into an MCP-facing error body.
      process.stderr.write(`vault_receipt: attestation key unusable: ${key.error.message}\n`);
      return err(
        new Error(
          "vault_receipt: the server's DAFTARI_ATTEST_KEY is set but unusable — " +
            "ask the operator to check it",
        ),
      );
    }
    return ok({
      ...payload,
      receiptHash,
      signature: {
        algorithm: "ed25519" as const,
        keyId: key.value.keyId,
        publicKey: key.value.publicKeyPem,
        value: signBytes(key.value, payloadBytes),
      },
    });
  }

  return ok({ ...payload, receiptHash });
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
      "supersession chain, any unresolved tensions touching it, and flags " +
      "for its own sources one hop up. Plus a summary with deterministic " +
      "flags (e.g. cites-stale, cites-contested, cites-superseded; for " +
      "sources: cites-unverifiable-source for distill:, web, and other " +
      "uncheckable refs, cites-broken-source for a vault doc or repo file " +
      "that is gone, cites-unreadable-source for one you cannot read, and " +
      "cites-superseded-upstream / cites-retracted-upstream / " +
      "cites-contested-upstream / cites-expired-upstream / " +
      "cites-pending-broken-upstream for a source's own standing, with " +
      "groundingAtRisk naming which source and why). Empty flags mean each cited document is " +
      "current and uncontested and so is every source it cites one hop " +
      "up, each checkable and still present — no deeper; repo: refs are " +
      "checked for existence only. Also the vault's git HEAD as an as-of " +
      "anchor and a recomputable SHA-256 over the receipt. Attach the " +
      "receipt to the answer so downstream consumers can see what it " +
      "stands on. Read-only; facts are derived from frontmatter, the " +
      "tension log, the edge logs, and git — never invented.",
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
              upstreamFlags: {
                type: "array",
                items: { type: "string", enum: [...UPSTREAM_FLAGS] },
                description:
                  "Sorted flags derived from this document's own sources, one hop up; " +
                  "a subset of summary.flags",
              },
              groundingAtRisk: {
                oneOf: [GROUNDING_AT_RISK_SCHEMA, { type: "null" }],
                description:
                  "Which readable source puts this document's grounding at risk and why " +
                  "(contested with tension ids, expired with the date, superseded, " +
                  "retracted). Null when none; unreadable sources never appear.",
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
              "upstreamFlags",
              "groundingAtRisk",
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
                "Deterministic, sorted. Empty means every cited document is current " +
                "and uncontested, and so is every source it cites one hop up, each " +
                "checkable and still present, as far as the vault knows",
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
        signature: {
          type: "object",
          description:
            "Present when the server holds an attestation key (#298): an " +
            "ed25519 signature over the same payload bytes receiptHash " +
            "covers — the operator's attestation of this snapshot.",
          properties: {
            algorithm: { type: "string", enum: ["ed25519"] },
            keyId: { type: "string" },
            publicKey: { type: "string" },
            value: { type: "string" },
          },
          required: ["algorithm", "keyId", "publicKey", "value"],
          additionalProperties: false,
        },
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
