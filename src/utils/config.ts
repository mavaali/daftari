// Loads and validates .daftari/config.yaml — the source of RBAC truth.
//
// The config declares named roles and their per-collection permissions. It is
// loaded once at server start. A malformed config fails loud (Result.err): a
// permission system that silently loads a broken policy is worse than one that
// refuses to start. A *missing* config is not malformed — it just yields an
// empty role set, so every --role resolves to the deny-all guest.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import {
  BUILTIN_FRONTMATTER_FIELDS,
  type ExtensionValue,
  err,
  ok,
  type Result,
} from "../frontmatter/types.js";
import type { HookConfig, HookDeclaration } from "../hooks/types.js";

// Permissions for a single role. `read` / `write` are collection names; the
// wildcard "*" matches every collection. `promote` gates draft→canonical.
export interface RoleConfig {
  read: string[];
  write: string[];
  promote: boolean;
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

  return ok({ read: read.value, write: write.value, promote });
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

// Loads and validates the vault's RBAC config. A missing file is not an error
// — it produces an empty role set. A file that parses but violates the schema,
// or fails to parse at all, returns Result.err so the server can refuse to
// start.
export function loadConfig(vaultRoot: string): Result<DaftariConfig, Error> {
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

  let autoCommit = true;
  if (root.auto_commit !== undefined) {
    if (typeof root.auto_commit !== "boolean") {
      return err(new Error("malformed config: 'auto_commit' must be true or false"));
    }
    autoCommit = root.auto_commit;
  }

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

  return ok({
    roles,
    schemaExtensions: extensions.value,
    hooks: hooks.value,
    autoCommit,
    watch,
    warmEmbeddings,
  });
}
