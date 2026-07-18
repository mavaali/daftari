// Write-path tools: vault_write, vault_append, vault_promote, vault_deprecate.
//
// Every write follows the same shape: validate inputs, acquire a file-level
// lock, mutate the markdown file on disk, refresh the search index, auto-commit
// to git, append a provenance line, then release the lock. The lock is always
// released — even on failure — and handlers return Result, never throw.
//
// Git is the version-control layer: the auto-commit *is* the document history.
// The provenance log is a separate advisory audit trail.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import { acquireLock, openLockDb, releaseLock } from "../access/locks.js";
import { type AccessContext, canPromote, canWrite, isProposeOnly } from "../access/rbac.js";
import { mintConsumesEdges } from "../curation/consumes.js";
import { frontmatterDiff, recordProvenance } from "../curation/provenance.js";
import { recordShadowAction } from "../curation/shadow.js";
import { stageActionWithConflictCheck } from "../curation/staged-actions.js";
import { sourceReadable } from "../curation/tension-access.js";
import { EXTERNAL_REF } from "../curation/tier0.js";
import {
  buildPathIndexes,
  extractLinks,
  outgoingLinkTargets,
  resolveLink,
} from "../curation/vault-docs.js";
import { parseDocument } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../frontmatter/schema.js";
import {
  CONFIDENCES,
  DOMAINS,
  type ExtensionValue,
  err,
  type Frontmatter,
  ok,
  PROVENANCES,
  type Result,
  STATUSES,
  TIERS,
  type Tier,
  type ValidationIssue,
  type ValidationReport,
} from "../frontmatter/types.js";
import { loadHooks, loadPreWriteTransformHooks } from "../hooks/loader.js";
import { runPreWriteHooks, runPreWriteTransformHooks } from "../hooks/runner.js";
import type { HookOperation } from "../hooks/types.js";
import { getIndexStatus, indexingBusyMessage } from "../search/index-state.js";
import { indexDocument } from "../search/reindex.js";
import { noteSelfWrite } from "../search/self-write.js";
import { allDocumentPaths, getDocumentsByPaths } from "../storage/index-db.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import { loadConfig, type SchemaExtension } from "../utils/config.js";
import { commit } from "../utils/git.js";
import { sha256Hex } from "../utils/hash.js";
import { readRunId } from "../utils/run-id.js";
import type { ToolDefinition } from "./read.js";
import { openIndexForAccessOrNull } from "./search.js";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Refuses writes while the index is being (re)built. The write path ends in
// indexDocument(), which races with a concurrent reindexVault() — the reindex
// clears the index and re-inserts every document, so a write that lands in
// between can be wiped or land against a half-built index. Failing fast keeps
// hooks, locks, and git commits from running for a write we can't index yet.
function requireIndexReady(): Result<void, Error> {
  const status = getIndexStatus();
  if (status.status === "indexing") {
    return err(new Error(indexingBusyMessage(status)));
  }
  if (status.status === "error") {
    return err(new Error(`vault index is in error state: ${status.error ?? "unknown"}`));
  }
  return ok(undefined);
}

// A document's RBAC collection: its frontmatter `collection`, falling back to
// the top-level directory of its vault-relative path.
function collectionOf(relPath: string, fm: Frontmatter): string {
  return fm.collection || (relPath.split("/")[0] ?? "");
}

// The collection the write gate for a *new* write must key off: the top-level
// directory the bytes physically land in, i.e. the resolved target path's first
// path segment — NEVER the caller-declared frontmatter.collection. Honoring the
// declared string let a role with write on collection A drop a file into
// collection B by lying in the frontmatter (S1, 2026-07-01 review): the gate
// checked A while `resolveVaultPath` wrote into B.
//
// `relPath` is lexically canonicalized against the vault root so an aliased path
// (`competitive-intel/../pricing/x.md`) resolves to its true top-level dir
// before the gate. This is pure path math — no disk I/O — so the check still
// runs before we touch the target, preserving "deny before revealing anything".
// A path that escapes the root yields a `..`-leading segment, which no role can
// write; `resolveVaultPath` rejects it properly downstream.
function targetCollection(vaultRoot: string, relPath: string): string {
  const rel = relative(resolve(vaultRoot), resolve(vaultRoot, relPath));
  return rel.split(sep)[0] ?? "";
}

// Resolves an extension field's serializable value from the raw frontmatter:
// the value as written, with a js-yaml Date normalized to a YYYY-MM-DD string.
// A missing field — `undefined` or `null`, the latter matching how the
// validator reads it — yields undefined so the caller can omit the key.
// Defaults are not applied here; see applyExtensionDefaults.
function extensionValue(
  raw: Record<string, unknown>,
  ext: SchemaExtension,
): ExtensionValue | undefined {
  const v = raw[ext.field];
  if (v === undefined || v === null) return undefined;
  if (ext.type === "date" && v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  return v as ExtensionValue;
}

// Fills missing extension fields from their declared defaults, returning a new
// record. Used only on the vault_write path — a full-frontmatter write. The
// append / promote / deprecate tools mutate an existing document and must not
// inject new fields, so they serialize the document's raw frontmatter as-is.
export function applyExtensionDefaults(
  raw: Record<string, unknown>,
  extensions: SchemaExtension[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const ext of extensions) {
    const v = out[ext.field];
    if ((v === undefined || v === null) && ext.default !== undefined) {
      out[ext.field] = ext.default;
    }
  }
  return out;
}

// Serializes a frontmatter block and markdown body back into file text.
// Built-in fields are written first in schema order, then config-declared
// extension fields in declaration order, so a round-tripped document has
// stable, predictable frontmatter regardless of the input object's key order.
export function serializeDocument(
  fm: Frontmatter,
  body: string,
  extensions: SchemaExtension[] = [],
  raw: Record<string, unknown> = {},
): string {
  const ordered: Record<string, unknown> = {
    title: fm.title,
    domain: fm.domain,
    collection: fm.collection,
    status: fm.status,
    confidence: fm.confidence,
    created: fm.created,
    updated: fm.updated,
    updated_by: fm.updated_by,
    provenance: fm.provenance,
    // `?? null` — a hand-built Frontmatter that predates tier may carry
    // undefined here, which js-yaml refuses to dump (null it serializes fine,
    // matching the superseded_by convention).
    tier: fm.tier ?? null,
    sources: fm.sources,
    superseded_by: fm.superseded_by,
    ttl_days: fm.ttl_days,
    tags: fm.tags,
    describes: fm.describes,
    questions_answered: fm.questions_answered,
    questions_raised: fm.questions_raised,
  };
  const handled = new Set<string>(Object.keys(ordered));
  for (const ext of extensions) {
    handled.add(ext.field);
    const value = extensionValue(raw, ext);
    if (value !== undefined) ordered[ext.field] = value;
  }
  // Preserve any remaining frontmatter the document already carries — fields
  // that are neither built-in nor a declared extension. They are written last,
  // in their raw insertion order, untyped. This keeps every serialize path
  // non-destructive: a tool-mediated write never silently drops a field the
  // author put there (#113). A null value is treated as absent (the same
  // convention declared extensions follow) and the key is omitted.
  for (const [key, value] of Object.entries(raw)) {
    if (handled.has(key)) continue;
    if (value === undefined || value === null) continue;
    // A js-yaml-parsed unquoted date arrives as a Date; serialize it date-only
    // (Daftari's YYYY-MM-DD convention) rather than letting js-yaml emit a full
    // ISO datetime — otherwise a custom field like `published: 2026-06-15` is
    // silently rewritten to `2026-06-15T00:00:00.000Z`. Mirrors extensionValue's
    // Date handling for declared fields.
    ordered[key] =
      value instanceof Date && !Number.isNaN(value.getTime())
        ? value.toISOString().slice(0, 10)
        : value;
  }
  return matter.stringify(body.startsWith("\n") ? body : `\n${body}`, ordered);
}

export interface WriteResult {
  path: string;
  action:
    | "create"
    | "update"
    | "append"
    | "promote"
    | "deprecate"
    | "supersede"
    | "merge"
    | "confidence-set"
    | "tier-set"
    | "staged";
  // Short commit hash when the write was auto-committed; null when the vault
  // is configured with `auto_commit: false` and the caller owns git.
  commit: string | null;
  committed: boolean;
  status: string;
  updated: string;
  validation: ValidationReport;
  indexUpdated: boolean;
  // True when the vault runs shadow_mode (spec §11.5): the write was computed
  // and logged to .daftari/shadow-actions.jsonl but NOTHING was written —
  // no file, no commit, no index update, no provenance entry.
  shadow?: boolean;
  // Advisory nudge (#169), vault_write overwrites only: replacing a document
  // in place destroys the prior version's lineage; when the write records a
  // changed fact, vault_supersede preserves the old doc and mints the
  // superseded_by edge instead. Purely additive — the write has already
  // landed, nothing blocks, no edge is auto-created.
  supersede_hint?: string;
  // #4: advisory epistemic-boundary warnings — this accumulation-domain
  // write references generative-domain docs (via `sources` or body links).
  // Speculative sketches must not read as settled canon. The write has
  // landed; nothing blocks, nothing is auto-fixed. The typed-channel half
  // (`sources`) is also a tier-0 lint finding (domainLeaks).
  domain_warnings?: string[];
  // Set when a propose-only role's vault_write was coerced into a staged
  // `write` proposal (#235): the staged action's id/expiry, plus any pending
  // proposals already contesting the same target and the inter-proposal
  // tension logged for them. action is "staged" and nothing was written.
  // tension_error is present when the conflict tension could not be written
  // (the proposal still staged; conflicts_with still names the contenders).
  staged_id?: string;
  expires_at?: string;
  conflicts_with?: string[];
  tension_id?: string | null;
  tension_error?: string;
}

// First 12 chars of a 64-char SHA-256, for human-readable provenance reasons.
// Anything that is not a full SHA-256 is returned unchanged.
function shortHash(h: string): string {
  return h.length === 64 ? h.slice(0, 12) : h;
}

// Runs the durable part of a write under an exclusive file lock: write the
// file, refresh the index, commit, log provenance. The lock is released in a
// finally block so a failure mid-write never wedges the file.
//
// Commit failure is fatal (the write is not durably recorded). Index and
// provenance failures are not — the index is a rebuildable cache and the log
// is advisory — so they are reported via `indexUpdated` rather than aborting.
//
// When `autoCommit` is false the commit step is skipped entirely: the file is
// still written, indexed, and provenance-logged, but `commit` is null and
// `committed` is false. The caller owns staging and committing.
//
// Optimistic concurrency: when `baseVersion` is supplied, the file on disk is
// hashed inside the lock and compared before any write. A mismatch (including
// a file that no longer exists, or never did) rejects the write as stale —
// nothing is written, committed, or indexed, and a "rejected_stale" provenance
// entry is logged. When `baseVersion` is omitted the check is skipped entirely
// and last-write-wins behavior is preserved.
async function performWrite(params: {
  vaultRoot: string;
  relPath: string;
  absPath: string;
  agent: string;
  tool: string;
  action: WriteResult["action"];
  fileText: string;
  newFrontmatter: Frontmatter;
  oldFrontmatter: Frontmatter | null;
  validation: ValidationReport;
  commitMessage: string;
  autoCommit: boolean;
  gitDir?: string;
  baseVersion?: string;
  shadowMode?: boolean;
  // The authenticated identity the server runs as (access.user), when an
  // AccessContext is present (§11.6). Recorded on provenance and shadow
  // entries as ground truth alongside the caller-claimed `agent`.
  principal?: string;
  // Caller-supplied trace/run identifier (#235), recorded on provenance
  // entries so one run's writes correlate (the #233 producer keys on this).
  runId?: string;
  // Whether this write changed the markdown body (#232 Tier 1). Each caller
  // knows its own semantics: content writes compute it, frontmatter-only
  // lifecycle tools pass false.
  bodyChanged?: boolean;
}): Promise<Result<WriteResult, Error>> {
  // Shadow mode (spec §11.5): everything up to here ran exactly as live —
  // validation, RBAC, frontmatter assembly, diff — so the logged do() is one
  // that WOULD have executed. Log it with its impact/budget verdict and stop:
  // no lock, no file, no commit, no index, no provenance. base_version is
  // intentionally not checked — stale-write rejection guards a mutation, and
  // there is none.
  if (params.shadowMode) {
    const recorded = await recordShadowAction(params.vaultRoot, {
      tool: params.tool,
      action: params.action,
      targetPath: params.relPath,
      agent: params.agent,
      ...(params.principal ? { principal: params.principal } : {}),
      frontmatterDiff: frontmatterDiff(params.oldFrontmatter, params.newFrontmatter),
      commitMessage: params.commitMessage,
    });
    if (!recorded.ok) return recorded;
    return ok({
      path: params.relPath,
      action: params.action,
      commit: null,
      committed: false,
      status: params.newFrontmatter.status,
      updated: params.newFrontmatter.updated,
      validation: params.validation,
      indexUpdated: false,
      shadow: true,
    });
  }

  const lockDbResult = openLockDb(params.vaultRoot);
  if (!lockDbResult.ok) return lockDbResult;
  const lockDb = lockDbResult.value;

  try {
    const lock = acquireLock(lockDb, params.relPath, params.agent);
    if (!lock.ok) return lock;

    try {
      // Stale-write check, atomic with respect to other lock-holders. An
      // empty-string baseVersion is falsy here, so it is treated as "omitted".
      if (params.baseVersion) {
        const onDisk = await readFile(params.absPath);
        const currentHash = onDisk.ok ? sha256Hex(onDisk.value) : null;
        if (currentHash !== params.baseVersion) {
          await recordProvenance(params.vaultRoot, {
            tool: params.tool,
            file: params.relPath,
            agent: params.agent,
            ...(params.principal ? { principal: params.principal } : {}),
            ...(params.runId ? { run_id: params.runId } : {}),
            action: "rejected_stale",
            reason:
              `stale: base_version ${shortHash(params.baseVersion)} != ` +
              `current ${currentHash ? shortHash(currentHash) : "<absent>"}`,
          });
          return err(new Error(`stale write: ${params.relPath} changed since base_version`));
        }
      }

      await mkdir(dirname(params.absPath), { recursive: true });
      await writeFile(params.absPath, params.fileText, "utf-8");

      const indexed = await indexDocument(params.vaultRoot, params.relPath);
      // Tell the fs.watch reactive indexer (search/watcher.ts) that this
      // path was just written by Daftari itself, so the chokidar `add` /
      // `change` event the writeFile above will trigger is dropped instead
      // of queuing a redundant indexDocument() call. The TTL is short
      // (~1s), so a *real* external edit that lands a moment later is at
      // worst skipped once and picked up by the next edit — last-writer
      // wins, like every other path here.
      noteSelfWrite(params.absPath);

      let commitHash: string | null = null;
      if (params.autoCommit) {
        const committed = await commit(
          params.vaultRoot,
          [params.relPath],
          params.commitMessage,
          params.agent,
          { gitDir: params.gitDir },
        );
        if (!committed.ok) return committed;
        commitHash = committed.value.hash;
      }

      await recordProvenance(params.vaultRoot, {
        tool: params.tool,
        file: params.relPath,
        agent: params.agent,
        ...(params.principal ? { principal: params.principal } : {}),
        ...(params.runId ? { run_id: params.runId } : {}),
        ...(params.bodyChanged !== undefined ? { body_changed: params.bodyChanged } : {}),
        action: params.action,
        frontmatter_diff: frontmatterDiff(params.oldFrontmatter, params.newFrontmatter),
      });

      // #233: a run-correlated write compiles its input set — every path the
      // run read beforehand becomes a consumes edge. Best-effort like the
      // provenance/index steps: the write is already durable, and the graph
      // is advisory substrate, so a mint failure never fails the write.
      if (params.runId) {
        await mintConsumesEdges(params.vaultRoot, {
          artifact: params.relPath,
          runId: params.runId,
        });
      }

      return ok({
        path: params.relPath,
        action: params.action,
        commit: commitHash,
        committed: params.autoCommit,
        status: params.newFrontmatter.status,
        updated: params.newFrontmatter.updated,
        validation: params.validation,
        indexUpdated: indexed.ok,
      });
    } finally {
      releaseLock(lockDb, params.relPath, params.agent);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`write failed: ${reason}`));
  } finally {
    lockDb.close();
  }
}

function requireString(
  args: Record<string, unknown>,
  field: string,
  tool: string,
): Result<string, Error> {
  const v = args[field];
  if (typeof v !== "string" || v.trim().length === 0) {
    return err(new Error(`${tool} requires a non-empty '${field}' argument`));
  }
  return ok(v);
}

// Reads the optional `base_version` optimistic-concurrency token. Absent, null,
// or an empty string all resolve to `undefined` ("not provided") — an empty
// string is treated as omitted, defensive against clients sending a blank. A
// non-string value is a hard error.
function readBaseVersion(
  args: Record<string, unknown>,
  tool: string,
): Result<string | undefined, Error> {
  const v = args.base_version;
  if (v === undefined || v === null) return ok(undefined);
  if (typeof v !== "string") {
    return err(new Error(`${tool}: 'base_version' must be a string`));
  }
  return ok(v.length === 0 ? undefined : v);
}

// #235: a propose-only role cannot mutate the vault directly. vault_write
// coerces into a staged proposal (see vaultWrite); every OTHER write tool is
// denied with a pointer to the staging surface. Structural enforcement — the
// permission layer decides, not convention.
function denyIfProposeOnly(access: AccessContext | undefined, tool: string): Result<void, Error> {
  if (access && isProposeOnly(access.role)) {
    return err(
      new Error(
        `${tool}: role '${access.roleName}' is propose-only — direct writes are ` +
          `disabled. Propose the change instead: vault_write stages a 'write' ` +
          `proposal, and vault_stage_action stages lifecycle actions ` +
          `(promote, deprecate, supersede, merge, confidence-up) for ratification.`,
      ),
    );
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// vault_write
// ---------------------------------------------------------------------------

// Creates a new document or overwrites an existing one. The caller supplies
// the full frontmatter; `updated` and `updated_by` are always stamped by the
// server, and `created` is preserved from the existing document on an update.
// --- tier write-protection (#141) ------------------------------------------
//
// `tier: source` bodies are immutable to EVERY writer; `tier: manual` bodies
// only accept rewrites from a human:* identity. The escape hatch is
// deliberately NOT an inline force flag — a refusal that names a bypass
// parameter teaches the calling model to pass it reflexively. Instead the
// caller must demote the tier first (vault_set_tier, reason required, change
// provenance-logged), then write. Frontmatter-only writes pass unchanged, so
// curation tools (promote, deprecate, supersede, set_confidence) and tag
// edits keep working on tiered docs.

// Body equality up to a leading-newline / trailing-whitespace difference:
// gray-matter's parsed content starts with the newline after the frontmatter
// fence and serializeDocument re-adds one, so a byte comparison would flag
// every round-tripped body as changed.
function sameBody(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^\n+/, "").replace(/\s+$/, "");
  return norm(a) === norm(b);
}

function checkTierGuard(args: {
  tool: string;
  path: string;
  tier: Tier | null;
  oldBody: string;
  newBody: string;
  agent: string;
}): Result<void, Error> {
  const { tool, path, tier, oldBody, newBody, agent } = args;
  if (tier !== "source" && tier !== "manual") return ok(undefined);
  if (sameBody(oldBody, newBody)) return ok(undefined);
  if (tier === "source") {
    return err(
      new Error(
        `${tool}: ${path} is tier 'source' — its body is immutable. If this ` +
          `rewrite is deliberate, demote the tier first with vault_set_tier ` +
          `(a reason is required and the change is logged), then write. ` +
          `vault_append can add to it without a tier change.`,
      ),
    );
  }
  if (!agent.startsWith("human:")) {
    return err(
      new Error(
        `${tool}: ${path} is tier 'manual' — body rewrites require a ` +
          `human:* identity (got '${agent}'). vault_append can add to it.`,
      ),
    );
  }
  return ok(undefined);
}

// #4: the generative-domain documents an accumulation-domain doc references
// (typed `sources` entries plus body links), resolved against the indexed
// path universe. Advisory only — callers attach the result as
// domain_warnings; index unavailability degrades to silence.
function generativeDomainRefs(
  vaultRoot: string,
  doc: { domain: string; sources: string[]; body: string; relPath: string },
  access?: AccessContext,
): string[] | null {
  if (doc.domain !== "accumulation") return null;
  // Most accumulation writes reference nothing; skip the index entirely
  // rather than loading every vault path to resolve an empty candidate set.
  const localSources = doc.sources.filter((s) => !EXTERNAL_REF.test(s));
  if (localSources.length === 0 && extractLinks(doc.body).length === 0) return null;
  const db = openIndexForAccessOrNull(vaultRoot);
  if (!db) return null;
  try {
    const indexes = buildPathIndexes(allDocumentPaths(db).map((p) => ({ path: p })));
    const candidates = new Set<string>(outgoingLinkTargets(doc.body, doc.relPath, indexes));
    for (const raw of localSources) {
      const target = resolveLink(raw, doc.relPath, indexes.byPath, indexes.byBasename);
      if (target && target !== doc.relPath) candidates.add(target);
    }
    if (candidates.size === 0) return null;
    const generative = getDocumentsByPaths(db, [...candidates])
      .filter((d) => d.domain === "generative")
      .map((d) => d.path)
      // Vantage rule (#217, security review on #261): a warning names the
      // RESOLVED path and discloses the target's domain — metadata about a
      // doc the caller may not read, and resolveLink's basename fallback can
      // reveal a location the caller never typed. Targets outside the
      // caller's read scope are omitted entirely, the same rule lint's
      // domainLeaks inherits from runLint's pre-filtered doc set.
      .filter((p) => !access || sourceReadable(db, access, p))
      .sort();
    if (generative.length === 0) return null;
    return generative.map(
      (p) => `${p} is generative-domain — speculative material referenced from accumulation canon`,
    );
  } catch {
    // This runs after performWrite returned ok — the write is durable. A
    // query failure here (index rebuilt mid-query, locked db) must degrade
    // to "no warnings", never surface as a failed write to the caller.
    return null;
  } finally {
    db.close();
  }
}

// The #169 nudge, verbatim on every vault_write overwrite. One fixed string:
// the signal is the field's presence, and a stable text is grep-able in
// agent traces.
const SUPERSEDE_HINT =
  "This write replaced an existing document in place. If it records a changed " +
  "fact, prefer vault_supersede: it preserves the prior version and mints the " +
  "superseded_by edge instead of erasing lineage. Advisory only — this write " +
  "has already landed.";

export async function vaultWrite(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<WriteResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const path = requireString(args, "path", "vault_write");
  if (!path.ok) return path;
  const agent = requireString(args, "agent", "vault_write");
  if (!agent.ok) return agent;
  const baseVersion = readBaseVersion(args, "vault_write");
  if (!baseVersion.ok) return baseVersion;
  const runId = readRunId(args, "vault_write");
  if (!runId.ok) return runId;
  const body = args.body;
  if (typeof body !== "string") {
    return err(new Error("vault_write requires a string 'body' argument"));
  }
  if (args.frontmatter === null || typeof args.frontmatter !== "object") {
    return err(new Error("vault_write requires a 'frontmatter' object argument"));
  }
  const rawFrontmatter = args.frontmatter as Record<string, unknown>;

  // RBAC is checked before any file I/O or frontmatter validation: an
  // unauthorized caller is denied without learning anything about the target.
  // The gate keys off the directory the bytes physically land in (the resolved
  // target path's top-level dir), NOT the caller-declared frontmatter.collection
  // — otherwise a role with write on collection A could write into collection B
  // by declaring `collection: A` while pointing `path` at B (S1). The declared
  // collection is allowed to differ from the physical dir (e.g. a draft staged
  // in _drafts/ that declares its destination collection); it just never widens
  // access.
  if (access) {
    const collection = targetCollection(vaultRoot, path.value);
    if (!canWrite(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot write to ` +
            `collection '${collection}'`,
        ),
      );
    }
  }

  const resolved = resolveVaultPath(vaultRoot, path.value);
  if (!resolved.ok) return resolved;

  // #235: a propose-only role's write lands as a staged `write` proposal, not
  // a mutation. Coerced EARLY — before file I/O, tier guards, hooks, or
  // validation — because all of that runs for real at ratify time when
  // vault_ratify dispatches the payload back through this tool with the
  // ratifier's access. The write grant above still scopes which collections
  // the role may propose into. Inter-proposal conflicts are checked the same
  // way vault_stage_action checks them: both proposals stay pending, a
  // tension is logged, the result names the contenders. Staged under the
  // CANONICAL relPath, matching vault_stage_action — a raw caller spelling
  // (`pricing/./x.md`) would dodge the exact-string conflict match and the
  // ratify gate's existing-doc lookup (#127/#128 rule).
  if (access && isProposeOnly(access.role)) {
    // The validation report is REAL, not fabricated: run the payload through
    // the same merge-then-validate the eventual dispatch will apply (merged
    // under any existing frontmatter, server-stamped fields defaulted), so a
    // propose-only agent gets its schema feedback NOW instead of at ratify
    // time up to ttl_days later. Advisory here — staging proceeds regardless;
    // the blocking check runs for real when vault_ratify dispatches.
    const proposeConfig = loadConfig(vaultRoot);
    if (!proposeConfig.ok) return proposeConfig;
    let previewRaw: Record<string, unknown> = { ...rawFrontmatter };
    const onDisk = await readFile(resolved.value.absPath);
    if (onDisk.ok) {
      const parsedExisting = parseDocument(onDisk.value);
      if (parsedExisting.ok) {
        const merged: Record<string, unknown> = { ...parsedExisting.value.raw };
        for (const [key, value] of Object.entries(rawFrontmatter)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        previewRaw = merged;
      }
    }
    if (previewRaw.updated === undefined || previewRaw.updated === null) {
      previewRaw.updated = todayISO();
    }
    if (previewRaw.updated_by === undefined || previewRaw.updated_by === null) {
      previewRaw.updated_by = agent.value;
    }
    const preview = validateFrontmatter(previewRaw, proposeConfig.value.schemaExtensions);

    const staged = await stageActionWithConflictCheck(vaultRoot, {
      actionType: "write",
      targetPath: resolved.value.relPath,
      proposedBy: agent.value,
      rationale:
        typeof args.reason === "string" && args.reason.trim().length > 0
          ? args.reason.trim()
          : `propose-only role '${access.roleName}': write staged for ratification`,
      proposedDiff: { frontmatter: rawFrontmatter, body },
      ...(runId.value !== undefined ? { runId: runId.value } : {}),
    });
    if (!staged.ok) return staged;
    return ok({
      path: resolved.value.relPath,
      action: "staged",
      commit: null,
      committed: false,
      status: "pending",
      updated: todayISO(),
      validation: preview.report,
      indexUpdated: false,
      staged_id: staged.value.id,
      expires_at: staged.value.expires_at,
      conflicts_with: staged.value.conflicts_with,
      tension_id: staged.value.tension_id,
      ...(staged.value.tension_error ? { tension_error: staged.value.tension_error } : {}),
    });
  }

  const existing = await readFile(resolved.value.absPath);
  let oldFrontmatter: Frontmatter | null = null;
  let oldRaw: Record<string, unknown> | null = null;
  let oldContent = "";
  if (existing.ok) {
    const parsed = parseDocument(existing.value);
    if (!parsed.ok) {
      // The file exists but its frontmatter does not parse. Treating this as a
      // create would silently overwrite — and discard — whatever the document
      // already holds, the exact field-loss class #113 is about. Refuse loudly
      // instead: the caller must repair or remove the file before a write can
      // proceed.
      return err(
        new Error(
          `vault_write: ${path.value} exists but its frontmatter could not be ` +
            `parsed (${parsed.error.message}); refusing to overwrite it. ` +
            `Fix or remove the file first.`,
        ),
      );
    }
    oldFrontmatter = parsed.value.frontmatter;
    oldRaw = parsed.value.raw;
    oldContent = parsed.value.content;
  }
  const isUpdate = oldFrontmatter !== null;
  const hookOperation: HookOperation = isUpdate ? "update" : "create";

  if (isUpdate && oldFrontmatter) {
    const guard = checkTierGuard({
      tool: "vault_write",
      path: path.value,
      tier: oldFrontmatter.tier,
      oldBody: oldContent,
      newBody: body,
      agent: agent.value,
    });
    if (!guard.ok) return guard;
  }

  // On update, merge the document's existing frontmatter under the payload, so
  // a tool-mediated write never silently drops a field the author put there
  // (#113). `oldRaw` is the frontmatter exactly as parsed — built-in fields,
  // declared schema extensions, and undeclared custom keys alike (unlike
  // `oldFrontmatter`, which the validator coerces down to the built-in set).
  // Every existing key is preserved; a key the payload supplies wins; an
  // explicit null in the payload removes the key (opt-in deletion). The merged
  // object is written back into `rawFrontmatter` in place, so transform hooks,
  // validation, and serialization all operate on it. The create path is
  // unchanged — there is no existing frontmatter to preserve.
  if (isUpdate && oldRaw !== null) {
    const merged: Record<string, unknown> = { ...oldRaw };
    for (const [key, value] of Object.entries(rawFrontmatter)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    for (const key of Object.keys(rawFrontmatter)) delete rawFrontmatter[key];
    Object.assign(rawFrontmatter, merged);
  }

  // #141: a protected doc's tier only changes via vault_set_tier. Allowing it
  // here would let a frontmatter-only write (which sameBody waves through)
  // demote the tier — dodging set_tier's reason requirement and manual's
  // human gate — and then rewrite the body in a second call.
  if (
    isUpdate &&
    oldFrontmatter &&
    (oldFrontmatter.tier === "source" || oldFrontmatter.tier === "manual")
  ) {
    if (rawFrontmatter.tier !== oldFrontmatter.tier) {
      return err(
        new Error(
          `vault_write: ${path.value} is tier '${oldFrontmatter.tier}' — changing ` +
            `its tier requires vault_set_tier (a reason is required` +
            `${oldFrontmatter.tier === "manual" ? ", and a human:* identity" : ""}).`,
        ),
      );
    }
  }

  // Config-declared schema extensions participate in validation and
  // serialization. A malformed config fails the write loudly, matching the
  // server's loud-config contract.
  const config = loadConfig(vaultRoot);
  if (!config.ok) return config;
  const extensions = config.value.schemaExtensions;

  // Pre-write transform hooks run BEFORE schema validation, so they can
  // derive or override built-in frontmatter fields the validator would
  // otherwise reject. Each returns a Partial<Frontmatter>; the runner merges
  // them Object.assign-style (shallow, last-writer-wins) and the result is
  // merged back into rawFrontmatter so validation, hooks, and serialization
  // all see the transformed values. A transform throw or non-object return
  // becomes a synthetic blocking issue. The loader fails loud, same as the
  // pre_write loader.
  const loadedTransformHooks = await loadPreWriteTransformHooks(
    vaultRoot,
    config.value.hooks.preWriteTransform,
  );
  if (!loadedTransformHooks.ok) return loadedTransformHooks;
  const transformResult = runPreWriteTransformHooks(loadedTransformHooks.value, rawFrontmatter, {
    path: path.value,
    operation: hookOperation,
  });
  Object.assign(rawFrontmatter, transformResult.merged);

  // `updated` and `updated_by` are server-managed: performWrite re-stamps them
  // unconditionally after validation. Fill them in here too, so a caller who
  // (reasonably) omits them does not trip validateFrontmatter's required-field
  // checks. Anything the caller supplied — or a transform hook produced — is
  // left alone; the post-validation stamp still wins, so behavior is unchanged
  // for callers that do supply these fields.
  if (rawFrontmatter.updated === undefined || rawFrontmatter.updated === null) {
    rawFrontmatter.updated = todayISO();
  }
  if (rawFrontmatter.updated_by === undefined || rawFrontmatter.updated_by === null) {
    rawFrontmatter.updated_by = agent.value;
  }

  const { frontmatter, report } = validateFrontmatter(rawFrontmatter, extensions);

  // Pre-write hooks run after built-in schema validation has filled
  // defaults. Their issues merge into the report and are treated the same
  // way built-in issues are: any issue blocks the write. The hook loader
  // fails loud — a missing or malformed hook module is a config error.
  const loadedHooks = await loadHooks(vaultRoot, config.value.hooks.preWrite);
  if (!loadedHooks.ok) return loadedHooks;
  const hookIssues = runPreWriteHooks(loadedHooks.value, rawFrontmatter, {
    path: path.value,
    operation: hookOperation,
  });
  const mergedIssues: ValidationIssue[] = [
    ...transformResult.issues,
    ...report.issues,
    ...hookIssues,
  ];
  const mergedReport: ValidationReport = {
    valid: mergedIssues.length === 0,
    issues: mergedIssues,
  };
  if (!mergedReport.valid) {
    const summary = mergedReport.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    return err(new Error(`invalid frontmatter: ${summary}`));
  }

  const stamped: Frontmatter = {
    ...frontmatter,
    created: isUpdate ? (oldFrontmatter as Frontmatter).created : frontmatter.created,
    updated: todayISO(),
    updated_by: agent.value,
  };

  const written = await performWrite({
    vaultRoot,
    // Lock key, provenance, and commit path are all keyed on the CANONICAL
    // relPath (resolved.value.relPath), never the raw caller string: aliased
    // spellings of one file must contend on one lock (#127/#128).
    relPath: resolved.value.relPath,
    absPath: resolved.value.absPath,
    agent: agent.value,
    tool: "vault_write",
    action: isUpdate ? "update" : "create",
    fileText: serializeDocument(
      stamped,
      body,
      extensions,
      applyExtensionDefaults(rawFrontmatter, extensions),
    ),
    newFrontmatter: stamped,
    oldFrontmatter,
    validation: mergedReport,
    commitMessage:
      `vault_write: ${isUpdate ? "update" : "create"} ${path.value} ` + `by ${agent.value}`,
    autoCommit: config.value.autoCommit,
    gitDir: config.value.gitDir,
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
    ...(runId.value !== undefined ? { runId: runId.value } : {}),
    bodyChanged: !isUpdate || !sameBody(oldContent, body),
  });
  // #169: an in-place overwrite destroys the prior version's lineage, and
  // daftari HAS the preserve-not-overwrite primitive — steer toward it at
  // the moment of overwrite, the decay banner's channel: additive, advisory,
  // never blocking, never auto-minting an edge. The agent still chooses.
  // Attached here (not in performWrite) so vault_supersede and the other
  // lifecycle tools never nudge about themselves. A shadow-mode result is
  // excluded: nothing landed and nothing was replaced, so the hints' text
  // would be false. #4's domain warnings ride the same channel.
  if (!written.ok || written.value.shadow) return written;
  const warnings = generativeDomainRefs(
    vaultRoot,
    {
      domain: stamped.domain,
      sources: stamped.sources ?? [],
      body,
      relPath: resolved.value.relPath,
    },
    access,
  );
  if (!isUpdate && warnings === null) return written;
  return ok({
    ...written.value,
    ...(isUpdate ? { supersede_hint: SUPERSEDE_HINT } : {}),
    ...(warnings ? { domain_warnings: warnings } : {}),
  });
}

// ---------------------------------------------------------------------------
// vault_append
// ---------------------------------------------------------------------------

// Appends a markdown section to an existing document's body, leaving the
// frontmatter intact apart from the stamped `updated` / `updated_by` fields.
export async function vaultAppend(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<WriteResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const path = requireString(args, "path", "vault_append");
  if (!path.ok) return path;
  const agent = requireString(args, "agent", "vault_append");
  if (!agent.ok) return agent;
  const section = requireString(args, "section", "vault_append");
  if (!section.ok) return section;
  const baseVersion = readBaseVersion(args, "vault_append");
  if (!baseVersion.ok) return baseVersion;
  const runId = readRunId(args, "vault_append");
  if (!runId.ok) return runId;
  const proposeGate = denyIfProposeOnly(access, "vault_append");
  if (!proposeGate.ok) return proposeGate;

  const resolved = resolveVaultPath(vaultRoot, path.value);
  if (!resolved.ok) return resolved;

  const existing = await readFile(resolved.value.absPath);
  if (!existing.ok) {
    return err(new Error(`vault_append: document not found: ${path.value}`));
  }
  const parsed = parseDocument(existing.value);
  if (!parsed.ok) return parsed;

  const config = loadConfig(vaultRoot);
  if (!config.ok) return config;
  const extensions = config.value.schemaExtensions;

  const oldFrontmatter = parsed.value.frontmatter;
  if (access) {
    const collection = collectionOf(path.value, oldFrontmatter);
    if (!canWrite(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot write to ` +
            `collection '${collection}'`,
        ),
      );
    }
  }
  const newFrontmatter: Frontmatter = {
    ...oldFrontmatter,
    updated: todayISO(),
    updated_by: agent.value,
  };
  const newBody = `${parsed.value.content.replace(/\s+$/, "")}\n\n${section.value.trim()}\n`;

  // Pre-write transform hooks run before the pre_write validators; their
  // Partial<Frontmatter> patch is merged Object.assign-style into the
  // post-stamp frontmatter so the validators below see the transformed
  // values. A transform throw or non-object return blocks the append.
  const loadedTransformHooks = await loadPreWriteTransformHooks(
    vaultRoot,
    config.value.hooks.preWriteTransform,
  );
  if (!loadedTransformHooks.ok) return loadedTransformHooks;
  const transformResult = runPreWriteTransformHooks(
    loadedTransformHooks.value,
    newFrontmatter as unknown as Record<string, unknown>,
    { path: path.value, operation: "append" },
  );
  Object.assign(newFrontmatter, transformResult.merged);

  // Pre-write hooks see the post-stamp, post-transform frontmatter (the same
  // shape a subsequent vault_read would return). Issues block the append,
  // same as for vault_write.
  const loadedHooks = await loadHooks(vaultRoot, config.value.hooks.preWrite);
  if (!loadedHooks.ok) return loadedHooks;
  const hookIssues = runPreWriteHooks(
    loadedHooks.value,
    newFrontmatter as unknown as Record<string, unknown>,
    { path: path.value, operation: "append" },
  );
  const appendIssues = [...transformResult.issues, ...hookIssues];
  if (appendIssues.length > 0) {
    const summary = appendIssues.map((i) => `${i.field}: ${i.message}`).join("; ");
    return err(new Error(`invalid frontmatter: ${summary}`));
  }

  const appended = await performWrite({
    vaultRoot,
    // Lock key, provenance, and commit path are all keyed on the CANONICAL
    // relPath (resolved.value.relPath), never the raw caller string: aliased
    // spellings of one file must contend on one lock (#127/#128).
    relPath: resolved.value.relPath,
    absPath: resolved.value.absPath,
    agent: agent.value,
    tool: "vault_append",
    action: "append",
    fileText: serializeDocument(newFrontmatter, newBody, extensions, parsed.value.raw),
    newFrontmatter,
    oldFrontmatter,
    validation: parsed.value.validation,
    commitMessage: `vault_append: ${path.value} by ${agent.value}`,
    autoCommit: config.value.autoCommit,
    gitDir: config.value.gitDir,
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
    ...(runId.value !== undefined ? { runId: runId.value } : {}),
    bodyChanged: true,
  });
  // #4: an appended section can introduce body links into generative-domain
  // docs — same advisory channel as vault_write, scoped to what THIS append
  // added: only the new section is scanned (a doc that already leaned on
  // generative material warned at write time; re-warning on every later,
  // unrelated append would drown the signal), and sources are skipped
  // entirely because an append cannot change frontmatter.
  if (!appended.ok || appended.value.shadow) return appended;
  const appendWarnings = generativeDomainRefs(
    vaultRoot,
    {
      domain: newFrontmatter.domain,
      sources: [],
      body: section.value,
      relPath: resolved.value.relPath,
    },
    access,
  );
  if (appendWarnings === null) return appended;
  return ok({ ...appended.value, domain_warnings: appendWarnings });
}

// ---------------------------------------------------------------------------
// vault_promote
// ---------------------------------------------------------------------------

// Promotes a draft document to canonical. Promotion is deliberate: it is only
// reachable through this tool, and it refuses unless the document's
// frontmatter is complete and a confidence level has been explicitly set.
export async function vaultPromote(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<WriteResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const proposeGate = denyIfProposeOnly(access, "vault_promote");
  if (!proposeGate.ok) return proposeGate;
  const path = requireString(args, "path", "vault_promote");
  if (!path.ok) return path;
  const agent = requireString(args, "agent", "vault_promote");
  if (!agent.ok) return agent;
  const baseVersion = readBaseVersion(args, "vault_promote");
  if (!baseVersion.ok) return baseVersion;

  if (access && !canPromote(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot promote documents`));
  }

  const resolved = resolveVaultPath(vaultRoot, path.value);
  if (!resolved.ok) return resolved;

  const existing = await readFile(resolved.value.absPath);
  if (!existing.ok) {
    return err(new Error(`vault_promote: document not found: ${path.value}`));
  }
  const parsed = parseDocument(existing.value);
  if (!parsed.ok) return parsed;

  const config = loadConfig(vaultRoot);
  if (!config.ok) return config;
  const extensions = config.value.schemaExtensions;

  const oldFrontmatter = parsed.value.frontmatter;
  if (oldFrontmatter.status !== "draft") {
    return err(
      new Error(
        `vault_promote: only draft documents can be promoted ` +
          `(${path.value} is '${oldFrontmatter.status}')`,
      ),
    );
  }
  if (!parsed.value.validation.valid) {
    const summary = parsed.value.validation.issues
      .map((i) => `${i.field}: ${i.message}`)
      .join("; ");
    return err(new Error(`vault_promote: frontmatter is incomplete: ${summary}`));
  }
  // `confidence set` — the document must declare a confidence explicitly, not
  // ride on the validator's default.
  const rawConfidence = parsed.value.raw.confidence;
  if (
    typeof rawConfidence !== "string" ||
    !(CONFIDENCES as readonly string[]).includes(rawConfidence)
  ) {
    return err(new Error("vault_promote: confidence must be set before promotion"));
  }

  const newFrontmatter: Frontmatter = {
    ...oldFrontmatter,
    status: "canonical",
    updated: todayISO(),
    updated_by: agent.value,
  };

  return performWrite({
    vaultRoot,
    // Lock key, provenance, and commit path are all keyed on the CANONICAL
    // relPath (resolved.value.relPath), never the raw caller string: aliased
    // spellings of one file must contend on one lock (#127/#128).
    relPath: resolved.value.relPath,
    absPath: resolved.value.absPath,
    agent: agent.value,
    tool: "vault_promote",
    action: "promote",
    fileText: serializeDocument(newFrontmatter, parsed.value.content, extensions, parsed.value.raw),
    newFrontmatter,
    oldFrontmatter,
    validation: parsed.value.validation,
    commitMessage: `vault_promote: ${path.value} draft→canonical by ${agent.value}`,
    autoCommit: config.value.autoCommit,
    gitDir: config.value.gitDir,
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
    bodyChanged: false,
  });
}

// ---------------------------------------------------------------------------
// vault_deprecate
// ---------------------------------------------------------------------------

// Marks a document deprecated. A reason is mandatory and is recorded in the
// commit message; an optional `superseded_by` points at the document that
// replaces this one.
export async function vaultDeprecate(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<WriteResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const proposeGate = denyIfProposeOnly(access, "vault_deprecate");
  if (!proposeGate.ok) return proposeGate;
  const path = requireString(args, "path", "vault_deprecate");
  if (!path.ok) return path;
  const agent = requireString(args, "agent", "vault_deprecate");
  if (!agent.ok) return agent;
  const reason = requireString(args, "reason", "vault_deprecate");
  if (!reason.ok) return reason;
  const baseVersion = readBaseVersion(args, "vault_deprecate");
  if (!baseVersion.ok) return baseVersion;

  let supersededBy: string | null = null;
  if (args.superseded_by !== undefined && args.superseded_by !== null) {
    if (typeof args.superseded_by !== "string") {
      return err(new Error("vault_deprecate: 'superseded_by' must be a string or null"));
    }
    supersededBy = args.superseded_by;
  }

  const resolved = resolveVaultPath(vaultRoot, path.value);
  if (!resolved.ok) return resolved;

  const existing = await readFile(resolved.value.absPath);
  if (!existing.ok) {
    return err(new Error(`vault_deprecate: document not found: ${path.value}`));
  }
  const parsed = parseDocument(existing.value);
  if (!parsed.ok) return parsed;

  const config = loadConfig(vaultRoot);
  if (!config.ok) return config;
  const extensions = config.value.schemaExtensions;

  const oldFrontmatter = parsed.value.frontmatter;
  if (access) {
    const collection = collectionOf(path.value, oldFrontmatter);
    if (!canWrite(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot write to ` +
            `collection '${collection}'`,
        ),
      );
    }
  }
  const newFrontmatter: Frontmatter = {
    ...oldFrontmatter,
    status: "deprecated",
    superseded_by: supersededBy,
    updated: todayISO(),
    updated_by: agent.value,
  };

  return performWrite({
    vaultRoot,
    // Lock key, provenance, and commit path are all keyed on the CANONICAL
    // relPath (resolved.value.relPath), never the raw caller string: aliased
    // spellings of one file must contend on one lock (#127/#128).
    relPath: resolved.value.relPath,
    absPath: resolved.value.absPath,
    agent: agent.value,
    tool: "vault_deprecate",
    action: "deprecate",
    fileText: serializeDocument(newFrontmatter, parsed.value.content, extensions, parsed.value.raw),
    newFrontmatter,
    oldFrontmatter,
    validation: parsed.value.validation,
    commitMessage:
      `vault_deprecate: ${path.value} by ${agent.value} — ${reason.value}` +
      (supersededBy ? ` (superseded by ${supersededBy})` : ""),
    autoCommit: config.value.autoCommit,
    gitDir: config.value.gitDir,
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
    bodyChanged: false,
  });
}

// ---------------------------------------------------------------------------
// vault_set_confidence (§11.4)
// ---------------------------------------------------------------------------

// Changes only a document's `confidence`, leaving status and body untouched.
// A narrow tool so a calibration nudge never rides a full-document overwrite.
// A reason is mandatory — a confidence change is a claim about the document's
// trustworthiness and earns an audit trail.
export async function vaultSetConfidence(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<WriteResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const proposeGate = denyIfProposeOnly(access, "vault_set_confidence");
  if (!proposeGate.ok) return proposeGate;
  const path = requireString(args, "path", "vault_set_confidence");
  if (!path.ok) return path;
  const agent = requireString(args, "agent", "vault_set_confidence");
  if (!agent.ok) return agent;
  const reason = requireString(args, "reason", "vault_set_confidence");
  if (!reason.ok) return reason;
  const confidence = requireString(args, "confidence", "vault_set_confidence");
  if (!confidence.ok) return confidence;
  if (!(CONFIDENCES as readonly string[]).includes(confidence.value)) {
    return err(
      new Error(`vault_set_confidence: 'confidence' must be one of: ${CONFIDENCES.join(", ")}`),
    );
  }
  const baseVersion = readBaseVersion(args, "vault_set_confidence");
  if (!baseVersion.ok) return baseVersion;

  const resolved = resolveVaultPath(vaultRoot, path.value);
  if (!resolved.ok) return resolved;

  const existing = await readFile(resolved.value.absPath);
  if (!existing.ok) {
    return err(new Error(`vault_set_confidence: document not found: ${path.value}`));
  }
  const parsed = parseDocument(existing.value);
  if (!parsed.ok) return parsed;

  const config = loadConfig(vaultRoot);
  if (!config.ok) return config;
  const extensions = config.value.schemaExtensions;

  const oldFrontmatter = parsed.value.frontmatter;
  if (access) {
    const collection = collectionOf(path.value, oldFrontmatter);
    if (!canWrite(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot write to ` +
            `collection '${collection}'`,
        ),
      );
    }
  }

  // No-op guard: a confidence already at the target would churn a commit for no
  // change. Surface it as an error so a redundant staged confidence-up does not
  // silently no-op (and a caller learns the value was already set). Compare
  // against the *raw* on-disk value, not the validated frontmatter — the
  // validator defaults a missing confidence to "low", so comparing the
  // validated value would wrongly reject set_confidence(…, "low") on a doc that
  // never declared one and never write the field (the trap vault_promote dodges
  // the same way, via parsed.value.raw.confidence).
  const rawConfidence = parsed.value.raw.confidence;
  const currentConfidence =
    typeof rawConfidence === "string" && (CONFIDENCES as readonly string[]).includes(rawConfidence)
      ? rawConfidence
      : undefined;
  if (currentConfidence === confidence.value) {
    return err(
      new Error(`vault_set_confidence: ${path.value} confidence is already '${confidence.value}'`),
    );
  }

  const newFrontmatter: Frontmatter = {
    ...oldFrontmatter,
    confidence: confidence.value as Frontmatter["confidence"],
    updated: todayISO(),
    updated_by: agent.value,
  };

  return performWrite({
    vaultRoot,
    // Lock key, provenance, and commit path are all keyed on the CANONICAL
    // relPath (resolved.value.relPath), never the raw caller string: aliased
    // spellings of one file must contend on one lock (#127/#128).
    relPath: resolved.value.relPath,
    absPath: resolved.value.absPath,
    agent: agent.value,
    tool: "vault_set_confidence",
    action: "confidence-set",
    fileText: serializeDocument(newFrontmatter, parsed.value.content, extensions, parsed.value.raw),
    newFrontmatter,
    oldFrontmatter,
    validation: parsed.value.validation,
    commitMessage:
      `vault_set_confidence: ${path.value} ${oldFrontmatter.confidence}→${confidence.value} ` +
      `by ${agent.value} — ${reason.value}`,
    autoCommit: config.value.autoCommit,
    gitDir: config.value.gitDir,
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
    bodyChanged: false,
  });
}

// ---------------------------------------------------------------------------
// vault_set_tier (#141)
// ---------------------------------------------------------------------------

// Changes only a document's write-protection tier, leaving body and status
// untouched. This is the escape hatch for the tier guards — a separate,
// reason-carrying, provenance-logged act rather than an inline force flag on
// the destructive call. Moving a doc AWAY from `manual` requires a human:*
// identity (otherwise demote-then-write would bypass the consent boundary);
// moving away from `source` is open to any identity — deliberate demotions
// are allowed, and vault_lint surfaces them for review.
export async function vaultSetTier(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<WriteResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const proposeGate = denyIfProposeOnly(access, "vault_set_tier");
  if (!proposeGate.ok) return proposeGate;
  const path = requireString(args, "path", "vault_set_tier");
  if (!path.ok) return path;
  const agent = requireString(args, "agent", "vault_set_tier");
  if (!agent.ok) return agent;
  const reason = requireString(args, "reason", "vault_set_tier");
  if (!reason.ok) return reason;
  const tier = requireString(args, "tier", "vault_set_tier");
  if (!tier.ok) return tier;
  if (!(TIERS as readonly string[]).includes(tier.value)) {
    return err(new Error(`vault_set_tier: 'tier' must be one of: ${TIERS.join(", ")}`));
  }
  const newTier = tier.value as Tier;
  const baseVersion = readBaseVersion(args, "vault_set_tier");
  if (!baseVersion.ok) return baseVersion;

  const resolved = resolveVaultPath(vaultRoot, path.value);
  if (!resolved.ok) return resolved;

  const existing = await readFile(resolved.value.absPath);
  if (!existing.ok) {
    return err(new Error(`vault_set_tier: document not found: ${path.value}`));
  }
  const parsed = parseDocument(existing.value);
  if (!parsed.ok) return parsed;

  const config = loadConfig(vaultRoot);
  if (!config.ok) return config;
  const extensions = config.value.schemaExtensions;

  const oldFrontmatter = parsed.value.frontmatter;
  if (access) {
    const collection = collectionOf(path.value, oldFrontmatter);
    if (!canWrite(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot write to ` +
            `collection '${collection}'`,
        ),
      );
    }
  }

  // The manual consent boundary: only a human identity may lift `manual`.
  if (
    oldFrontmatter.tier === "manual" &&
    newTier !== "manual" &&
    !agent.value.startsWith("human:")
  ) {
    return err(
      new Error(
        `vault_set_tier: ${path.value} is tier 'manual' — moving it away from ` +
          `'manual' requires a human:* identity (got '${agent.value}').`,
      ),
    );
  }

  // No-op guard, same shape as vault_set_confidence: compare against the raw
  // on-disk value so an invalid raw tier (validated down to null) can still be
  // set to any member.
  const rawTier = parsed.value.raw.tier;
  const currentTier =
    typeof rawTier === "string" && (TIERS as readonly string[]).includes(rawTier)
      ? rawTier
      : undefined;
  if (currentTier === newTier) {
    return err(new Error(`vault_set_tier: ${path.value} tier is already '${newTier}'`));
  }

  const newFrontmatter: Frontmatter = {
    ...oldFrontmatter,
    tier: newTier,
    updated: todayISO(),
    updated_by: agent.value,
  };

  return performWrite({
    vaultRoot,
    // Lock key, provenance, and commit path are all keyed on the CANONICAL
    // relPath (resolved.value.relPath), never the raw caller string: aliased
    // spellings of one file must contend on one lock (#127/#128).
    relPath: resolved.value.relPath,
    absPath: resolved.value.absPath,
    agent: agent.value,
    tool: "vault_set_tier",
    action: "tier-set",
    fileText: serializeDocument(newFrontmatter, parsed.value.content, extensions, parsed.value.raw),
    newFrontmatter,
    oldFrontmatter,
    validation: parsed.value.validation,
    commitMessage:
      `vault_set_tier: ${path.value} ${oldFrontmatter.tier ?? "unset"}→${newTier} ` +
      `by ${agent.value} — ${reason.value}`,
    autoCommit: config.value.autoCommit,
    gitDir: config.value.gitDir,
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
    bodyChanged: false,
  });
}

// ---------------------------------------------------------------------------
// vault_supersede (§11.4)
// ---------------------------------------------------------------------------

// Marks a document explicitly superseded by a named successor. Distinct from
// vault_deprecate: deprecate sets status="deprecated" with an *optional*
// successor; supersede sets status="superseded" and *requires* a successor that
// must already exist. Permissive on source status in v1 (last-write-wins).
export async function vaultSupersede(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<WriteResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const proposeGate = denyIfProposeOnly(access, "vault_supersede");
  if (!proposeGate.ok) return proposeGate;
  const oldPath = requireString(args, "old_path", "vault_supersede");
  if (!oldPath.ok) return oldPath;
  const newPath = requireString(args, "new_path", "vault_supersede");
  if (!newPath.ok) return newPath;
  const agent = requireString(args, "agent", "vault_supersede");
  if (!agent.ok) return agent;
  const baseVersion = readBaseVersion(args, "vault_supersede");
  if (!baseVersion.ok) return baseVersion;

  let reason: string | undefined;
  if (args.reason !== undefined && args.reason !== null) {
    if (typeof args.reason !== "string") {
      return err(new Error("vault_supersede: 'reason' must be a string"));
    }
    const trimmed = args.reason.trim();
    if (trimmed.length > 0) reason = trimmed;
  }

  if (oldPath.value === newPath.value) {
    return err(new Error("vault_supersede: a document cannot supersede itself"));
  }

  const resolvedOld = resolveVaultPath(vaultRoot, oldPath.value);
  if (!resolvedOld.ok) return resolvedOld;
  const resolvedNew = resolveVaultPath(vaultRoot, newPath.value);
  if (!resolvedNew.ok) return resolvedNew;

  const existing = await readFile(resolvedOld.value.absPath);
  if (!existing.ok) {
    return err(new Error(`vault_supersede: document not found: ${oldPath.value}`));
  }
  // The successor must be a real document — superseded_by must never dangle.
  const successor = await readFile(resolvedNew.value.absPath);
  if (!successor.ok) {
    return err(new Error(`vault_supersede: successor not found: ${newPath.value}`));
  }
  const parsed = parseDocument(existing.value);
  if (!parsed.ok) return parsed;

  const config = loadConfig(vaultRoot);
  if (!config.ok) return config;
  const extensions = config.value.schemaExtensions;

  const oldFrontmatter = parsed.value.frontmatter;
  if (access) {
    const collection = collectionOf(oldPath.value, oldFrontmatter);
    if (!canWrite(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot write to ` +
            `collection '${collection}'`,
        ),
      );
    }
  }

  const newFrontmatter: Frontmatter = {
    ...oldFrontmatter,
    status: "superseded",
    superseded_by: newPath.value,
    updated: todayISO(),
    updated_by: agent.value,
  };

  return performWrite({
    vaultRoot,
    // Canonical relPath keys the lock/provenance/commit (#127/#128).
    relPath: resolvedOld.value.relPath,
    absPath: resolvedOld.value.absPath,
    agent: agent.value,
    tool: "vault_supersede",
    action: "supersede",
    fileText: serializeDocument(newFrontmatter, parsed.value.content, extensions, parsed.value.raw),
    newFrontmatter,
    oldFrontmatter,
    validation: parsed.value.validation,
    commitMessage:
      `vault_supersede: ${oldPath.value} superseded by ${newPath.value} ` +
      `by ${agent.value}${reason ? ` — ${reason}` : ""}`,
    autoCommit: config.value.autoCommit,
    gitDir: config.value.gitDir,
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
    bodyChanged: false,
  });
}

// ---------------------------------------------------------------------------
// vault_merge (§11.4)
// ---------------------------------------------------------------------------

// One source doc being written or mutated as part of a merge, prepared before
// any file I/O so all three writes can land under a single commit.
interface MergeWrite {
  relPath: string;
  absPath: string;
  fileText: string;
  newFrontmatter: Frontmatter;
  oldFrontmatter: Frontmatter | null;
  action: WriteResult["action"];
}

// Combines two source documents into a target and supersedes both sources to
// point at it. Mechanical, not generative: the merged body is supplied by the
// caller (a human at ratification, or the loop) — vault_merge never synthesizes
// prose (that would be an LLM call; the write layer is LLM-free).
//
// Unlike the single-file write tools this touches up to three files, so it does
// not use performWrite. It mirrors the backfill apply pattern: write each file,
// index each, then one git commit for the whole set (src/backfill/apply.ts). A
// source that *is* the target is written once (with the merged body), not also
// superseded. base_version optimistic concurrency is not offered for merge.
export async function vaultMerge(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<WriteResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const proposeGate = denyIfProposeOnly(access, "vault_merge");
  if (!proposeGate.ok) return proposeGate;
  const pathA = requireString(args, "path_a", "vault_merge");
  if (!pathA.ok) return pathA;
  const pathB = requireString(args, "path_b", "vault_merge");
  if (!pathB.ok) return pathB;
  const targetPath = requireString(args, "target_path", "vault_merge");
  if (!targetPath.ok) return targetPath;
  const agent = requireString(args, "agent", "vault_merge");
  if (!agent.ok) return agent;
  const body = args.body;
  if (typeof body !== "string" || body.trim().length === 0) {
    return err(new Error("vault_merge requires a non-empty string 'body' argument"));
  }
  if (args.frontmatter !== undefined && args.frontmatter !== null) {
    if (typeof args.frontmatter !== "object") {
      return err(new Error("vault_merge: 'frontmatter' must be an object"));
    }
  }
  const frontmatterOverrides =
    args.frontmatter && typeof args.frontmatter === "object"
      ? (args.frontmatter as Record<string, unknown>)
      : {};

  // Resolve all three paths up front and run every identity check against the
  // CANONICAL relPath, never the raw caller strings: `pricing/a.md`,
  // `./pricing/a.md`, and a symlink alias all name the same file but differ as
  // strings (and as absPaths, for a symlink), which would otherwise defeat the
  // path_a≠path_b guard and the source-is-target skip below (writing one file
  // twice in a single commit and superseding it against itself).
  const resolvedA = resolveVaultPath(vaultRoot, pathA.value);
  if (!resolvedA.ok) return resolvedA;
  const resolvedB = resolveVaultPath(vaultRoot, pathB.value);
  if (!resolvedB.ok) return resolvedB;
  const resolvedTarget = resolveVaultPath(vaultRoot, targetPath.value);
  if (!resolvedTarget.ok) return resolvedTarget;

  if (resolvedA.value.relPath === resolvedB.value.relPath) {
    return err(new Error("vault_merge: path_a and path_b must differ"));
  }

  const existingA = await readFile(resolvedA.value.absPath);
  if (!existingA.ok) return err(new Error(`vault_merge: document not found: ${pathA.value}`));
  const existingB = await readFile(resolvedB.value.absPath);
  if (!existingB.ok) return err(new Error(`vault_merge: document not found: ${pathB.value}`));
  const parsedA = parseDocument(existingA.value);
  if (!parsedA.ok) return parsedA;
  const parsedB = parseDocument(existingB.value);
  if (!parsedB.ok) return parsedB;

  const config = loadConfig(vaultRoot);
  if (!config.ok) return config;
  const extensions = config.value.schemaExtensions;

  // RBAC: a merge writes/mutates all three docs, so the caller needs write on
  // each one's collection.
  if (access) {
    // path_a and path_b are gated on their existing on-disk collections. The
    // target is gated on the directory the merged bytes physically land in — the
    // resolved target path's top-level dir — NOT the caller-declared collection
    // (override or path_a's raw value). Keying the target gate off a declared
    // string let a role with write on collection A write the merge result into
    // collection B by pointing target_path at B while declaring `collection: A`
    // (S1, same shape as vault_write).
    const collections = [
      collectionOf(pathA.value, parsedA.value.frontmatter),
      collectionOf(pathB.value, parsedB.value.frontmatter),
      targetCollection(vaultRoot, targetPath.value),
    ];
    for (const collection of collections) {
      if (!canWrite(access.role, collection)) {
        return err(
          new Error(
            `access denied: role '${access.roleName}' cannot write to ` +
              `collection '${collection}'`,
          ),
        );
      }
    }
  }

  // Target frontmatter: inherit path_a's raw frontmatter, apply caller
  // overrides, stamp provenance/updated/updated_by. If the target file already
  // exists, preserve its `created` (the vault_write update idiom); otherwise
  // inherit path_a's. The supplied body replaces whatever was there.
  const existingTarget = await readFile(resolvedTarget.value.absPath);
  let targetOldFrontmatter: Frontmatter | null = null;
  let targetOldContent = "";
  let targetCreated = parsedA.value.frontmatter.created;
  if (existingTarget.ok) {
    const parsedTarget = parseDocument(existingTarget.value);
    if (parsedTarget.ok) {
      targetOldFrontmatter = parsedTarget.value.frontmatter;
      targetOldContent = parsedTarget.value.content;
      targetCreated = parsedTarget.value.frontmatter.created;
    }
  }

  // Tier guard (#141): the merged body wholly replaces the target's. path_a
  // and path_b only receive a frontmatter-level supersede, so their tiers
  // don't gate the merge.
  if (targetOldFrontmatter) {
    const guard = checkTierGuard({
      tool: "vault_merge",
      path: targetPath.value,
      tier: targetOldFrontmatter.tier,
      oldBody: targetOldContent,
      newBody: body,
      agent: agent.value,
    });
    if (!guard.ok) return guard;
  }
  const targetRaw: Record<string, unknown> = {
    ...parsedA.value.raw,
    provenance: "synthesized",
    ...frontmatterOverrides,
    created: targetCreated,
    updated: todayISO(),
    updated_by: agent.value,
  };
  const { frontmatter: targetFm, report: targetReport } = validateFrontmatter(
    targetRaw,
    extensions,
  );
  if (!targetReport.valid) {
    const summary = targetReport.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    return err(new Error(`vault_merge: target frontmatter is invalid: ${summary}`));
  }
  const stampedTarget: Frontmatter = {
    ...targetFm,
    created: targetCreated,
    updated: todayISO(),
    updated_by: agent.value,
  };

  // Build the write set. The target is always written. Each source that is NOT
  // the target is superseded to point at the target.
  const writes: MergeWrite[] = [];
  writes.push({
    // Canonical relPath keys the per-file lock, provenance, and commit path so
    // aliased spellings collapse to one lock (#127/#128).
    relPath: resolvedTarget.value.relPath,
    absPath: resolvedTarget.value.absPath,
    fileText: serializeDocument(
      stampedTarget,
      body,
      extensions,
      applyExtensionDefaults(targetRaw, extensions),
    ),
    newFrontmatter: stampedTarget,
    oldFrontmatter: targetOldFrontmatter,
    action: "merge",
  });
  for (const source of [
    {
      path: pathA.value,
      abs: resolvedA.value.absPath,
      rel: resolvedA.value.relPath,
      parsed: parsedA.value,
    },
    {
      path: pathB.value,
      abs: resolvedB.value.absPath,
      rel: resolvedB.value.relPath,
      parsed: parsedB.value,
    },
  ]) {
    // Compare canonical relPaths, not raw strings or absPaths: a source that
    // aliases the target — lexically (`./pricing/a.md`) OR via a symlink — is
    // the fold-into-A case: write it once with the merged body, never supersede
    // it. A symlink alias has a distinct absPath, so an absPath compare would
    // miss it and clobber the merged body with the superseded write (#127/#128).
    if (source.rel === resolvedTarget.value.relPath) continue;
    const supersededFm: Frontmatter = {
      ...source.parsed.frontmatter,
      status: "superseded",
      superseded_by: targetPath.value,
      updated: todayISO(),
      updated_by: agent.value,
    };
    writes.push({
      relPath: source.rel,
      absPath: source.abs,
      fileText: serializeDocument(
        supersededFm,
        source.parsed.content,
        extensions,
        source.parsed.raw,
      ),
      newFrontmatter: supersededFm,
      oldFrontmatter: source.parsed.frontmatter,
      action: "supersede",
    });
  }

  // Shadow mode (spec §11.5): the full write set is assembled and validated —
  // the do() that WOULD have executed. Log one merge record whose blast seeds
  // every touched path, write nothing.
  if (config.value.shadowMode) {
    const recorded = await recordShadowAction(vaultRoot, {
      tool: "vault_merge",
      action: "merge",
      targetPath: targetPath.value,
      touchedPaths: [...new Set(writes.map((w) => w.relPath))],
      agent: agent.value,
      ...(access?.user ? { principal: access.user } : {}),
      frontmatterDiff: frontmatterDiff(targetOldFrontmatter, stampedTarget),
      commitMessage: `vault_merge: ${pathA.value} + ${pathB.value} → ${targetPath.value} by ${agent.value}`,
    });
    if (!recorded.ok) return recorded;
    return ok({
      path: targetPath.value,
      action: "merge",
      commit: null,
      committed: false,
      status: stampedTarget.status,
      updated: stampedTarget.updated,
      validation: targetReport,
      indexUpdated: false,
      shadow: true,
    });
  }

  // Acquire file locks on every distinct path, in a deterministic sorted order
  // (defensive against self-deadlock if two merges ever overlapped — the
  // one-process invariant makes that theoretical). Release all in finally.
  const lockDbResult = openLockDb(vaultRoot);
  if (!lockDbResult.ok) return lockDbResult;
  const lockDb = lockDbResult.value;
  const lockPaths = [...new Set(writes.map((w) => w.relPath))].sort();
  const held: string[] = [];

  try {
    for (const relPath of lockPaths) {
      const lock = acquireLock(lockDb, relPath, agent.value);
      if (!lock.ok) return lock;
      held.push(relPath);
    }

    // Write all files, then a single git commit. This is NOT crash-atomic on
    // the disk-write phase: like the single-file write path (performWrite), a
    // throw mid-loop — or a commit() failure after the files are on disk —
    // leaves the working tree dirty and uncommitted. For merge the dirty state
    // can be a *partial* merge (target written, a source not yet superseded),
    // which a later reindex/watcher would pick up. The git commit itself is
    // atomic, and the one-process invariant plus human-gated ratification keep
    // this window small; a full pre-write snapshot/rollback is deferred.
    for (const w of writes) {
      await mkdir(dirname(w.absPath), { recursive: true });
      await writeFile(w.absPath, w.fileText, "utf-8");
    }

    let commitHash: string | null = null;
    if (config.value.autoCommit) {
      const committed = await commit(
        vaultRoot,
        writes.map((w) => w.relPath),
        `vault_merge: ${pathA.value} + ${pathB.value} → ${targetPath.value} by ${agent.value}`,
        agent.value,
        { gitDir: config.value.gitDir },
      );
      if (!committed.ok) return committed;
      commitHash = committed.value.hash;
    }

    // Index each written doc and log provenance per file. Both are best-effort
    // (the index is a rebuildable cache; the log is advisory) so a failure here
    // does not unwind the durable commit. noteSelfWrite runs here, after the
    // index lands, so the fs.watch reactive indexer drops the redundant change
    // event for our own write (mirrors performWrite's ordering).
    let allIndexed = true;
    for (const w of writes) {
      const indexed = await indexDocument(vaultRoot, w.relPath);
      if (!indexed.ok) allIndexed = false;
      noteSelfWrite(w.absPath);
      await recordProvenance(vaultRoot, {
        tool: "vault_merge",
        file: w.relPath,
        agent: agent.value,
        ...(access?.user ? { principal: access.user } : {}),
        action: w.action,
        // The merge target gets a new body; the superseded sources only get
        // frontmatter stamps.
        body_changed: w.action === "merge",
        frontmatter_diff: frontmatterDiff(w.oldFrontmatter, w.newFrontmatter),
      });
    }

    return ok({
      path: targetPath.value,
      action: "merge",
      commit: commitHash,
      committed: config.value.autoCommit,
      status: stampedTarget.status,
      updated: stampedTarget.updated,
      validation: targetReport,
      indexUpdated: allIndexed,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`vault_merge failed: ${reason}`));
  } finally {
    for (const relPath of held) releaseLock(lockDb, relPath, agent.value);
    lockDb.close();
  }
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

const agentProperty = {
  type: "string",
  description:
    "Acting identity, e.g. 'agent:claude-code' or 'human:mihir'. Recorded " +
    "as updated_by, the git author, and in the provenance log.",
};

// Appended to every write-tool description: shadow_mode (§11.5) makes the
// "auto-commits" claim conditionally false, and the description is the only
// surface a caller reads before invoking.
const shadowNote =
  " If the vault runs shadow_mode, the write is computed and logged to the " +
  "shadow store but NOT applied; the result carries shadow: true.";

const baseVersionProperty = {
  type: "string",
  description:
    "Optional optimistic-concurrency token: the 'version' that vault_read " +
    "returned for the document this write was composed against. The server " +
    "re-hashes the file inside the write lock; if it no longer matches, the " +
    "write is rejected as stale and nothing is changed. Omit for " +
    "last-write-wins behavior.",
};

const runIdProperty = {
  type: "string",
  description:
    "Optional trace/run identifier of the calling run. Recorded in the " +
    "provenance log so one run's writes correlate.",
};

// Built-in frontmatter properties, projected from the canonical TS constants
// in src/frontmatter/types.ts so the MCP input schema, the runtime validator,
// and the source-of-truth enums never drift. `additionalProperties: true`
// allows config-declared schema extensions (the index signature on
// `Frontmatter`) without listing them here.
const frontmatterProperty = {
  type: "object",
  description:
    "Document frontmatter. 'updated' and 'updated_by' are server-managed — " +
    "omit them; anything supplied is overwritten by the server stamp.",
  properties: {
    title: {
      type: "string",
      description: "Human-readable document title",
    },
    domain: {
      type: "string",
      enum: [...DOMAINS],
      description:
        "Whether this document accumulates knowledge over time " +
        "('accumulation') or is generated fresh from a snapshot ('generative')",
    },
    collection: {
      type: "string",
      description: "Vault collection name — must match a top-level directory in the vault",
    },
    status: {
      type: "string",
      enum: [...STATUSES],
      description: "Lifecycle state of the document",
    },
    confidence: {
      type: "string",
      enum: [...CONFIDENCES],
      description: "Author's calibrated confidence in the document's claims",
    },
    created: {
      type: "string",
      description: "ISO date the document was first created (YYYY-MM-DD)",
    },
    provenance: {
      type: "string",
      enum: [...PROVENANCES],
      description:
        "How the content originated: 'direct' (typed or pasted in by a human " +
        "or agent), 'synthesized' (composed by an agent from other sources), " +
        "or 'inferred' (derived from analysis, not stated outright anywhere)",
    },
    sources: {
      type: "array",
      items: { type: "string" },
      description: "URLs or vault paths the content draws on",
    },
    superseded_by: {
      type: ["string", "null"],
      description:
        "Vault path of a document that replaces this one (status=superseded), " +
        "or null if not superseded",
    },
    ttl_days: {
      type: ["number", "null"],
      description:
        "Number of days after which this document is considered stale and " +
        "should be reviewed. null = no TTL.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Free-form tags (lowercase, hyphenated, no spaces)",
    },
    questions_answered: {
      type: "array",
      items: { type: "string" },
      description: "Questions this document answers (mirrors ## Questions Answered)",
    },
    questions_raised: {
      type: "array",
      items: { type: "string" },
      description:
        "Open questions this document raises (mirrors ## Questions Raised). " +
        "Surfaced by vault_lint's `unanswered-questions` check.",
    },
  },
  required: ["title", "domain", "collection", "status", "confidence", "created", "provenance"],
  additionalProperties: true,
};

export const writeTools: ToolDefinition[] = [
  {
    name: "vault_write",
    title: "Create or update a document",
    annotations: { destructiveHint: true },
    description:
      "Create a new vault document or overwrite an existing one. Supply the " +
      "full frontmatter and markdown body; the server stamps 'updated' and " +
      "'updated_by' (omit them — anything supplied is overwritten), preserves " +
      "'created' on updates, refreshes the search index, and auto-commits the " +
      "change to git. If the caller's role is propose-only, nothing is " +
      "written: the payload lands as a staged 'write' proposal awaiting " +
      "vault_ratify, and the result carries action: 'staged' with the " +
      "proposal id (plus any competing pending proposals on the same target). " +
      "Overwriting an existing document returns an advisory supersede_hint — " +
      "when the write records a changed fact, vault_supersede preserves the " +
      "prior version and its lineage instead. An accumulation-domain write " +
      "that cites or links generative-domain docs returns advisory " +
      "domain_warnings naming them; the write still lands." +
      shadowNote,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the markdown file to write",
        },
        body: { type: "string", description: "Markdown body (no frontmatter)" },
        frontmatter: frontmatterProperty,
        agent: agentProperty,
        base_version: baseVersionProperty,
        run_id: runIdProperty,
        reason: {
          type: "string",
          description:
            "Optional rationale. Used as the proposal rationale when a " +
            "propose-only role's write is staged for ratification.",
        },
      },
      required: ["path", "body", "frontmatter", "agent"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultWrite(vaultRoot, args, access),
  },
  {
    name: "vault_append",
    title: "Append to a document",
    annotations: { destructiveHint: true },
    description:
      "Append a markdown section to an existing vault document. Frontmatter " +
      "is preserved; 'updated' and 'updated_by' are re-stamped. Auto-commits. " +
      "Appending links to generative-domain docs onto an accumulation-domain " +
      "doc returns advisory domain_warnings naming them; the append still " +
      "lands." +
      shadowNote,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the document to append to",
        },
        section: {
          type: "string",
          description: "Markdown text to append to the document body",
        },
        agent: agentProperty,
        base_version: baseVersionProperty,
        run_id: runIdProperty,
      },
      required: ["path", "section", "agent"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultAppend(vaultRoot, args, access),
  },
  {
    name: "vault_promote",
    title: "Promote draft to canonical",
    annotations: { destructiveHint: true },
    description:
      "Promote a draft document to canonical status. Refuses unless the " +
      "document is currently a draft, its frontmatter is complete, and a " +
      "confidence level has been explicitly set. Auto-commits." +
      shadowNote,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the draft document to promote",
        },
        agent: agentProperty,
        base_version: baseVersionProperty,
      },
      required: ["path", "agent"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultPromote(vaultRoot, args, access),
  },
  {
    name: "vault_deprecate",
    title: "Deprecate a document",
    annotations: { destructiveHint: true },
    description:
      "Mark a document deprecated. A reason is required; optionally record " +
      "the document that supersedes it. Auto-commits." +
      shadowNote,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the document to deprecate",
        },
        reason: {
          type: "string",
          description: "Why the document is being deprecated",
        },
        superseded_by: {
          type: "string",
          description: "Optional vault-relative path of the document that replaces this one",
        },
        agent: agentProperty,
        base_version: baseVersionProperty,
      },
      required: ["path", "reason", "agent"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultDeprecate(vaultRoot, args, access),
  },
  {
    name: "vault_set_confidence",
    title: "Set a document's confidence",
    annotations: { destructiveHint: true },
    description:
      "Change only a document's confidence level (low | medium | high), leaving " +
      "its status and body untouched. A reason is required and recorded. Rejects " +
      "if the confidence is already at the target. Auto-commits." +
      shadowNote,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the document",
        },
        confidence: {
          type: "string",
          enum: [...CONFIDENCES],
          description: "The new confidence level",
        },
        reason: {
          type: "string",
          description: "Why the confidence is changing (recorded in the commit and provenance)",
        },
        agent: agentProperty,
        base_version: baseVersionProperty,
      },
      required: ["path", "confidence", "reason", "agent"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultSetConfidence(vaultRoot, args, access),
  },
  {
    name: "vault_set_tier",
    title: "Set a document's write-protection tier",
    annotations: { destructiveHint: true },
    description:
      "Change only a document's write-protection tier (source | compiled | " +
      "manual), leaving its body untouched. `source` bodies are immutable; " +
      "`manual` bodies only accept rewrites from a human:* identity; " +
      "`compiled` and unset are unenforced. This is the escape hatch for the " +
      "tier guards: demote first (a reason is required and the change is " +
      "logged for lint review), then write. Moving a doc away from 'manual' " +
      "requires a human:* identity. Rejects if the tier is already at the " +
      "target. Auto-commits." +
      shadowNote,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the document",
        },
        tier: {
          type: "string",
          enum: [...TIERS],
          description: "The new tier",
        },
        reason: {
          type: "string",
          description: "Why the tier is changing (recorded in the commit and provenance)",
        },
        agent: agentProperty,
        base_version: baseVersionProperty,
      },
      required: ["path", "tier", "reason", "agent"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultSetTier(vaultRoot, args, access),
  },
  {
    name: "vault_supersede",
    title: "Supersede a document",
    annotations: { destructiveHint: true },
    description:
      "Mark a document superseded by a named successor. Sets status=superseded " +
      "and superseded_by; the successor must already exist. Distinct from " +
      "vault_deprecate (which sets status=deprecated with an optional " +
      "successor). Auto-commits." +
      shadowNote,
    inputSchema: {
      type: "object",
      properties: {
        old_path: {
          type: "string",
          description: "Vault-relative path of the document being superseded",
        },
        new_path: {
          type: "string",
          description: "Vault-relative path of the successor that replaces it (must exist)",
        },
        reason: {
          type: "string",
          description: "Optional reason recorded in the commit message",
        },
        agent: agentProperty,
        base_version: baseVersionProperty,
      },
      required: ["old_path", "new_path", "agent"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultSupersede(vaultRoot, args, access),
  },
  {
    name: "vault_merge",
    title: "Merge two documents into one",
    annotations: { destructiveHint: true },
    description:
      "Combine two source documents into a target and supersede both sources to " +
      "point at it, all in one commit. The merged body is supplied by the caller " +
      "— vault_merge does not synthesize prose. target_path may equal path_a (to " +
      "fold B into A) or be a new path. The target's frontmatter inherits " +
      "path_a's (provenance becomes 'synthesized') unless overridden. Auto-commits." +
      shadowNote,
    inputSchema: {
      type: "object",
      properties: {
        path_a: {
          type: "string",
          description: "Vault-relative path of the first source document",
        },
        path_b: {
          type: "string",
          description: "Vault-relative path of the second source document",
        },
        target_path: {
          type: "string",
          description: "Vault-relative path of the merge target (may equal path_a, or be new)",
        },
        body: {
          type: "string",
          description: "The merged markdown body for the target (no frontmatter)",
        },
        frontmatter: {
          type: "object",
          description:
            "Optional frontmatter overrides for the target. Defaults to path_a's " +
            "frontmatter with provenance set to 'synthesized'.",
          additionalProperties: true,
        },
        agent: agentProperty,
      },
      required: ["path_a", "path_b", "target_path", "body", "agent"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultMerge(vaultRoot, args, access),
  },
];
