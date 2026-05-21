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
import { parseDocument } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../frontmatter/schema.js";
import {
  CONFIDENCES,
  type ExtensionValue,
  err,
  type Frontmatter,
  ok,
  type Result,
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
    questions_answered: fm.questions_answered,
    questions_raised: fm.questions_raised,
  };
  for (const ext of extensions) {
    const value = extensionValue(raw, ext);
    if (value !== undefined) ordered[ext.field] = value;
  }
  return matter.stringify(body.startsWith("\n") ? body : `\n${body}`, ordered);
}

export interface WriteResult {
  path: string;
  action: "create" | "update" | "append" | "promote" | "deprecate";
  // Short commit hash when the write was auto-committed; null when the vault
  // is configured with `auto_commit: false` and the caller owns git.
  commit: string | null;
  committed: boolean;
  status: string;
  updated: string;
  validation: ValidationReport;
  indexUpdated: boolean;
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
}): Promise<Result<WriteResult, Error>> {
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
  if (existing.ok) {
    const parsed = parseDocument(existing.value);
    if (parsed.ok) oldFrontmatter = parsed.value.frontmatter;
  }
  const isUpdate = oldFrontmatter !== null;
  const hookOperation: HookOperation = isUpdate ? "update" : "create";

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
  });
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

const baseVersionProperty = {
  type: "string",
  description:
    "Optional optimistic-concurrency token: the 'version' that vault_read " +
    "returned for the document this write was composed against. The server " +
    "re-hashes the file inside the write lock; if it no longer matches, the " +
    "write is rejected as stale and nothing is changed. Omit for " +
    "last-write-wins behavior.",
};

export const writeTools: ToolDefinition[] = [
  {
    name: "vault_write",
    description:
      "Create a new vault document or overwrite an existing one. Supply the " +
      "full frontmatter and markdown body; the server stamps 'updated' and " +
      "'updated_by', preserves 'created' on updates, refreshes the search " +
      "index, and auto-commits the change to git.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the markdown file to write",
        },
        body: { type: "string", description: "Markdown body (no frontmatter)" },
        frontmatter: {
          type: "object",
          description:
            "Full frontmatter block. Required: title, domain, collection, " +
            "status, confidence, created, provenance.",
        },
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
    description:
      "Append a markdown section to an existing vault document. Frontmatter " +
      "is preserved; 'updated' and 'updated_by' are re-stamped. Auto-commits.",
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
    description:
      "Promote a draft document to canonical status. Refuses unless the " +
      "document is currently a draft, its frontmatter is complete, and a " +
      "confidence level has been explicitly set. Auto-commits.",
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
    description:
      "Mark a document deprecated. A reason is required; optionally record " +
      "the document that supersedes it. Auto-commits.",
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
];
