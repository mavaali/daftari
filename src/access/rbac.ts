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

// True if the role may issue curation verdicts (§11.6): approve/reject staged
// actions and contest derives_from edges. A distinct grant from `promote` —
// ratifying decides someone ELSE's proposed change; the agent principal
// typically proposes (write) but does not ratify.
export function canRatify(role: RoleConfig | null): boolean {
  return role?.ratify ?? false;
}

// True if the role may erase content from the vault's git history (vault_erase,
// R11-R13). The most destructive grant: a history rewrite + force-push is
// irreversible, so it is opt-in and off by default (an absent `erase` key ⇒
// false), distinct from every other capability. A role without it cannot scrub
// history even if it can write or ratify.
export function canErase(role: RoleConfig | null): boolean {
  return role?.erase ?? false;
}

// True if the role may perform human disposition actions on board items (owner
// assignment, reassign). Provisioned true on human operator roles; omitted on
// agent roles. This is the config-declared signal that distinguishes a human
// operator from an agent — AccessContext carries no principal_type.
// (U10/R13/R16 capability gate; used by U11 reassign path.)
export function canDispose(role: RoleConfig | null): boolean {
  return role !== null && role.dispose === true;
}

// True if the role may ask Daftari to stat repo: provenance targets. Kept
// separate from vault read grants: repo_root can include paths outside every
// vault collection, so read:["*"] does not imply filesystem-metadata access.
export function canVerifyRepoSources(role: RoleConfig | null): boolean {
  return role?.verifyRepoSources ?? false;
}

// Connector control routes expose OAuth and webhook-management capabilities,
// so a vault read/write grant alone never implies access to them.
export function canManageIntegrations(role: RoleConfig | null): boolean {
  return role?.manageIntegrations ?? false;
}

// True if the role is propose-only (#235): its writes must land as staged
// `write` proposals, never as direct mutations. vault_write and vault_assert
// coerce into staged proposals; every other write tool denies. The write
// grant still scopes WHICH collections the role may propose into.
export function isProposeOnly(role: RoleConfig | null): boolean {
  return role?.proposeOnly ?? false;
}

// True if the role has read access to at least one collection. Curation tools
// (lint, tension log, provenance) are open to anyone with any read grant.
export function hasAnyRead(role: RoleConfig | null): boolean {
  return role !== null && role.read.length > 0;
}

// The explicit list of collections a role may read, for pushing an ACL filter
// down into a query (the vector KNN — 2026-07-26 fusion spec, Decision 3).
//
// Three cases, and the distinction between the last two is load-bearing:
//   - wildcard read  → undefined, meaning "no filter needed" (reads everything)
//   - a null role    → [], meaning "reads nothing" — the deny-all guest
//   - a scoped role  → its declared collections
// A caller must not collapse [] into undefined: one is a guest who may see
// nothing, the other is an operator with no access context at all.
export function readableCollections(role: RoleConfig | null): string[] | undefined {
  if (role === null) return [];
  if (role.read.includes(WILDCARD)) return undefined;
  return [...role.read];
}

// Keeps only the items in collections the role may read. Each item must carry
// a `collection` field.
export function filterByReadPermission<T extends { collection: string }>(
  role: RoleConfig | null,
  items: T[],
): T[] {
  return items.filter((item) => canRead(role, item.collection));
}
