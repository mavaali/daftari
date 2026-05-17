// Role-based access control.
//
// Permissions are config-driven (.daftari/config.yaml) — Daftari has no user
// management system of its own. A running server holds one AccessContext: the
// --user / --role it was started with, resolved against the loaded config.
//
// The model fails safe. A role that does not exist in the config, or a server
// started without --role, resolves to a null role — the implicit "guest" —
// which is denied everything. Tools never grant access on a missing rule.

import type { DaftariConfig, RoleConfig } from "../utils/config.js";

export const GUEST_ROLE = "guest";
export const WILDCARD = "*";

// The access identity a server runs as. `role` is null for the guest / any
// unrecognized role name — the deny-all fallback.
export interface AccessContext {
  user: string;
  roleName: string;
  role: RoleConfig | null;
}

// Resolves a --user / --role pair against the config into an AccessContext. An
// unknown role name yields a null role rather than an error: unknown ⇒ guest
// ⇒ denied, never granted.
export function resolveAccess(
  config: DaftariConfig,
  user: string,
  roleName: string,
): AccessContext {
  return { user, roleName, role: config.roles[roleName] ?? null };
}

// A guest AccessContext — no role, no permissions. Used when the server is
// started without --role.
export function guestAccess(user = "guest"): AccessContext {
  return { user, roleName: GUEST_ROLE, role: null };
}

function permits(list: string[], collection: string): boolean {
  return list.includes(WILDCARD) || list.includes(collection);
}

// True if the role may read documents in `collection`.
export function canRead(role: RoleConfig | null, collection: string): boolean {
  return role !== null && permits(role.read, collection);
}

// True if the role may create/modify documents in `collection`.
export function canWrite(role: RoleConfig | null, collection: string): boolean {
  return role !== null && permits(role.write, collection);
}

// True if the role may promote a draft to canonical.
export function canPromote(role: RoleConfig | null): boolean {
  return role?.promote ?? false;
}

// True if the role has read access to at least one collection. Curation tools
// (lint, tension log, provenance) are open to anyone with any read grant.
export function hasAnyRead(role: RoleConfig | null): boolean {
  return role !== null && role.read.length > 0;
}

// Keeps only the items in collections the role may read. Each item must carry
// a `collection` field.
export function filterByReadPermission<T extends { collection: string }>(
  role: RoleConfig | null,
  items: T[],
): T[] {
  return items.filter((item) => canRead(role, item.collection));
}
