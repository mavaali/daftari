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
import { dirname } from "node:path";
import matter from "gray-matter";
import { acquireLock, openLockDb, releaseLock } from "../access/locks.js";
import { type AccessContext, canPromote, canWrite } from "../access/rbac.js";
import { frontmatterDiff, recordProvenance } from "../curation/provenance.js";
import { recordShadowAction } from "../curation/shadow.js";
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
  type ValidationIssue,
  type ValidationReport,
} from "../frontmatter/types.js";
import { loadHooks, loadPreWriteTransformHooks } from "../hooks/loader.js";
import { runPreWriteHooks, runPreWriteTransformHooks } from "../hooks/runner.js";
import type { HookOperation } from "../hooks/types.js";
import { getIndexStatus, indexingBusyMessage } from "../search/index-state.js";
import { indexDocument } from "../search/reindex.js";
import { noteSelfWrite } from "../search/self-write.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import { loadConfig, type SchemaExtension } from "../utils/config.js";
import { commit } from "../utils/git.js";
import { sha256Hex } from "../utils/hash.js";
import type { ToolDefinition } from "./read.js";

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
    ordered[key] = value;
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
    | "confidence-set";
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
  baseVersion?: string;
  shadowMode?: boolean;
  // The authenticated identity the server runs as (access.user), when an
  // AccessContext is present (§11.6). Recorded on provenance and shadow
  // entries as ground truth alongside the caller-claimed `agent`.
  principal?: string;
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
        );
        if (!committed.ok) return committed;
        commitHash = committed.value.hash;
      }

      await recordProvenance(params.vaultRoot, {
        tool: params.tool,
        file: params.relPath,
        agent: params.agent,
        ...(params.principal ? { principal: params.principal } : {}),
        action: params.action,
        frontmatter_diff: frontmatterDiff(params.oldFrontmatter, params.newFrontmatter),
      });

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

// ---------------------------------------------------------------------------
// vault_write
// ---------------------------------------------------------------------------

// Creates a new document or overwrites an existing one. The caller supplies
// the full frontmatter; `updated` and `updated_by` are always stamped by the
// server, and `created` is preserved from the existing document on an update.
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
  if (access) {
    const declared = rawFrontmatter.collection;
    const collection =
      typeof declared === "string" && declared.length > 0
        ? declared
        : (path.value.split("/")[0] ?? "");
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

  const existing = await readFile(resolved.value);
  let oldFrontmatter: Frontmatter | null = null;
  let oldRaw: Record<string, unknown> | null = null;
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
  }
  const isUpdate = oldFrontmatter !== null;
  const hookOperation: HookOperation = isUpdate ? "update" : "create";

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

  return performWrite({
    vaultRoot,
    relPath: path.value,
    absPath: resolved.value,
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
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
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

  const resolved = resolveVaultPath(vaultRoot, path.value);
  if (!resolved.ok) return resolved;

  const existing = await readFile(resolved.value);
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

  return performWrite({
    vaultRoot,
    relPath: path.value,
    absPath: resolved.value,
    agent: agent.value,
    tool: "vault_append",
    action: "append",
    fileText: serializeDocument(newFrontmatter, newBody, extensions, parsed.value.raw),
    newFrontmatter,
    oldFrontmatter,
    validation: parsed.value.validation,
    commitMessage: `vault_append: ${path.value} by ${agent.value}`,
    autoCommit: config.value.autoCommit,
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
  });
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

  const existing = await readFile(resolved.value);
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
    relPath: path.value,
    absPath: resolved.value,
    agent: agent.value,
    tool: "vault_promote",
    action: "promote",
    fileText: serializeDocument(newFrontmatter, parsed.value.content, extensions, parsed.value.raw),
    newFrontmatter,
    oldFrontmatter,
    validation: parsed.value.validation,
    commitMessage: `vault_promote: ${path.value} draft→canonical by ${agent.value}`,
    autoCommit: config.value.autoCommit,
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
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

  const existing = await readFile(resolved.value);
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
    relPath: path.value,
    absPath: resolved.value,
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
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
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

  const existing = await readFile(resolved.value);
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
    relPath: path.value,
    absPath: resolved.value,
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
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
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

  const existing = await readFile(resolvedOld.value);
  if (!existing.ok) {
    return err(new Error(`vault_supersede: document not found: ${oldPath.value}`));
  }
  // The successor must be a real document — superseded_by must never dangle.
  const successor = await readFile(resolvedNew.value);
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
    relPath: oldPath.value,
    absPath: resolvedOld.value,
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
    baseVersion: baseVersion.value,
    shadowMode: config.value.shadowMode,
    principal: access?.user,
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
  // resolved absolute paths, never the raw caller strings: `pricing/a.md` and
  // `./pricing/a.md` name the same file but differ as strings, which would
  // otherwise defeat the path_a≠path_b guard and the source-is-target skip
  // below (writing one file twice in a single commit and superseding it against
  // itself).
  const resolvedA = resolveVaultPath(vaultRoot, pathA.value);
  if (!resolvedA.ok) return resolvedA;
  const resolvedB = resolveVaultPath(vaultRoot, pathB.value);
  if (!resolvedB.ok) return resolvedB;
  const resolvedTarget = resolveVaultPath(vaultRoot, targetPath.value);
  if (!resolvedTarget.ok) return resolvedTarget;

  if (resolvedA.value === resolvedB.value) {
    return err(new Error("vault_merge: path_a and path_b must differ"));
  }

  const existingA = await readFile(resolvedA.value);
  if (!existingA.ok) return err(new Error(`vault_merge: document not found: ${pathA.value}`));
  const existingB = await readFile(resolvedB.value);
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
    // The target's collection is the override, else path_a's *raw* collection
    // (the value actually serialized into the target below — not the validated
    // frontmatter, which may differ if path_a's raw collection is malformed),
    // else the target path's top-level dir. Deriving it from the same source
    // the write uses keeps the gate and the write in agreement.
    const rawACollection = parsedA.value.raw.collection;
    const collections = [
      collectionOf(pathA.value, parsedA.value.frontmatter),
      collectionOf(pathB.value, parsedB.value.frontmatter),
      typeof frontmatterOverrides.collection === "string" && frontmatterOverrides.collection
        ? frontmatterOverrides.collection
        : typeof rawACollection === "string" && rawACollection
          ? rawACollection
          : (targetPath.value.split("/")[0] ?? ""),
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
  const existingTarget = await readFile(resolvedTarget.value);
  let targetOldFrontmatter: Frontmatter | null = null;
  let targetCreated = parsedA.value.frontmatter.created;
  if (existingTarget.ok) {
    const parsedTarget = parseDocument(existingTarget.value);
    if (parsedTarget.ok) {
      targetOldFrontmatter = parsedTarget.value.frontmatter;
      targetCreated = parsedTarget.value.frontmatter.created;
    }
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
    relPath: targetPath.value,
    absPath: resolvedTarget.value,
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
    { path: pathA.value, abs: resolvedA.value, parsed: parsedA.value },
    { path: pathB.value, abs: resolvedB.value, parsed: parsedB.value },
  ]) {
    // Compare resolved absolute paths, not raw strings: a source that aliases
    // the target (e.g. target `./pricing/a.md`, source `pricing/a.md`) is the
    // fold-into-A case — write it once with the merged body, never supersede it.
    if (source.abs === resolvedTarget.value) continue;
    const supersededFm: Frontmatter = {
      ...source.parsed.frontmatter,
      status: "superseded",
      superseded_by: targetPath.value,
      updated: todayISO(),
      updated_by: agent.value,
    };
    writes.push({
      relPath: source.path,
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
      "change to git." +
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
      "is preserved; 'updated' and 'updated_by' are re-stamped. Auto-commits." +
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
