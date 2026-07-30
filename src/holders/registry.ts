// Holder registry — maps stamped identity strings to canonical holder ids.
// Many historical strings can point to one holder, so a rename does not forge a
// ghost: "agent:luo-ji" and "agent:luoji" both resolve to the same id without
// creating two competing belief-holders. Unknown strings pass through as their
// own id (identity function), making an empty registry a safe zero-config baseline.

import type { HolderId, HolderRegistry } from "./types.js";

/** Build a registry from config's holderAliases (alias → canonical id). */
export function buildRegistry(holderAliases: Record<string, string> = {}): HolderRegistry {
  return { aliases: new Map(Object.entries(holderAliases)) };
}

/** Canonical holder for a stamped identity string. Unknown strings are their own holder. */
export function resolveHolder(reg: HolderRegistry, identity: string): HolderId {
  return reg.aliases.get(identity) ?? identity;
}

/** True iff the string is an explicitly registered alias (not a passthrough). */
export function isRegistered(reg: HolderRegistry, identity: string): boolean {
  return reg.aliases.has(identity);
}
