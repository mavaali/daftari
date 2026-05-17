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
import { err, ok, type Result } from "../frontmatter/types.js";

// Permissions for a single role. `read` / `write` are collection names; the
// wildcard "*" matches every collection. `promote` gates draft→canonical.
export interface RoleConfig {
  read: string[];
  write: string[];
  promote: boolean;
}

export interface DaftariConfig {
  roles: Record<string, RoleConfig>;
}

export function configPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "config.yaml");
}

function asStringArray(
  value: unknown,
  where: string,
): Result<string[], Error> {
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

function validateRole(
  name: string,
  raw: unknown,
): Result<RoleConfig, Error> {
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
      return ok({ roles: {} });
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
    return ok({ roles: {} });
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return err(new Error("malformed config: root must be a mapping"));
  }

  const rawRoles = (parsed as Record<string, unknown>).roles;
  if (rawRoles === undefined) {
    return ok({ roles: {} });
  }
  if (
    rawRoles === null ||
    typeof rawRoles !== "object" ||
    Array.isArray(rawRoles)
  ) {
    return err(new Error("malformed config: 'roles' must be a mapping"));
  }

  const roles: Record<string, RoleConfig> = {};
  for (const [name, raw] of Object.entries(
    rawRoles as Record<string, unknown>,
  )) {
    const role = validateRole(name, raw);
    if (!role.ok) return err(new Error(`malformed config: ${role.error.message}`));
    roles[name] = role.value;
  }

  return ok({ roles });
}
