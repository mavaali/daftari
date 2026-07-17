// Loads and validates .daftari/config.yaml — the source of RBAC truth.
//
// The config declares named roles and their per-collection permissions. It is
// loaded once at server start. A malformed config fails loud (Result.err): a
// permission system that silently loads a broken policy is worse than one that
// refuses to start. A *missing* config is not malformed — it just yields an
// empty role set, so every --role resolves to the deny-all guest.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import {
  BUILTIN_FRONTMATTER_FIELDS,
  type ExtensionValue,
  err,
  ok,
  type Result,
} from "../frontmatter/types.js";
import type { HookConfig, HookDeclaration } from "../hooks/types.js";
import { sha256Hex } from "./hash.js";
import { hasCatastrophicBacktracking } from "./redos.js";

// Permissions for a single role. `read` / `write` are collection names; the
// wildcard "*" matches every collection. `promote` gates draft→canonical.
// `ratify` (§11.6) gates the curation-verdict tier: approving/rejecting staged
// actions (vault_ratify) and contesting derives_from edges (vault_edge_contest).
// An agent principal is just a role — e.g. a `curation-loop` role the server is
// started as via --user agent:curation-loop --role curation-loop.
export interface RoleConfig {
  read: string[];
  write: string[];
  promote: boolean;
  ratify: boolean;
  // #235: a propose-only role cannot mutate the vault directly — vault_write
  // coerces into a staged `write` proposal awaiting ratification, and every
  // other write tool is denied with a pointer to vault_stage_action. This is
  // the structural "agents cannot write any other state" enforcement: the
  // permission layer, not convention. YAML key: propose_only. Optional so
  // existing configs (and role literals) are unchanged; absent means false.
  proposeOnly?: boolean;
}

// The primitive types a schema-extension field may declare. `array` is v1
// array<string> only; `enum` is a closed set of string values.
export const EXTENSION_TYPES = ["string", "date", "number", "boolean", "array", "enum"] as const;
export type ExtensionType = (typeof EXTENSION_TYPES)[number];

// One config-declared frontmatter field beyond Daftari's built-in set. Parsed
// from the optional `schema_extensions` block of .daftari/config.yaml.
export interface SchemaExtension {
  field: string;
  type: ExtensionType;
  required: boolean;
  default?: ExtensionValue;
  enum?: string[]; // present iff type === "enum"
  items?: "string"; // present iff type === "array"
  pattern?: string; // present only for type === "string"
}

// Recognised values of `embeddings.provider`. The vault owner picks one;
// the runtime instantiates the matching backend (see search/vector.ts
// getProvider). Adding a third provider would mean a new id here AND a new
// branch in getProvider AND a config-load check if it needs env vars.
export const EMBEDDING_PROVIDERS = ["local-minilm", "openai-3-small"] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDERS)[number];

// Budgets and attribution for the sleep tension-scan dream (`daftari sleep
// --dream tension-scan`). All values are HARD requirements on the pass:
// `maxLlmCalls` caps pairwise judgments per pass (the real spend bound),
// `maxDocs` caps candidate documents per pass, `agent` is the loggedBy
// identity stamped on every tension the scan records. Config-absent ⇒ the
// defaults below; a malformed block fails loud like every other block.
export interface TensionScanConfig {
  maxLlmCalls: number;
  maxDocs: number;
  agent: string;
}

// Defaults sized from the langgraph-store demo: 49 notes ⇒ 194 pairwise
// judgments (~$2 on a frontier judge), so 200 calls covers a ~50-doc pass.
export const TENSION_SCAN_DEFAULTS: TensionScanConfig = {
  maxLlmCalls: 200,
  maxDocs: 50,
  agent: "agent:sleep-tension-scan",
};

export interface DaftariConfig {
  roles: Record<string, RoleConfig>;
  schemaExtensions: SchemaExtension[];
  // Vault-owner-supplied pre-write hooks. v1 lists pre-write only; future
  // hook surfaces (read-time, post-write) would extend this block. See the
  // README "Vault hooks" section for the trust model.
  hooks: HookConfig;
  // When false, write tools skip the auto-commit step — the file is still
  // written, indexed, and provenance-logged, but the caller owns git. Defaults
  // to true: a standalone vault's git history *is* its document history.
  autoCommit: boolean;
  // When true (the default), the server starts an fs.watch loop over the
  // vault root and re-indexes documents on out-of-band edits (an editor save,
  // a sync engine, a scripted writer). Set false to disable — useful for
  // read-only or batch-script environments where the watcher's debounce
  // timers and chokidar handles are pure overhead. The startup freshness
  // check (manifest mtimes vs disk) still runs regardless and remains the
  // reconciliation backstop when events are dropped.
  watch: boolean;
  // When true, the server kicks off a background load of the embedding model
  // after startup so the first user search doesn't pay the cold-start cost.
  // When false, the model loads lazily only on the first miss — useful for
  // read-only roles that never embed or for very low-memory environments.
  // Defaults to true.
  warmEmbeddings: boolean;
  // Embedding backend selection. "local-minilm" (default) is free and runs
  // entirely on local CPU; "openai-3-small" calls OpenAI's
  // text-embedding-3-small endpoint (requires OPENAI_API_KEY in env). The
  // embeddings cache is keyed by (content_hash, model), so switching
  // providers preserves both side's rows — the new provider populates a
  // fresh row set on first reindex, and switching back reuses the old.
  embeddingProvider: EmbeddingProviderId;
  // Optional git-author → identity mapping consumed by `daftari backfill`
  // (§11.1) when deriving the `updated_by` frontmatter field from a doc's git
  // history. Keys are raw git author names (`%aN`); values are Daftari
  // identities (e.g. `human:mihir`). A git author absent from the map falls
  // back to a slugified `human:<author>` default. Empty when the optional
  // `backfill.identity_map` block is absent.
  backfillIdentityMap: Record<string, string>;
  // Shadow-mode execution path (spec §11.5). When true, every doc-write tool
  // computes the do(), its impact I, and the proposed diff, logs them to
  // .daftari/shadow-actions.jsonl, and writes NOTHING — the calibration
  // posture Decision 3 (§10.4) requires before the loop ever acts live.
  // Defaults to false: a normal vault writes normally.
  shadowMode: boolean;
  // Whether `shadow_mode` was EXPLICITLY declared in config (vs defaulted).
  // The consolidate loop refuses live writes (mode != scan) unless the operator
  // has made an explicit choice, so a surprising default can't spend or mutate.
  shadowModeSet: boolean;
  // Absolute path to an external git directory (git's --separate-git-dir), or
  // undefined for a normal in-vault .git. Lets a cloud-synced vault hold only a
  // static `.git` file while git's churn lives off-cloud. Always resolved
  // outside the vault.
  gitDir?: string;
  // Sleep tension-scan budgets/attribution (`tension_scan` block). Always
  // populated — defaults when the block is absent.
  tensionScan: TensionScanConfig;
}

// A config with no roles and no extensions. Returned for a missing or empty
// config file — both are valid, not malformed.
function emptyConfig(): DaftariConfig {
  return {
    roles: {},
    schemaExtensions: [],
    hooks: { preWrite: [], preWriteTransform: [] },
    autoCommit: true,
    watch: true,
    warmEmbeddings: true,
    embeddingProvider: "local-minilm",
    backfillIdentityMap: {},
    shadowMode: false,
    shadowModeSet: false,
    gitDir: undefined,
    tensionScan: { ...TENSION_SCAN_DEFAULTS },
  };
}

export function configPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "config.yaml");
}

function asStringArray(value: unknown, where: string): Result<string[], Error> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) {
    return err(new Error(`${where} must be a list`));
  }
  for (const item of value) {
    if (typeof item !== "string") {
      return err(new Error(`${where} must contain only strings`));
    }
  }
  return ok(value as string[]);
}

function validateRole(name: string, raw: unknown): Result<RoleConfig, Error> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err(new Error(`role '${name}' must be a mapping`));
  }
  const obj = raw as Record<string, unknown>;

  const read = asStringArray(obj.read, `role '${name}' read`);
  if (!read.ok) return read;
  const write = asStringArray(obj.write, `role '${name}' write`);
  if (!write.ok) return write;

  let promote = false;
  if (obj.promote !== undefined) {
    if (typeof obj.promote !== "boolean") {
      return err(new Error(`role '${name}' promote must be true or false`));
    }
    promote = obj.promote;
  }

  let ratify = false;
  if (obj.ratify !== undefined) {
    if (typeof obj.ratify !== "boolean") {
      return err(new Error(`role '${name}' ratify must be true or false`));
    }
    ratify = obj.ratify;
  }

  let proposeOnly = false;
  if (obj.propose_only !== undefined) {
    if (typeof obj.propose_only !== "boolean") {
      return err(new Error(`role '${name}' propose_only must be true or false`));
    }
    proposeOnly = obj.propose_only;
  }

  // Contradictory grants fail loud at load: a propose-only role proposes, it
  // does not decide. Allowing both would let vault_ratify's write dispatch be
  // coerced back into a NEW proposal while marking the original ratified.
  if (proposeOnly && ratify) {
    return err(
      new Error(
        `role '${name}' cannot set both ratify and propose_only — a ` +
          `propose-only role proposes, it does not decide`,
      ),
    );
  }
  if (proposeOnly && promote) {
    return err(
      new Error(
        `role '${name}' cannot set both promote and propose_only — promotion ` +
          `is a direct write, which propose-only forbids`,
      ),
    );
  }

  return ok({
    read: read.value,
    write: write.value,
    promote,
    ratify,
    ...(proposeOnly ? { proposeOnly } : {}),
  });
}

// Checks a declared `default` value against its extension type. A default
// that cannot hold the declared type is a malformed declaration — config
// errors are loud. Dates are normalised to a YYYY-MM-DD string.
function validateDefault(
  where: string,
  type: ExtensionType,
  value: unknown,
  enumValues: string[] | undefined,
): Result<ExtensionValue, Error> {
  const bad = (expected: string): Result<ExtensionValue, Error> =>
    err(new Error(`${where}: 'default' must be ${expected}`));

  switch (type) {
    case "string":
      return typeof value === "string" ? ok(value) : bad("a string");
    case "date": {
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return ok(value.toISOString().slice(0, 10));
      }
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return ok(value);
      return bad("a YYYY-MM-DD date");
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? ok(value) : bad("a number");
    case "boolean":
      return typeof value === "boolean" ? ok(value) : bad("true or false");
    case "array": {
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        return ok(value as string[]);
      }
      return bad("a list of strings");
    }
    case "enum":
      return typeof value === "string" && (enumValues ?? []).includes(value)
        ? ok(value)
        : bad(`one of the declared enum values [${(enumValues ?? []).join(", ")}]`);
  }
}

// Validates one entry of the `schema_extensions` block. A malformed
// declaration fails config load — the same loud-failure contract as RBAC.
function validateExtension(field: string, raw: unknown): Result<SchemaExtension, Error> {
  const where = `schema_extensions '${field}'`;
  // An extension adds a field; it must not reuse a built-in field name —
  // doing so would let the extension silently override the built-in on write.
  if ((BUILTIN_FRONTMATTER_FIELDS as readonly string[]).includes(field)) {
    return err(new Error(`${where} shadows a built-in frontmatter field`));
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err(new Error(`${where} must be a mapping`));
  }
  const obj = raw as Record<string, unknown>;

  const rawType = obj.type;
  if (typeof rawType !== "string" || !(EXTENSION_TYPES as readonly string[]).includes(rawType)) {
    return err(
      new Error(
        `${where}: unknown type ${JSON.stringify(rawType)} ` +
          `(expected one of ${EXTENSION_TYPES.join(", ")})`,
      ),
    );
  }
  const type = rawType as ExtensionType;

  let required = false;
  if (obj.required !== undefined) {
    if (typeof obj.required !== "boolean") {
      return err(new Error(`${where}: 'required' must be true or false`));
    }
    required = obj.required;
  }

  // enum — required for type 'enum', forbidden otherwise.
  let enumValues: string[] | undefined;
  if (type === "enum") {
    const e = obj.enum;
    if (!Array.isArray(e) || e.length === 0) {
      return err(new Error(`${where}: type 'enum' requires a non-empty 'enum' list`));
    }
    if (!e.every((v) => typeof v === "string")) {
      return err(new Error(`${where}: 'enum' values must be strings`));
    }
    enumValues = e as string[];
  } else if (obj.enum !== undefined) {
    return err(new Error(`${where}: 'enum' is only valid for type 'enum'`));
  }

  // items — required for type 'array', forbidden otherwise. v1 is string-only.
  let items: "string" | undefined;
  if (type === "array") {
    if (obj.items !== "string") {
      return err(
        new Error(`${where}: type 'array' requires 'items: string' (v1 supports array<string>)`),
      );
    }
    items = "string";
  } else if (obj.items !== undefined) {
    return err(new Error(`${where}: 'items' is only valid for type 'array'`));
  }

  // pattern — optional, valid only for type 'string'.
  let pattern: string | undefined;
  if (obj.pattern !== undefined) {
    if (type !== "string") {
      return err(new Error(`${where}: 'pattern' is only valid for type 'string'`));
    }
    if (typeof obj.pattern !== "string") {
      return err(new Error(`${where}: 'pattern' must be a string`));
    }
    try {
      new RegExp(obj.pattern);
    } catch {
      return err(new Error(`${where}: 'pattern' is not a valid regular expression`));
    }
    // The pattern is run against caller-supplied frontmatter on the write path;
    // a backtracking-prone pattern would be a synchronous-regex DoS lever.
    if (hasCatastrophicBacktracking(obj.pattern)) {
      return err(
        new Error(
          `${where}: 'pattern' risks catastrophic backtracking (ReDoS) — ` +
            "avoid nested or overlapping quantifiers such as (a+)+ or (a|a)*",
        ),
      );
    }
    pattern = obj.pattern;
  }

  let defaultValue: ExtensionValue | undefined;
  if (obj.default !== undefined) {
    const checked = validateDefault(where, type, obj.default, enumValues);
    if (!checked.ok) return checked;
    defaultValue = checked.value;
  }

  // A default that violates its own field's pattern would be written silently
  // when the field is absent — catch it at config load.
  if (pattern && typeof defaultValue === "string" && !new RegExp(pattern).test(defaultValue)) {
    return err(new Error(`${where}: 'default' does not match 'pattern' /${pattern}/`));
  }

  const ext: SchemaExtension = { field, type, required };
  if (enumValues) ext.enum = enumValues;
  if (items) ext.items = items;
  if (pattern) ext.pattern = pattern;
  if (defaultValue !== undefined) ext.default = defaultValue;
  return ok(ext);
}

// Parses the optional `schema_extensions` block into an ordered list. The
// declaration order is preserved — serialization relies on it.
function validateExtensions(raw: unknown): Result<SchemaExtension[], Error> {
  if (raw === undefined) return ok([]);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err(new Error("'schema_extensions' must be a mapping"));
  }
  const out: SchemaExtension[] = [];
  for (const [field, decl] of Object.entries(raw as Record<string, unknown>)) {
    const ext = validateExtension(field, decl);
    if (!ext.ok) return ext;
    out.push(ext.value);
  }
  return ok(out);
}

// Recognised child keys of the `hooks` block. Anything else is a loud config
// error so a typo can't silently shadow a hook surface.
const RECOGNISED_HOOK_KEYS = ["pre_write", "pre_write_transform"] as const;

// Parses one hook list (`pre_write` or `pre_write_transform`) from the `hooks`
// block into an ordered list of declarations. A missing key yields an empty
// list; a non-list, or an entry without a non-empty `path`, fails loud.
function parseHookList(
  obj: Record<string, unknown>,
  key: string,
): Result<HookDeclaration[], Error> {
  const out: HookDeclaration[] = [];
  const raw = obj[key];
  if (raw === undefined) return ok(out);
  if (!Array.isArray(raw)) {
    return err(new Error(`'hooks.${key}' must be a list`));
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return err(new Error(`'hooks.${key}[${i}]' must be a mapping`));
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== "string" || e.path.length === 0) {
      return err(new Error(`'hooks.${key}[${i}].path' must be a non-empty string`));
    }
    out.push({ path: e.path });
  }
  return ok(out);
}

// Parses the optional `hooks` block. Two child keys are recognised:
// `pre_write` (validators that run after schema validation) and
// `pre_write_transform` (transforms that run before it). Each is an ordered
// list of mappings, each with a vault-root-relative `path`. Declaration order
// is preserved within each list — hook execution honours it. A missing block
// yields an empty hook config; a malformed block fails loud, same as schema
// extensions.
function validateHooks(raw: unknown): Result<HookConfig, Error> {
  if (raw === undefined) return ok({ preWrite: [], preWriteTransform: [] });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err(new Error("'hooks' must be a mapping"));
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!(RECOGNISED_HOOK_KEYS as readonly string[]).includes(key)) {
      return err(new Error(`'hooks.${key}' is not a recognised hook surface`));
    }
  }

  const preWrite = parseHookList(obj, "pre_write");
  if (!preWrite.ok) return preWrite;
  const preWriteTransform = parseHookList(obj, "pre_write_transform");
  if (!preWriteTransform.ok) return preWriteTransform;

  return ok({ preWrite: preWrite.value, preWriteTransform: preWriteTransform.value });
}

// Parses the optional `backfill` block, returning its `identity_map` as a
// flat string→string record. A missing block yields an empty map. The block,
// the map, and every entry must be the right shape — a malformed declaration
// fails config load, the same loud-failure contract as RBAC and extensions.
function validateBackfillIdentityMap(raw: unknown): Result<Record<string, string>, Error> {
  if (raw === undefined) return ok({});
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err(new Error("'backfill' must be a mapping"));
  }
  const block = raw as Record<string, unknown>;
  const rawMap = block.identity_map;
  if (rawMap === undefined) return ok({});
  if (rawMap === null || typeof rawMap !== "object" || Array.isArray(rawMap)) {
    return err(new Error("'backfill.identity_map' must be a mapping"));
  }
  const out: Record<string, string> = {};
  for (const [author, identity] of Object.entries(rawMap as Record<string, unknown>)) {
    if (typeof identity !== "string" || identity.length === 0) {
      return err(new Error(`'backfill.identity_map.${author}' must be a non-empty string`));
    }
    out[author] = identity;
  }
  return ok(out);
}

// Parses the optional `tension_scan` block. Missing block ⇒ defaults; a
// declared key must hold the right shape (positive integers, non-empty
// agent string) — the same loud-failure contract as every other block. An
// unrecognised child key fails loud so a typo can't silently leave a budget
// at its default.
const RECOGNISED_TENSION_SCAN_KEYS = ["max_llm_calls", "max_docs", "agent"] as const;

function validateTensionScan(raw: unknown): Result<TensionScanConfig, Error> {
  if (raw === undefined) return ok({ ...TENSION_SCAN_DEFAULTS });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err(new Error("'tension_scan' must be a mapping"));
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(RECOGNISED_TENSION_SCAN_KEYS as readonly string[]).includes(key)) {
      return err(new Error(`'tension_scan.${key}' is not a recognised setting`));
    }
  }
  const out: TensionScanConfig = { ...TENSION_SCAN_DEFAULTS };
  for (const key of ["max_llm_calls", "max_docs"] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return err(new Error(`'tension_scan.${key}' must be a positive integer`));
    }
    if (key === "max_llm_calls") out.maxLlmCalls = v;
    else out.maxDocs = v;
  }
  if (obj.agent !== undefined) {
    if (typeof obj.agent !== "string" || obj.agent.trim().length === 0) {
      return err(new Error("'tension_scan.agent' must be a non-empty string"));
    }
    out.agent = obj.agent.trim();
  }
  return ok(out);
}

function dataHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Resolves the optional `git_dir` value to an absolute path OUTSIDE the vault,
// or undefined when absent. `external` derives a stable per-vault path under the
// data home; anything else is a filesystem path (~ expanded, relative paths
// resolved against the vault root). A value inside the vault, or a non-string,
// is a loud config error.
function resolveGitDir(raw: unknown, vaultRoot: string): Result<string | undefined, Error> {
  if (raw === undefined || raw === null) return ok(undefined);
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return err(new Error("malformed config: 'git_dir' must be a non-empty string"));
  }
  const vaultAbs = resolve(vaultRoot);
  const gitDirAbs =
    raw === "external"
      ? join(dataHome(), "daftari", "git", sha256Hex(vaultAbs).slice(0, 16))
      : resolve(vaultAbs, expandTilde(raw));
  const rel = relative(vaultAbs, gitDirAbs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return err(
      new Error(`malformed config: 'git_dir' must resolve outside the vault (got ${gitDirAbs})`),
    );
  }
  return ok(gitDirAbs);
}

// mtime-keyed cache for loadConfig (finding E2). loadConfig sits on the write
// hot path — 7 call sites in tools/write.ts invoke it per handler while the
// write lock is held, each doing a readFileSync + full YAML parse + full
// validation. The config is effectively static between edits, so we memoise the
// parsed+validated Result keyed by the resolved config path, invalidating when
// the file's mtime changes or the file appears/disappears. A cheap statSync
// replaces the read+parse+validate on the common hit path.
//
// The `mtimeMs` sentinel `null` marks the "file absent" state, so a config that
// disappears and later reappears (or vice-versa) busts the cache correctly —
// statSync throwing ENOENT is itself a cache key, distinct from any real mtime.
// The server already fs-watches the vault, but this cache must never serve a
// stale config across an edit; an mtime bump is what busts it.
interface ConfigCacheEntry {
  mtimeMs: number | null;
  result: Result<DaftariConfig, Error>;
}
const configCache = new Map<string, ConfigCacheEntry>();

// Test-only hook: clears the memoised config so a suite can exercise fresh
// loads without leaking cache state across cases. Not part of the runtime path.
export function clearConfigCache(): void {
  configCache.clear();
}

// Loads and validates the vault's RBAC config. A missing file is not an error
// — it produces an empty role set. A file that parses but violates the schema,
// or fails to parse at all, returns Result.err so the server can refuse to
// start.
//
// The parsed+validated result is memoised keyed by the resolved config path and
// the file's mtime (finding E2). An unchanged file returns the cached Result
// after only a statSync; a changed, appearing, or disappearing file busts the
// entry and re-parses. Validation behaviour is identical to a fresh load — the
// cache only skips repeated work for a byte-identical file.
export function loadConfig(vaultRoot: string): Result<DaftariConfig, Error> {
  const path = configPath(vaultRoot);
  const key = resolve(path);

  let mtimeMs: number | null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (e) {
    // A missing file is the empty-config case; any other stat error falls
    // through to loadConfigUncached, which reports it via readFileSync.
    mtimeMs = (e as NodeJS.ErrnoException).code === "ENOENT" ? null : Number.NaN;
  }

  const cached = configCache.get(key);
  // A NaN mtime (non-ENOENT stat error) never satisfies `===`, so such a case
  // always re-parses rather than serving a stale hit.
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    return cached.result;
  }

  const result = loadConfigUncached(vaultRoot);
  configCache.set(key, { mtimeMs, result });
  return result;
}

// The full read + parse + validate. Kept as a separate function so loadConfig
// can wrap it with the mtime cache without changing any validation logic.
function loadConfigUncached(vaultRoot: string): Result<DaftariConfig, Error> {
  let text: string;
  try {
    text = readFileSync(configPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return ok(emptyConfig());
    }
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read config: ${reason}`));
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`malformed config: invalid YAML: ${reason}`));
  }

  if (parsed === null || parsed === undefined) {
    return ok(emptyConfig());
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return err(new Error("malformed config: root must be a mapping"));
  }
  const root = parsed as Record<string, unknown>;

  const roles: Record<string, RoleConfig> = {};
  const rawRoles = root.roles;
  if (rawRoles !== undefined) {
    if (rawRoles === null || typeof rawRoles !== "object" || Array.isArray(rawRoles)) {
      return err(new Error("malformed config: 'roles' must be a mapping"));
    }
    for (const [name, raw] of Object.entries(rawRoles as Record<string, unknown>)) {
      const role = validateRole(name, raw);
      if (!role.ok) return err(new Error(`malformed config: ${role.error.message}`));
      roles[name] = role.value;
    }
  }

  const extensions = validateExtensions(root.schema_extensions);
  if (!extensions.ok) return err(new Error(`malformed config: ${extensions.error.message}`));

  const hooks = validateHooks(root.hooks);
  if (!hooks.ok) return err(new Error(`malformed config: ${hooks.error.message}`));

  const backfillIdentityMap = validateBackfillIdentityMap(root.backfill);
  if (!backfillIdentityMap.ok) {
    return err(new Error(`malformed config: ${backfillIdentityMap.error.message}`));
  }

  let autoCommit = true;
  if (root.auto_commit !== undefined) {
    if (typeof root.auto_commit !== "boolean") {
      return err(new Error("malformed config: 'auto_commit' must be true or false"));
    }
    autoCommit = root.auto_commit;
  }

  const gitDir = resolveGitDir(root.git_dir, vaultRoot);
  if (!gitDir.ok) return gitDir;

  const tensionScan = validateTensionScan(root.tension_scan);
  if (!tensionScan.ok) return err(new Error(`malformed config: ${tensionScan.error.message}`));

  let watch = true;
  if (root.watch !== undefined) {
    if (typeof root.watch !== "boolean") {
      return err(new Error("malformed config: 'watch' must be true or false"));
    }
    watch = root.watch;
  }

  let warmEmbeddings = true;
  if (root.warm_embeddings !== undefined) {
    if (typeof root.warm_embeddings !== "boolean") {
      return err(new Error("malformed config: 'warm_embeddings' must be true or false"));
    }
    warmEmbeddings = root.warm_embeddings;
  }

  let shadowMode = false;
  const shadowModeSet = root.shadow_mode !== undefined;
  if (shadowModeSet) {
    if (typeof root.shadow_mode !== "boolean") {
      return err(new Error("malformed config: 'shadow_mode' must be true or false"));
    }
    shadowMode = root.shadow_mode;
  }

  // Embedding provider selection. Defaults to local-minilm. Unknown ids fail
  // loud — the trust model is "vault owner configures the server" so a typo
  // is a config error, not a fall-through to default. The OPENAI_API_KEY
  // check happens here too: a paid provider with no key in env can't quietly
  // degrade to lexical-only after every search; the vault owner needs to
  // know at startup that the key is missing.
  let embeddingProvider: EmbeddingProviderId = "local-minilm";
  if (root.embeddings !== undefined) {
    if (
      root.embeddings === null ||
      typeof root.embeddings !== "object" ||
      Array.isArray(root.embeddings)
    ) {
      return err(new Error("malformed config: 'embeddings' must be a mapping"));
    }
    const block = root.embeddings as Record<string, unknown>;
    if (block.provider !== undefined) {
      if (typeof block.provider !== "string") {
        return err(new Error("malformed config: 'embeddings.provider' must be a string"));
      }
      if (!(EMBEDDING_PROVIDERS as readonly string[]).includes(block.provider)) {
        return err(
          new Error(
            `malformed config: unknown embeddings.provider ${JSON.stringify(block.provider)} ` +
              `(expected one of ${EMBEDDING_PROVIDERS.join(", ")})`,
          ),
        );
      }
      embeddingProvider = block.provider as EmbeddingProviderId;
    }
  }
  if (embeddingProvider === "openai-3-small" && !process.env.OPENAI_API_KEY) {
    return err(
      new Error(
        "embeddings.provider is 'openai-3-small' but OPENAI_API_KEY is not set in the environment",
      ),
    );
  }

  return ok({
    roles,
    schemaExtensions: extensions.value,
    hooks: hooks.value,
    autoCommit,
    watch,
    warmEmbeddings,
    embeddingProvider,
    backfillIdentityMap: backfillIdentityMap.value,
    shadowMode,
    shadowModeSet,
    gitDir: gitDir.value,
    tensionScan: tensionScan.value,
  });
}
