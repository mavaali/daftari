// Read-path tools: vault_read, vault_index, vault_status.
//
// Each tool exposes a pure async logic function (returns Result, never throws)
// plus an MCP ToolDefinition that wraps it. server.ts registers the
// definitions; tests call the logic functions directly.

import { type AccessContext, canRead, filterByReadPermission } from "../access/rbac.js";
import { type DescribesPin, parseDescribesEntry } from "../audit/describes.js";
import { computeDecay, type DecayState } from "../curation/decay.js";
import {
  compiledUpstreamStaleness,
  loadCompiledStaleContext,
  splitUpstreamVisibility,
  type UpstreamStaleness,
} from "../curation/edge-staleness.js";
import { comparePositions, isContested, unsuperseded } from "../curation/positions.js";
import { type ProvenanceEntry, readProvenanceLog } from "../curation/provenance.js";
import { recordRead } from "../curation/read-log.js";
import { computeStaleness } from "../curation/staleness.js";
import { type StructuralDecay, structuralDecay } from "../curation/structural.js";
import { DEFAULT_TENSION_STATUS, listTensions, TENSION_KINDS } from "../curation/tension.js";
import { sourceReadable, visibleTensions } from "../curation/tension-access.js";
import type { HiddenDownstream } from "../curation/tension-blast.js";
import { computeValidity, type ValidityReport } from "../curation/validity.js";
import {
  type FederatedPath,
  federatedPathOf,
  getMountRegistry,
  type LoadedMount,
  mountCanRead,
  parseFederatedPath,
} from "../federation/mounts.js";
import { parseDocument } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../frontmatter/schema.js";
import {
  CONFIDENCES,
  DOMAINS,
  err,
  type Frontmatter,
  ok,
  type Position,
  PROVENANCES,
  type Result,
  STANCES,
  STATUSES,
  TIERS,
  type ValidationReport,
} from "../frontmatter/types.js";
import { type ContestedTension, contestedFor } from "../search/contested.js";
import { getProvider } from "../search/vector.js";
import { countDimMismatches, getMeta, openIndexDb } from "../storage/index-db.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { loadConfig } from "../utils/config.js";
import { sha256Hex } from "../utils/hash.js";
import { readRunId } from "../utils/run-id.js";
import { ANCHOR_PIN_CAP, type AnchorState, classifyPin } from "./anchors.js";
import { openIndexForAccessOrNull } from "./search.js";

// Tool-annotation hints surfaced to MCP clients. The MCP spec treats these as
// *hints* — clients must not gate behavior on them — but directory reviewers
// require every tool to declare its safety profile, so we set them
// deliberately on each definition.
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  // Human-readable title surfaced in UIs (Claude Desktop, the connectors
  // directory). `name` stays machine-style; `title` is for humans.
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // JSON Schema (2020-12) for the handler's ok-value. Required: handlers
  // already return typed values, so an unschematized output is a type we
  // were too lazy to write down (spec 2026-07-26, Decision 3).
  outputSchema: Record<string, unknown>;
  // Compact model-facing summary for the `content` channel. Absent, the
  // bridge falls back to pretty-printed JSON of the full value. `vaultRoot` is
  // supplied so a summary can consult per-vault config (e.g. vault_lint's
  // `lint_voice`); summaries that don't need it simply ignore the argument.
  summarize?: (value: unknown, vaultRoot: string) => string;
  // Vault-relative doc paths the result references; the bridge emits a
  // daftari://doc/{path} resource_link per entry. Paths must already be
  // read-gated by the handler (links inherit read-gating by construction).
  docLinks?: (value: unknown) => string[];
  annotations?: ToolAnnotations;
  // `access` is supplied by the server transport on every call. When omitted
  // (a direct in-process call, e.g. from a test) RBAC is not enforced.
  handler: (
    vaultRoot: string,
    args: Record<string, unknown>,
    access?: AccessContext,
  ) => Promise<Result<unknown, Error>>;
}

// ---------------------------------------------------------------------------
// vault_read
// ---------------------------------------------------------------------------

// Reader-facing edge-staleness surface (#234), the decay banner's sibling:
// advisory, never blocking. `edges` lists only upstream units the caller can
// read (omission, #217); pending edges to unreadable units are coarsened
// into `hidden_pending` — never an exact count. Null when there is nothing
// to say (no compiled upstream edges visible AND no hidden pending signal),
// which is also what a document with no edges at all reports — no
// existence signal either way.
export interface UpstreamReadStaleness {
  edges: UpstreamStaleness[];
  hidden_pending: HiddenDownstream;
  // Pending-broken count among the VISIBLE edges (hidden ones only ever
  // surface through the coarse bucket above).
  pending_broken: number;
  banner: string | null;
}

export interface VaultReadResult {
  path: string;
  // #297: which vault served the document — a mount alias, or "local" for the
  // canonical vault. Always present so agents branch on the field, never on
  // parsing the path prefix.
  vault: string;
  content: string;
  frontmatter: Frontmatter;
  raw: Record<string, unknown>;
  validation: ValidationReport;
  hasFrontmatter: boolean;
  decay: DecayState | null;
  // Valid time: whether the document's claim holds TODAY, as opposed to
  // whether the document is fresh (that is `decay`). Null when neither
  // endpoint is authored — the same nothing-to-say contract `decay` follows.
  // Deliberately a sibling of `decay` rather than folded into it: an expired
  // interval must not promote a document to a decay level, because
  // consolidate/admit.ts treats `warn` as edge-blocking.
  validity: ValidityReport | null;
  upstream_staleness: UpstreamReadStaleness | null;
  // #8: graph-shaped decay — orphanhood and deprecated-still-linked, from
  // the materialized inbound-link graph, computed from the caller's vantage.
  // Null when there is nothing to say (same contract as `decay`).
  structural: StructuralDecay | null;
  // #8: unresolved tensions involving this document, the same shape (and
  // RBAC omission rules) as search hits' contested annotations. Absent when
  // none are visible.
  contested?: ContestedTension[];
  contestedCount?: number;
  // U-7 (LD-7): the positional contest block — distinct from `contested`
  // (tension annotations). Present ONLY on a contested doc with no
  // ratified org_position; absent otherwise (upstream_staleness's
  // absent-key discipline — no existence signal either way).
  contested_positions?: {
    flag: "CONTESTED";
    positions: Position[];
    open_tension_ids: string[];
    note: string;
  };
  // R-17 (LD-17): compile case 1 — the org's ratified stance, with the
  // surviving minority carried as full Position objects (not bare ids) and
  // an honest re-contest surface (C-1: a ratified mirror holds through a
  // fresh dispute; this is where that fresh dispute becomes visible).
  // Present ONLY when `org_position != null`; mutually exclusive with
  // `contested_positions` by construction (that block requires
  // `org_position == null`).
  ratified_view?: {
    flag: "RATIFIED";
    stance: Position["stance"];
    confidence: Position["confidence"];
    ratified_by: string;
    ratified_at: string;
    dissent: Position[];
    open_tension_ids: string[];
    note: string;
  };
  // U-11 (LD-23, DN-5): advisory annotation when ≥1 VISIBLE compiled
  // upstream input is contested-unratified. Caps effective confidence at
  // read time only — consumer frontmatter is NEVER mutated by this (the
  // advisory-curation invariant: a read of doc A never writes doc B).
  // Absent when there is nothing to report.
  contested_inputs?: {
    inputs: { unit: string }[];
    effective_confidence: "low";
    banner: string;
  };
  // JIT anchor pins (citation-anchors spec, Decision 2): pinned `describes`
  // bindings verified against their configured code repo at read time. Null
  // when there are no pinned bindings, no configured repo resolves, or
  // `jit_anchors` is off — the same null-when-silent contract as `decay`, and
  // deliberately indistinguishable between "no pins" and "repo not checked out"
  // so absence leaks nothing. Advisory only: a `moved`/`missing` state never
  // mutates the doc.
  anchors: ReadAnchors | null;
  // SHA-256 (hex) of the raw file bytes, frontmatter included. A caller passes
  // this back as a write tool's `base_version` to detect a stale write.
  version: string;
}

export interface ReadAnchorEntry {
  raw: string; // the `describes` entry as written
  repo: string;
  path: string;
  symbol: string | null;
  pin: DescribesPin;
  state: AnchorState;
  relocated?: { start: number; end: number }; // present for an intact-via-relocation
}

export interface ReadAnchors {
  entries: ReadAnchorEntry[];
  checked: number; // pinned+resolvable candidates classified (capped)
  skipped: number; // over-cap remainder (checked + skipped === candidate count)
  banner: string | null; // drift summary, or null when every checked pin is intact
  // Present only when ≥1 entry has `relocated` (intact-via-relocation) — names
  // the count and the exact vault_stage_action call to queue a fix. Absent
  // (not null, not empty-string) in all other cases (null-when-silent contract).
  repin_hint?: string;
}

// Federated read (#297): a document from a mounted vault, gated by the
// mount's principal-resolved role against the REFERENCED vault's policy and
// validated against ITS schema extensions. Documents only — decay, validity,
// upstream staleness, structural decay, tensions, positions, and anchors are
// all vault state of the referenced vault, which is not federated in v1, so
// every one of those channels is null/absent. The `version` token is still
// returned (it is just a hash of the bytes read). The read is deliberately
// NOT recorded in the canonical read log: its joins expect canonical
// relPaths, and a mount doc can never become a consumes edge in v1.
async function vaultReadFederated(
  mount: LoadedMount,
  fed: FederatedPath,
): Promise<Result<VaultReadResult, Error>> {
  if (mount.root === null) {
    return err(new Error(`mount "${mount.alias}" is unavailable — its path was not found`));
  }
  const resolved = resolveVaultPath(mount.root, fed.relPath);
  if (!resolved.ok) return resolved;
  const file = await readFile(resolved.value.absPath);
  if (!file.ok) return file;
  const parsed = parseDocument(file.value);
  if (!parsed.ok) return parsed;

  const collection = collectionOf(resolved.value.relPath, parsed.value.frontmatter);
  if (!mountCanRead(mount, collection)) {
    return err(
      new Error(`access denied: role '${mount.roleName}' cannot read collection '${collection}'`),
    );
  }

  // The advisory validation report is computed against the REFERENCED
  // vault's declared schema extensions — the caller sees the doc as its own
  // vault's schema judges it, not as the canonical vault's would.
  const { frontmatter, report } = validateFrontmatter(parsed.value.raw, mount.schemaExtensions);

  return ok({
    path: federatedPathOf(mount.alias, resolved.value.relPath),
    vault: mount.alias,
    content: parsed.value.content,
    frontmatter,
    raw: parsed.value.raw,
    validation: report,
    hasFrontmatter: parsed.value.hasFrontmatter,
    decay: null,
    validity: null,
    upstream_staleness: null,
    structural: null,
    anchors: null,
    version: sha256Hex(file.value),
  });
}

export async function vaultRead(
  vaultRoot: string,
  path: string,
  access?: AccessContext,
  runId?: string,
): Promise<Result<VaultReadResult, Error>> {
  if (typeof path !== "string" || path.length === 0) {
    return err(new Error("vault_read requires a non-empty 'path' argument"));
  }
  // Alias-path dispatch (#297): federated only when the first-':' prefix
  // exactly matches a declared mount alias; every other path — ':' included —
  // stays canonical.
  const fedRegistry = getMountRegistry();
  if (fedRegistry) {
    const fed = parseFederatedPath(path, fedRegistry);
    if (fed) {
      const mount = fedRegistry.mounts.get(fed.alias);
      if (mount) return vaultReadFederated(mount, fed);
    }
  }
  const resolved = resolveVaultPath(vaultRoot, path);
  if (!resolved.ok) return resolved;

  const file = await readFile(resolved.value.absPath);
  if (!file.ok) return file;

  const parsed = parseDocument(file.value);
  if (!parsed.ok) return parsed;

  if (access) {
    const collection = collectionOf(path, parsed.value.frontmatter);
    if (!canRead(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot read ` + `collection '${collection}'`,
        ),
      );
    }
  }

  // #234: classify this document's compiled upstream edges as of the serve.
  // Best-effort — the read never fails on telemetry; on a log-read error the
  // serve is still recorded, just uninstrumented (broken_upstream absent).
  //
  // Cost posture (accepted for v1): classification is derived at query time
  // from the two append-only logs, so an instrumented vault pays two log
  // scans per read — the price of having no verdict store that could itself
  // go stale. An UNinstrumented vault pays almost nothing: no consumes log
  // (or an empty one) short-circuits before the provenance log is touched,
  // since with zero compiled edges every broken count is zero. If vault
  // history ever makes the scans hurt, the escalation is an index.db mirror
  // of the logs (ephemeral, rebuildable — the edges.jsonl materialization
  // precedent), not caching bolted on here.
  const staleCtx = await loadCompiledStaleContext(vaultRoot);
  const rows: UpstreamStaleness[] | null = staleCtx
    ? compiledUpstreamStaleness(resolved.value.relPath, staleCtx.consumes, staleCtx.provenance)
    : null;

  // Every served read is logged — the broken-read rate needs its denominator
  // (#234) — and a run_id additionally joins the run's input set (#233).
  // Recorded only AFTER the RBAC gate (a denied read is never an input and
  // never a serve), under the CANONICAL relPath so the write-time join
  // matches performWrite's keying. broken_upstream is the TRUE count,
  // unfiltered by the caller's role: the log is local operator telemetry,
  // not a caller-facing surface. Best-effort: the read itself never fails
  // on a logging failure.
  await recordRead(vaultRoot, {
    tool: "vault_read",
    file: resolved.value.relPath,
    ...(runId ? { run_id: runId } : {}),
    ...(access?.user != null ? { principal: access.user } : {}),
    ...(rows
      ? { broken_upstream: rows.filter((r) => r.staleness === "pending-broken").length }
      : {}),
  });

  // One index handle serves every graph-backed enrichment below: the #234
  // visible/hidden split, structural decay (#8), and the contested join.
  // Open failure degrades every one of them to silence — all advisory.
  const db = openIndexForAccessOrNull(vaultRoot);
  let upstream: UpstreamReadStaleness | null = null;
  let structural: StructuralDecay | null = null;
  let contestedResult: { contested: ContestedTension[]; contestedCount: number } | null = null;
  try {
    // Reader-facing surface: visible edges by omission, hidden pending edges
    // coarsened (#217 — an exact count over unreadable units is a small-cell
    // existence leak). Collapses to null when there is nothing to report,
    // which is byte-identical to a document with no compiled edges at all.
    if (rows && rows.length > 0) {
      const {
        visible,
        hiddenPending,
      }: { visible: UpstreamStaleness[]; hiddenPending: HiddenDownstream } = access
        ? splitUpstreamVisibility(rows, (unit) => sourceReadable(db, access, unit))
        : { visible: rows, hiddenPending: "none" };
      if (visible.length > 0 || hiddenPending !== "none") {
        const pendingBroken = visible.filter((r) => r.staleness === "pending-broken").length;
        const notes: string[] = [];
        if (pendingBroken > 0) {
          notes.push(
            `${pendingBroken} compiled upstream input${pendingBroken === 1 ? " has" : "s have"} ` +
              `changed incompatibly since this document was compiled`,
          );
        }
        if (hiddenPending !== "none") {
          notes.push(
            `${hiddenPending} upstream inputs outside your read scope have pending changes`,
          );
        }
        upstream = {
          edges: visible,
          hidden_pending: hiddenPending,
          pending_broken: pendingBroken,
          banner: notes.length > 0 ? `${notes.join("; ")} — this content may predate them.` : null,
        };
      }
    }

    // #8: structural decay from the materialized inbound-link graph (one
    // indexed query, lint's vantage rule), plus unresolved-tension parity
    // with search's contested channel.
    structural = structuralDecay({
      db,
      path: resolved.value.relPath,
      status: parsed.value.frontmatter.status,
      access,
    });
    if (db) contestedResult = contestedFor(vaultRoot, db, resolved.value.relPath, access);
  } finally {
    db?.close();
  }

  // U-7 / R-17: positional contest and ratified-view blocks share one open
  // positional tension scan — the two conditions are mutually exclusive by
  // construction (LD-17: contested_positions requires org_position == null,
  // ratified_view requires org_position != null), so at most one ever reads
  // the result. Positional tensions are self-tensions on THIS doc; the
  // caller passed the canRead gate above, so their ids are visible by
  // construction — no per-tension visibility check (LD-15).
  const posSet = parsed.value.frontmatter.positions;
  const org = parsed.value.frontmatter.org_position;
  let contestedPositions: VaultReadResult["contested_positions"];
  let ratifiedView: VaultReadResult["ratified_view"];
  if (posSet != null || org != null) {
    const tensionsRes = await listTensions(vaultRoot);
    const openIds = tensionsRes.ok
      ? tensionsRes.value
          .filter(
            (t) => t.kind === "positional" && !t.resolved && t.sourceA === resolved.value.relPath,
          )
          .map((t) => t.id)
          .filter((id): id is string => id !== undefined)
      : [];

    if (posSet != null && org == null && isContested(posSet)) {
      contestedPositions = {
        flag: "CONTESTED",
        positions: unsuperseded(posSet).slice().sort(comparePositions),
        open_tension_ids: openIds,
        note: "the org has no consolidated view on this claim",
      };
    }

    if (org != null) {
      const byId = new Map((posSet ?? []).map((p) => [p.id, p]));
      const dissent = org.dissent
        .map((id) => byId.get(id))
        .filter((p): p is Position => p !== undefined)
        .sort(comparePositions);
      const notes: string[] = [];
      if (dissent.length > 0) {
        notes.push(
          `standing dissent: ${dissent.length} minority position${dissent.length === 1 ? "" : "s"} remain live`,
        );
      }
      if (openIds.length > 0) {
        notes.push("re-contested: open positional tension(s) contest the ratified view");
      }
      const base = `org position: ${org.stance} (${org.confidence}), ratified by ${org.ratified_by} ${org.ratified_at}`;
      ratifiedView = {
        flag: "RATIFIED",
        stance: org.stance,
        confidence: org.confidence,
        ratified_by: org.ratified_by,
        ratified_at: org.ratified_at,
        dissent,
        open_tension_ids: openIds,
        note: notes.length > 0 ? `${base}; ${notes.join("; ")}` : base,
      };
    }
  }

  // JIT anchor pins (#xjo, spec Decision 2). Best-effort and fully self-
  // contained: any failure (config load, git, guarded read) collapses to
  // `anchors: null` and the read still succeeds. Only PINNED describes bindings
  // whose `repo:` prefix resolves to a configured code repo are candidates; a
  // bare binding resolves to the vault itself (the "" sentinel below), which is
  // never a code repo, so it is skipped.
  const anchors = await computeAnchors(
    vaultRoot,
    resolved.value.relPath,
    parsed.value.frontmatter.describes ?? [],
  );

  // Decision 4 — softened decay copy (annotate-only). A doc past its TTL whose
  // code pins are ALL intact is stale by the clock but verifiably current about
  // the code it describes, so we APPEND a softening clause to the decay banner.
  // Copy only: level, reasons, score, bucket, and vault_status are untouched —
  // one untouched source file must never launder whole-doc rot into freshness.
  let decay = computeDecay(parsed.value.frontmatter);
  if (
    decay?.banner &&
    anchors &&
    anchors.entries.length > 0 &&
    anchors.entries.every((e) => e.state === "intact")
  ) {
    const st = computeStaleness(
      {
        updated: parsed.value.frontmatter.updated,
        ttl_days: parsed.value.frontmatter.ttl_days,
      },
      new Date(),
    );
    if (st.expired) {
      const n = anchors.entries.length;
      decay = {
        ...decay,
        banner:
          `${decay.banner} Past TTL, but its ${n} code pin${n === 1 ? "" : "s"} ` +
          "intact — the code it describes has not changed since the pins were written.",
      };
    }
  }

  // U-11 (LD-23, DN-5): advisory cap on VISIBLE compiled upstream inputs
  // that are themselves contested-unratified. Iterates upstream?.edges
  // only — already RBAC-visibility-filtered above (#217's splitUpstream
  // Visibility) — so no separate per-unit visibility check here. Per-unit
  // read/parse failure is skipped silently (advisory, never authoritative;
  // this read must never fail on another document's state). Cost posture:
  // one extra readFile+parse per compiled edge, paid only when the doc has
  // compiled inputs at all.
  let contestedInputs: VaultReadResult["contested_inputs"];
  const contestedUnits: string[] = [];
  for (const edge of upstream?.edges ?? []) {
    const unitResolved = resolveVaultPath(vaultRoot, edge.unit);
    if (!unitResolved.ok) continue;
    const unitFile = await readFile(unitResolved.value.absPath);
    if (!unitFile.ok) continue;
    const unitParsed = parseDocument(unitFile.value);
    if (!unitParsed.ok) continue;
    const unitFm = unitParsed.value.frontmatter;
    if (unitFm.positions != null && isContested(unitFm.positions) && unitFm.org_position == null) {
      contestedUnits.push(edge.unit);
    }
  }
  if (contestedUnits.length > 0) {
    contestedInputs = {
      inputs: contestedUnits.map((unit) => ({ unit })),
      effective_confidence: "low",
      banner:
        `${contestedUnits.length} compiled input${contestedUnits.length === 1 ? " is" : "s are"} ` +
        "contested without a ratified org position — treat this content as low-confidence until consolidated.",
    };
  }

  return ok({
    path,
    vault: "local",
    content: parsed.value.content,
    frontmatter: parsed.value.frontmatter,
    raw: parsed.value.raw,
    validation: parsed.value.validation,
    hasFrontmatter: parsed.value.hasFrontmatter,
    decay,
    // Evaluated against today. No index access and no RBAC branch — these
    // fields belong to a document the caller has already been permitted to
    // read.
    validity: computeValidity(parsed.value.frontmatter, new Date().toISOString().slice(0, 10)),
    upstream_staleness: upstream,
    structural,
    ...(contestedResult
      ? { contested: contestedResult.contested, contestedCount: contestedResult.contestedCount }
      : {}),
    ...(contestedPositions ? { contested_positions: contestedPositions } : {}),
    ...(ratifiedView ? { ratified_view: ratifiedView } : {}),
    ...(contestedInputs ? { contested_inputs: contestedInputs } : {}),
    anchors,
    version: sha256Hex(file.value),
  });
}

// Classify a doc's pinned `describes` bindings against their configured code
// repos. Returns null when there is nothing to say (no pinned+resolvable
// bindings, or `jit_anchors` off) or when anything at all goes wrong — the
// read-path best-effort contract. Never throws.
// `vaultRelPath` is the canonical, symlink-resolved, no-leading-dot relative
// path of the document (from `resolveVaultPath(...).relPath`). It is embedded
// verbatim in the `repin_hint`'s `target_path` so the hint is stageable
// without further normalisation.
async function computeAnchors(
  vaultRoot: string,
  vaultRelPath: string,
  describes: string[],
): Promise<ReadAnchors | null> {
  try {
    const cfg = loadConfig(vaultRoot);
    if (!cfg.ok || !cfg.value.jitAnchors) return null;
    const codeRepos = cfg.value.codeRepos;

    // "" sentinel source repo: a bare (prefix-less) binding resolves to "",
    // which is never a configured code-repo key, so it is filtered out here.
    const candidates = describes
      .map((raw) => ({ raw, parsed: parseDescribesEntry(raw, "") }))
      .filter((c) => c.parsed.pin !== undefined && codeRepos[c.parsed.repo] !== undefined);
    if (candidates.length === 0) return null;

    const checkedList = candidates.slice(0, ANCHOR_PIN_CAP);
    const skipped = candidates.length - checkedList.length;

    const entries: ReadAnchorEntry[] = [];
    for (const { raw, parsed } of checkedList) {
      const pin = parsed.pin as DescribesPin;
      const cls = await classifyPin(codeRepos[parsed.repo] as string, parsed.path, pin);
      if (!cls) continue; // null → degrade this binding to absent
      entries.push({
        raw,
        repo: parsed.repo,
        path: parsed.path,
        symbol: parsed.symbol,
        pin,
        state: cls.state,
        ...(cls.relocated ? { relocated: cls.relocated } : {}),
      });
    }

    const drift = entries.filter((e) => e.state === "moved" || e.state === "missing").length;
    const banner =
      drift > 0
        ? `${drift} code citation${drift === 1 ? "" : "s"} moved or missing — ` +
          "re-check the source before trusting this document's account of it."
        : null;

    // R6: when ≥1 entry is intact-via-relocation, tell the reading agent exactly
    // how to queue a fix. Derived entirely from already-computed entries (R7 —
    // no staging, no writes, no new git work from this read path).
    const relocatedCount = entries.filter((e) => e.relocated !== undefined).length;
    const repinHint =
      relocatedCount > 0
        ? `${relocatedCount} pin${relocatedCount === 1 ? "" : "s"} ${relocatedCount === 1 ? "has" : "have"} relocated — ` +
          `stage a fix with vault_stage_action { action_type: "repin", target_path: "${vaultRelPath}" }`
        : undefined;

    return {
      entries,
      checked: checkedList.length,
      skipped,
      banner,
      ...(repinHint !== undefined ? { repin_hint: repinHint } : {}),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// vault_index
// ---------------------------------------------------------------------------

export interface VaultIndexFilters {
  collection?: string;
  status?: string;
  domain?: string;
  tags?: string[];
  // When set, keep only documents that have (true) or do not have (false)
  // open questions in `questions_raised`.
  hasUnanswered?: boolean;
}

export interface VaultIndexEntry {
  path: string;
  // #297: set on federated listings — the mount alias; `path` is then the
  // addressable `alias:relPath` form. Absent on canonical listings.
  vault?: string;
  title: string;
  collection: string;
  domain: string;
  status: string;
  confidence: string;
  updated: string;
  tags: string[];
  questionsAnswered: string[];
  questionsRaised: string[];
  valid: boolean;
}

export interface VaultIndexResult {
  count: number;
  entries: VaultIndexEntry[];
}

// A document's collection is its frontmatter `collection`, falling back to the
// top-level directory of its vault-relative path.
//
// Exported because the MCP resource layer (src/resources.ts) gates
// `resources/read` on the same predicate vault_read uses. One visibility rule,
// not two that can drift apart.
export function collectionOf(relPath: string, fm: Frontmatter): string {
  if (fm.collection) return fm.collection;
  const top = relPath.split("/")[0];
  return top ?? "";
}

// One parsed document from a whole-vault scan. Shared by vaultIndex and
// vaultStatus so a status call pays for ONE read+parse sweep, not two.
interface ScannedDoc {
  relPath: string;
  frontmatter: Frontmatter;
  valid: boolean;
}

async function scanVaultDocs(vaultRoot: string): Promise<Result<ScannedDoc[], Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  const docs: ScannedDoc[] = [];
  for (const relPath of list.value) {
    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) continue;
    const file = await readFile(resolved.value.absPath);
    if (!file.ok) continue;
    const parsed = parseDocument(file.value);
    if (!parsed.ok) continue;
    docs.push({
      relPath,
      frontmatter: parsed.value.frontmatter,
      valid: parsed.value.validation.valid,
    });
  }
  return ok(docs);
}

function toIndexEntry(doc: ScannedDoc): VaultIndexEntry {
  const fm = doc.frontmatter;
  return {
    path: doc.relPath,
    title: fm.title,
    collection: collectionOf(doc.relPath, fm),
    domain: fm.domain,
    status: fm.status,
    confidence: fm.confidence,
    updated: fm.updated,
    tags: fm.tags,
    questionsAnswered: fm.questions_answered,
    questionsRaised: fm.questions_raised,
    valid: doc.valid,
  };
}

function matchesIndexFilters(doc: ScannedDoc, filters: VaultIndexFilters): boolean {
  const fm = doc.frontmatter;
  if (filters.collection && collectionOf(doc.relPath, fm) !== filters.collection) return false;
  if (filters.status && fm.status !== filters.status) return false;
  if (filters.domain && fm.domain !== filters.domain) return false;
  if (filters.tags && filters.tags.length > 0 && !filters.tags.every((t) => fm.tags.includes(t))) {
    return false;
  }
  if (filters.hasUnanswered !== undefined) {
    if (fm.questions_raised.length > 0 !== filters.hasUnanswered) return false;
  }
  return true;
}

export async function vaultIndex(
  vaultRoot: string,
  filters: VaultIndexFilters = {},
  access?: AccessContext,
): Promise<Result<VaultIndexResult, Error>> {
  const docs = await scanVaultDocs(vaultRoot);
  if (!docs.ok) return docs;

  const entries = docs.value.filter((d) => matchesIndexFilters(d, filters)).map(toIndexEntry);

  // RBAC: drop documents in collections the role cannot read.
  const visible = access ? filterByReadPermission(access.role, entries) : entries;
  return ok({ count: visible.length, entries: visible });
}

// #297: one mount's listing, under the mount's granted role (plain omission
// per the referenced vault's own policy — readable-subset only, never a
// visible/total split). Paths come back in the addressable `alias:relPath`
// form (the round-trip property).
export async function vaultIndexMount(
  mount: LoadedMount,
  filters: VaultIndexFilters = {},
): Promise<Result<VaultIndexResult, Error>> {
  if (mount.root === null) {
    return err(new Error(`mount "${mount.alias}" is unavailable — its path was not found`));
  }
  const docs = await scanVaultDocs(mount.root);
  if (!docs.ok) return docs;
  const entries = docs.value
    .filter((d) => matchesIndexFilters(d, filters))
    .map(toIndexEntry)
    .filter((e) => mountCanRead(mount, e.collection))
    .map((e) => ({ ...e, path: federatedPathOf(mount.alias, e.path), vault: mount.alias }));
  return ok({ count: entries.length, entries });
}

// ---------------------------------------------------------------------------
// vault_status
// ---------------------------------------------------------------------------

// Vault files bucketed by decay score: fresh (< 0.5 of TTL elapsed), aging
// (>= 0.5, not yet expired), stale (>= 1.0 — at or past TTL). `total` is the
// number of files scored, which equals the role's visible file count.
export interface StalenessDistribution {
  fresh: number;
  aging: number;
  stale: number;
  total: number;
}

// Adoption monitor for the valid-time axis. A READ-ONLY signal, never a
// target: valid time is authored, so driving this number up by any means
// other than someone knowing the dates would defeat the point. Follows the
// coverageEquity posture — report it, do not optimize it.
export interface ValidityCoverage {
  authored: number; // at least one endpoint set
  unknown: number; // both endpoints absent
  total: number;
}

export interface TensionSummary {
  title: string;
  date: string;
}

export interface UnresolvedTensions {
  count: number;
  recent: TensionSummary[];
}

export interface RecentWrites {
  count: number;
  entries: ProvenanceEntry[];
}

// #297: per-mount status line. Counts are the READABLE subset under the
// mount's principal-resolved role — never unfiltered totals (a referenced
// vault's global counts sliced for a guest are exactly the aggregate the
// 2026-07-14 spec rejected). `readableDocCount` is null when unavailable.
// `lastRefresh` is null until the per-mount index ships (follow-up slice).
export interface FederationMountStatus {
  alias: string;
  state: "ok" | "unavailable";
  readableDocCount: number | null;
  lastRefresh: string | null;
}

export interface VaultStatusResult {
  vault: string;
  fileCount: number;
  collections: { collection: string; count: number }[];
  invalidCount: number;
  generatedAt: string;
  stalenessDistribution: StalenessDistribution;
  validityCoverage: ValidityCoverage;
  unresolvedTensions: UnresolvedTensions;
  recentWrites: RecentWrites;
  // Number of embedding cache rows for the active model whose stored dim
  // does not match the current provider's dim. A non-zero value means those
  // chunks will be silently skipped in vector ranking; this field surfaces
  // the condition so the operator can investigate rather than wonder why
  // search quality is degraded.
  embeddingDimMismatches: number;
  // #297: present only when federation is configured — one entry per mount.
  federation?: FederationMountStatus[];
}

export async function vaultStatus(
  vaultRoot: string,
  access?: AccessContext,
): Promise<Result<VaultStatusResult, Error>> {
  // vault_status reports only over the documents the role can read. ONE
  // whole-vault scan feeds both the index-shaped aggregates and the staleness
  // distribution — scoring from the already-parsed frontmatter instead of a
  // second read+parse sweep through listStaleFiles.
  const scan = await scanVaultDocs(vaultRoot);
  if (!scan.ok) return scan;
  const allEntries = scan.value.map(toIndexEntry);
  const visibleEntries = access ? filterByReadPermission(access.role, allEntries) : allEntries;
  const indexEntries = { count: visibleEntries.length, entries: visibleEntries };

  const byCollection = new Map<string, number>();
  let invalidCount = 0;
  for (const entry of indexEntries.entries) {
    byCollection.set(entry.collection, (byCollection.get(entry.collection) ?? 0) + 1);
    if (!entry.valid) invalidCount += 1;
  }

  const collections = [...byCollection.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([collection, count]) => ({ collection, count }));

  // Staleness distribution over the visible set, from the same scan. One
  // shared instant scores every document (as listStaleFiles did) so two docs
  // straddling a UTC day boundary mid-scan can't bucket inconsistently.
  const scanNow = new Date();
  const visiblePaths = new Set(indexEntries.entries.map((e) => e.path));
  const stalenessDistribution: StalenessDistribution = {
    fresh: 0,
    aging: 0,
    stale: 0,
    total: 0,
  };
  // Same loop, same visible-set gate, same shared instant — the adoption
  // monitor must never widen the denominator past what the caller can read,
  // or the count leaks vault size.
  const validityCoverage: ValidityCoverage = { authored: 0, unknown: 0, total: 0 };
  for (const doc of scan.value) {
    if (!visiblePaths.has(doc.relPath)) continue;
    stalenessDistribution.total += 1;
    validityCoverage.total += 1;
    const hasInterval =
      (doc.frontmatter.valid_from ?? null) !== null ||
      (doc.frontmatter.valid_until ?? null) !== null;
    if (hasInterval) validityCoverage.authored += 1;
    else validityCoverage.unknown += 1;
    const score = computeStaleness(
      {
        updated: doc.frontmatter.updated,
        ttl_days: doc.frontmatter.ttl_days,
      },
      scanNow,
    ).score;
    if (score >= 1) stalenessDistribution.stale += 1;
    else if (score >= 0.5) stalenessDistribution.aging += 1;
    else stalenessDistribution.fresh += 1;
  }

  // Unresolved tensions and provenance entries carry only a path (no
  // frontmatter), so RBAC on them goes through the shared source predicates
  // (canonicalized — an alias must not widen visibility). A tension shows
  // only when the role can read BOTH sources; a write entry when it can read
  // the written file. Neither leaks the existence of a doc in a denied
  // collection.
  const tensions = await listTensions(vaultRoot, DEFAULT_TENSION_STATUS);
  if (!tensions.ok) return tensions;
  const log = await readProvenanceLog(vaultRoot);
  if (!log.ok) return log;

  let tensionEntries = tensions.value;
  let visibleWrites = log.value;
  if (access) {
    const accessDb = openIndexForAccessOrNull(vaultRoot);
    try {
      tensionEntries = visibleTensions(accessDb, tensions.value, access);
      visibleWrites = log.value.filter((e) => sourceReadable(accessDb, access, e.file));
    } finally {
      accessDb?.close();
    }
  }
  const recentTensions = [...tensionEntries]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .map((t) => ({ title: t.title, date: t.date }));

  // Dim-mismatch counter. A non-zero value means some embedding cache rows
  // for the active model have the wrong dim and are being silently skipped
  // by vector ranking. We open the DB defensively — if sqlite-vec isn't
  // installed or the index hasn't been built yet, the field is 0.
  const provider = getProvider();
  let embeddingDimMismatches = 0;
  const dbResult = openIndexDb(vaultRoot, provider.dim);
  if (dbResult.ok) {
    try {
      embeddingDimMismatches = countDimMismatches(dbResult.value, provider.id, provider.dim);
    } finally {
      dbResult.value.close();
    }
  }

  // #297: one status line per mount. Doc counts are computed over the mount's
  // readable subset under its principal-resolved role — a whole-mount scan,
  // paid only when federation is configured. Reads only; nothing under the
  // referenced root is created or opened for write.
  let federation: FederationMountStatus[] | undefined;
  const fedRegistry = getMountRegistry();
  if (fedRegistry) {
    federation = [];
    for (const mount of fedRegistry.mounts.values()) {
      if (mount.root === null) {
        federation.push({
          alias: mount.alias,
          state: "unavailable",
          readableDocCount: null,
          lastRefresh: null,
        });
        continue;
      }
      const mountScan = await scanVaultDocs(mount.root);
      const readable = mountScan.ok
        ? mountScan.value.filter((d) => mountCanRead(mount, collectionOf(d.relPath, d.frontmatter)))
            .length
        : null;
      // Last index build, from the mount index's own meta (the db lives under
      // the canonical .daftari/federation/<alias>/ redirect). Null until the
      // first build lands.
      let lastRefresh: string | null = null;
      const mountDb = openIndexForAccessOrNull(mount.root);
      if (mountDb) {
        try {
          lastRefresh = getMeta(mountDb, "indexed_at");
        } finally {
          mountDb.close();
        }
      }
      federation.push({
        alias: mount.alias,
        state: "ok",
        readableDocCount: readable,
        lastRefresh,
      });
    }
  }

  return ok({
    vault: vaultRoot,
    fileCount: indexEntries.count,
    collections,
    invalidCount,
    generatedAt: new Date().toISOString(),
    stalenessDistribution,
    validityCoverage,
    unresolvedTensions: {
      count: tensionEntries.length,
      recent: recentTensions,
    },
    recentWrites: {
      count: visibleWrites.length,
      entries: visibleWrites.slice(-10),
    },
    embeddingDimMismatches,
    ...(federation ? { federation } : {}),
  });
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

// Output-schema fragments (JSON Schema 2020-12). Shared shapes live here
// because several tools embed the same value: a schema that drifts between
// two tools describes the same type two different ways, which is worse than
// no schema at all.
//
// `additionalProperties: false` is used sparingly and only where a value is
// closed by construction. Frontmatter carries config-declared extension
// fields, `raw` is whatever the author's YAML said, and provenance entries
// are read back from an append-only log written by older versions — all three
// legitimately carry keys this schema does not name.

// Frontmatter as validateFrontmatter always produces it: every built-in field
// present and coerced, plus any config-declared extension fields.
export const FRONTMATTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    domain: { type: "string", enum: [...DOMAINS] },
    collection: { type: "string" },
    status: { type: "string", enum: [...STATUSES] },
    confidence: { type: "string", enum: [...CONFIDENCES] },
    created: { type: "string", description: "YYYY-MM-DD (verbatim as authored)" },
    updated: { type: "string", description: "YYYY-MM-DD (verbatim as authored)" },
    updated_by: { type: "string", description: "agent:<id> | human:<username>" },
    provenance: { type: "string", enum: [...PROVENANCES] },
    // null means no write-path tier enforcement — the pre-#141 default.
    tier: { type: ["string", "null"], enum: [...TIERS, null] },
    sources: { type: "array", items: { type: "string" } },
    superseded_by: { type: ["string", "null"] },
    ttl_days: { type: ["number", "null"] },
    tags: { type: "array", items: { type: "string" } },
    describes: { type: "array", items: { type: "string" } },
    questions_answered: { type: "array", items: { type: "string" } },
    questions_raised: { type: "array", items: { type: "string" } },
    subjects: { type: "array", items: { type: "string" } },
  },
  required: [
    "title",
    "domain",
    "collection",
    "status",
    "confidence",
    "created",
    "updated",
    "updated_by",
    "provenance",
    "tier",
    "sources",
    "superseded_by",
    "ttl_days",
    "tags",
    "describes",
    "questions_answered",
    "questions_raised",
    "subjects",
  ],
};

const VALIDATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    valid: { type: "boolean" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          message: { type: "string" },
        },
        required: ["field", "message"],
      },
    },
  },
  required: ["valid", "issues"],
};

// computeDecay's return: null when healthy (the silent baseline), otherwise a
// level with reasons and a banner that is null for `aging` (scarcity rule).
// Exported: vault_receipt embeds the same value per cited source.
export const DECAY_SCHEMA: Record<string, unknown> = {
  type: ["object", "null"],
  properties: {
    level: { type: "string", enum: ["deprecated", "warn", "aging"] },
    reasons: { type: "array", items: { type: "string" } },
    banner: { type: ["string", "null"] },
  },
  required: ["level", "reasons", "banner"],
};

// One classified upstream edge (#234). Only compiled edges can reach
// pending-broken; the other classes park in pending-unchecked.
const UPSTREAM_EDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    unit: { type: "string" },
    edge_class: { type: "string", enum: ["compiled", "declared", "earned"] },
    staleness: {
      type: "string",
      enum: ["current", "pending-unchecked", "pending-compatible", "pending-broken"],
    },
    baseline: {
      type: ["string", "null"],
      description: "ISO timestamp the classification measured from; null when none is derivable",
    },
    changed_fields: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["unit", "edge_class", "staleness", "baseline", "changed_fields", "reason"],
};

// One index row / vault_index entry.
const INDEX_ENTRY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Vault-relative path; on a federated listing, the addressable " +
        "'<alias>:<path>' form (#297)",
    },
    vault: {
      type: "string",
      description: "Federation mount alias, set only on federated listings (#297)",
    },
    title: { type: "string" },
    collection: { type: "string" },
    domain: { type: "string", enum: [...DOMAINS] },
    status: { type: "string", enum: [...STATUSES] },
    confidence: { type: "string", enum: [...CONFIDENCES] },
    updated: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    questionsAnswered: { type: "array", items: { type: "string" } },
    questionsRaised: { type: "array", items: { type: "string" } },
    valid: { type: "boolean", description: "Whether the document's frontmatter validates" },
  },
  required: [
    "path",
    "title",
    "collection",
    "domain",
    "status",
    "confidence",
    "updated",
    "tags",
    "questionsAnswered",
    "questionsRaised",
    "valid",
  ],
};

// A curation-log line, replayed. Entries are read back from an append-only
// JSONL log — older versions wrote fewer keys, future ones may write more, so
// only the four always-present fields are required and the object stays open.
const PROVENANCE_ENTRY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    timestamp: { type: "string", description: "ISO 8601" },
    tool: { type: "string" },
    file: { type: "string", description: "Vault-relative path" },
    agent: { type: "string", description: "Caller-claimed identity, e.g. agent:claude-code" },
    action: {
      type: "string",
      description:
        "create | update | append | promote | deprecate for a write that landed; " +
        "rejected_stale for one refused by the base_version check",
    },
    principal: { type: "string", description: "Authenticated identity, when the server has one" },
    run_id: { type: "string" },
    body_changed: { type: "boolean" },
    frontmatter_diff: {
      type: "object",
      description: "Per-field before/after for every frontmatter field the write changed",
      additionalProperties: {
        type: "object",
        properties: { before: {}, after: {} },
      },
    },
    reason: { type: "string" },
  },
  required: ["timestamp", "tool", "file", "agent", "action"],
};

// Shared item schema for a full Position object, used by both
// contested_positions.positions and ratified_view.dissent.
const READ_POSITION_ITEM_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    id: { type: "string" },
    principal: { type: "string" },
    stance: { type: "string", enum: [...STANCES] },
    statement: { type: ["string", "null"] },
    confidence: { type: "string", enum: [...CONFIDENCES] },
    provenance: { type: "string", enum: [...PROVENANCES] },
    valid_from: { type: ["string", "null"] },
    superseded_by: { type: ["string", "null"] },
    created: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
  },
  required: [
    "id",
    "principal",
    "stance",
    "statement",
    "confidence",
    "provenance",
    "valid_from",
    "superseded_by",
    "created",
    "sources",
  ],
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

export const readTools: ToolDefinition[] = [
  {
    name: "vault_read",
    title: "Read a vault document",
    annotations: { readOnlyHint: true },
    description:
      "Read a single vault document. Returns its markdown body, parsed " +
      "frontmatter, a validation report, a decay assessment (null when " +
      "healthy; otherwise level, reasons, and an optional banner), a " +
      "validity report (valid time — whether the document's CLAIM was true " +
      "in the world at a given date, which is not the same as whether the " +
      "document is fresh: 'decay' answers freshness, 'validity' answers " +
      "truth-in-the-world; null when the document authors no interval, which " +
      "means unknown and never 'always true'), an " +
      "upstream_staleness report (#234 — per compiled input, whether it " +
      "changed since this document was compiled and what tier 1 says about " +
      "the pending change: current / pending-compatible / pending-broken; " +
      "null when there is nothing to report), a structural report (#8 — " +
      "orphan: nothing you can read links here; retired_still_linked: " +
      "canonical docs still lean on this retired (deprecated/superseded) one; null when healthy), " +
      "any unresolved tensions involving the document (contested, same " +
      "shape as search hits), a contested_positions block when principals " +
      "hold conflicting live positions and no org position is ratified, " +
      "a ratified_view block when an org position IS ratified (the org's " +
      "belief at its confidence, with the surviving minority carried as " +
      "full dissent positions, and an honest re-contest note when a fresh " +
      "dispute has landed since ratification — mutually exclusive with " +
      "contested_positions), a contested_inputs block when a VISIBLE " +
      "compiled upstream input is itself contested-unratified (advisory " +
      "only — caps the READ-TIME effective confidence at low; never " +
      "writes back to this document), and a 'version' token (SHA-256 of the file) " +
      "that can be passed back to a write tool as 'base_version' for " +
      "optimistic-concurrency checking. Path is relative to the vault root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Vault-relative path to the markdown file, e.g. competitive-intel/foo.md. " +
            "With federation configured, an '<alias>:<path>' form reads from " +
            "that mounted vault (documents only; read-only).",
        },
        run_id: {
          type: "string",
          description:
            "Optional trace/run identifier of the calling run. Recorded in " +
            "the read log so a later write by the same run compiles this " +
            "document into its consumes edges (#233).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path as requested by the caller" },
        vault: {
          type: "string",
          description:
            "Which vault served the document: a federation mount alias, or " +
            '"local" for the canonical vault (#297)',
        },
        content: { type: "string", description: "Markdown body, frontmatter block stripped" },
        frontmatter: FRONTMATTER_SCHEMA,
        raw: {
          type: "object",
          description: "Frontmatter exactly as parsed from YAML, before coercion",
        },
        validation: VALIDATION_SCHEMA,
        hasFrontmatter: { type: "boolean" },
        decay: DECAY_SCHEMA,
        // Null when there is nothing to say — byte-identical to a document
        // with no compiled edges at all (no existence signal either way).
        upstream_staleness: {
          type: ["object", "null"],
          properties: {
            edges: {
              type: "array",
              items: UPSTREAM_EDGE_SCHEMA,
              description: "Only upstream units the caller can read (omission, #217)",
            },
            hidden_pending: {
              type: "string",
              enum: ["none", "some", "many"],
              description:
                "Coarse bucket over pending edges to units outside the caller's " +
                "read scope — never an exact count",
            },
            pending_broken: {
              type: "integer",
              minimum: 0,
              description: "Pending-broken count among the VISIBLE edges only",
            },
            banner: { type: ["string", "null"] },
          },
          required: ["edges", "hidden_pending", "pending_broken", "banner"],
        },
        // Null when healthy — same contract as `decay`.
        structural: {
          type: ["object", "null"],
          properties: {
            orphan: {
              type: "boolean",
              description: "No document the caller can read links here",
            },
            retired_still_linked: {
              type: ["object", "null"],
              properties: {
                canonical_linkers: { type: "array", items: { type: "string" } },
              },
              required: ["canonical_linkers"],
            },
            banner: { type: "string" },
          },
          required: ["orphan", "retired_still_linked", "banner"],
        },
        // Absent (both fields) when no visible unresolved tension touches the
        // document. `contested` is capped; `contestedCount` is the true total.
        contested: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Absent only for legacy entries" },
              kind: { type: "string", enum: [...TENSION_KINDS] },
              counterpart: {
                type: "string",
                description: "Canonical vault-relative path of the other side",
              },
              claimSelf: { type: "string" },
              claimOther: { type: "string" },
              loggedAt: { type: "string", description: "Entry date, YYYY-MM-DD" },
            },
            required: ["kind", "counterpart", "claimSelf", "claimOther", "loggedAt"],
          },
        },
        contestedCount: { type: "integer", minimum: 0 },
        // U-7: present only on a contested doc with no ratified org_position;
        // absent otherwise (same absent-key discipline as upstream_staleness).
        contested_positions: {
          type: "object",
          properties: {
            flag: { type: "string", enum: ["CONTESTED"] },
            positions: { type: "array", items: READ_POSITION_ITEM_SCHEMA },
            open_tension_ids: { type: "array", items: { type: "string" } },
            note: { type: "string" },
          },
          required: ["flag", "positions", "open_tension_ids", "note"],
        },
        // R-17: present only when org_position != null; mutually exclusive
        // with contested_positions by construction (LD-17).
        ratified_view: {
          type: "object",
          properties: {
            flag: { type: "string", enum: ["RATIFIED"] },
            stance: { type: "string", enum: [...STANCES] },
            confidence: { type: "string", enum: [...CONFIDENCES] },
            ratified_by: { type: "string" },
            ratified_at: { type: "string" },
            dissent: { type: "array", items: READ_POSITION_ITEM_SCHEMA },
            open_tension_ids: { type: "array", items: { type: "string" } },
            note: { type: "string" },
          },
          required: [
            "flag",
            "stance",
            "confidence",
            "ratified_by",
            "ratified_at",
            "dissent",
            "open_tension_ids",
            "note",
          ],
        },
        // U-11 (LD-23, DN-5): present only when >=1 VISIBLE compiled upstream
        // input is contested-unratified. Advisory only — never mutates the
        // consumer document on disk.
        contested_inputs: {
          type: "object",
          properties: {
            inputs: {
              type: "array",
              items: {
                type: "object",
                properties: { unit: { type: "string" } },
                required: ["unit"],
              },
            },
            effective_confidence: { type: "string", enum: ["low"] },
            banner: { type: "string" },
          },
          required: ["inputs", "effective_confidence", "banner"],
        },
        // JIT anchor pins (Decision 2). Null when there is nothing to say (no
        // pinned bindings, repo not configured, kill-switch off, or any error).
        // Null-when-silent: absent/null is indistinguishable (no existence leak).
        anchors: {
          type: ["object", "null"],
          properties: {
            entries: { type: "array", items: { type: "object" } },
            checked: { type: "integer", minimum: 0 },
            skipped: { type: "integer", minimum: 0 },
            banner: { type: ["string", "null"] },
            // R6: present only when ≥1 entry has `relocated` (intact-via-relocation).
            // Names the count and the ready-made vault_stage_action call to fix it.
            // Absent (not null, not empty-string) when no relocation was detected.
            repin_hint: { type: "string" },
          },
          required: ["entries", "checked", "skipped", "banner"],
        },
        version: { type: "string", description: "SHA-256 (hex) of the raw file bytes" },
      },
      required: [
        "path",
        "content",
        "frontmatter",
        "raw",
        "validation",
        "hasFrontmatter",
        "decay",
        "upstream_staleness",
        "structural",
        "version",
      ],
    },
    handler: (vaultRoot, args, access) => {
      const runId = readRunId(args, "vault_read");
      if (!runId.ok) return Promise.resolve(runId);
      return vaultRead(vaultRoot, String(args.path ?? ""), access, runId.value);
    },
  },
  {
    name: "vault_index",
    title: "List vault documents",
    annotations: { readOnlyHint: true },
    description:
      "List vault documents with their metadata, including each document's " +
      "questions_answered / questions_raised. Optionally filter by collection, " +
      "status, domain, tags (conjunctive), or has_unanswered.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Filter by collection name" },
        status: {
          type: "string",
          enum: [...STATUSES],
          description: "Filter by document status",
        },
        domain: {
          type: "string",
          enum: [...DOMAINS],
          description: "Filter by domain",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter to documents that have all of these tags",
        },
        has_unanswered: {
          type: "boolean",
          description:
            "true: only documents with open questions in questions_raised; " +
            "false: only documents with none",
        },
        // Named `mount`, not `vault`: the multi-vault router package reserves
        // a `vault` input property on every routed tool for its own dispatch.
        mount: {
          type: "string",
          description:
            "Federation mount alias to list instead of the local vault " +
            '(#297). Omit (or pass "local") for the canonical vault.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        count: {
          type: "integer",
          minimum: 0,
          description: "Number of entries returned (post-RBAC, post-filter)",
        },
        entries: { type: "array", items: INDEX_ENTRY_SCHEMA },
      },
      required: ["count", "entries"],
    },
    handler: (vaultRoot, args, access) => {
      const filters = {
        collection: asString(args.collection),
        status: asString(args.status),
        domain: asString(args.domain),
        tags: asStringArray(args.tags),
        hasUnanswered: typeof args.has_unanswered === "boolean" ? args.has_unanswered : undefined,
      };
      if (args.mount !== undefined && args.mount !== "local") {
        if (typeof args.mount !== "string") {
          return Promise.resolve(
            err(new Error("vault_index 'mount' must be a mount alias string")),
          );
        }
        const registry = getMountRegistry();
        const mount = registry?.mounts.get(args.mount);
        if (!mount) {
          return Promise.resolve(
            err(new Error(`vault_index 'mount' names unknown mount alias "${args.mount}"`)),
          );
        }
        return vaultIndexMount(mount, filters);
      }
      return vaultIndex(vaultRoot, filters, access);
    },
  },
  {
    name: "vault_status",
    title: "Vault health dashboard",
    annotations: { readOnlyHint: true },
    description:
      "Vault health dashboard: total file count, per-collection counts, " +
      "count of documents with invalid frontmatter, a staleness distribution " +
      "(fresh/aging/stale), unresolved tensions, and recent write history.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        vault: { type: "string", description: "Absolute path of the vault root" },
        fileCount: {
          type: "integer",
          minimum: 0,
          description: "Documents the caller can read",
        },
        collections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              collection: { type: "string" },
              count: { type: "integer", minimum: 0 },
            },
            required: ["collection", "count"],
          },
        },
        invalidCount: { type: "integer", minimum: 0 },
        generatedAt: { type: "string", description: "ISO 8601" },
        // fresh (< 0.5 of TTL elapsed), aging (>= 0.5, not expired), stale
        // (>= 1.0). `total` equals the role's visible file count.
        stalenessDistribution: {
          type: "object",
          properties: {
            fresh: { type: "integer", minimum: 0 },
            aging: { type: "integer", minimum: 0 },
            stale: { type: "integer", minimum: 0 },
            total: { type: "integer", minimum: 0 },
          },
          required: ["fresh", "aging", "stale", "total"],
        },
        unresolvedTensions: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 0 },
            recent: {
              type: "array",
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  date: { type: "string", description: "YYYY-MM-DD" },
                },
                required: ["title", "date"],
              },
            },
          },
          required: ["count", "recent"],
        },
        recentWrites: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 0 },
            entries: {
              type: "array",
              maxItems: 10,
              items: PROVENANCE_ENTRY_SCHEMA,
            },
          },
          required: ["count", "entries"],
        },
        embeddingDimMismatches: {
          type: "integer",
          minimum: 0,
          description:
            "Embedding cache rows for the active model whose stored dim does not " +
            "match the provider's; non-zero means those chunks are skipped in ranking",
        },
        // Present only when federation is configured (#297). Counts are the
        // readable subset under each mount's granted role, never unfiltered.
        federation: {
          type: "array",
          items: {
            type: "object",
            properties: {
              alias: { type: "string" },
              state: { type: "string", enum: ["ok", "unavailable"] },
              readableDocCount: { type: ["integer", "null"], minimum: 0 },
              lastRefresh: {
                type: ["string", "null"],
                description: "ISO 8601; null until the per-mount index ships",
              },
            },
            required: ["alias", "state", "readableDocCount", "lastRefresh"],
          },
        },
      },
      required: [
        "vault",
        "fileCount",
        "collections",
        "invalidCount",
        "generatedAt",
        "stalenessDistribution",
        "unresolvedTensions",
        "recentWrites",
        "embeddingDimMismatches",
      ],
    },
    handler: (vaultRoot, _args, access) => vaultStatus(vaultRoot, access),
  },
];
