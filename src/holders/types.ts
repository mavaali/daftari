export type HolderId = string; // e.g. "agent:mavaali", "human:mihir"

export interface HolderRegistry {
  /** alias string → canonical holder id */
  aliases: Map<string, HolderId>;
}

// Populated by the canon resolver (Task 3) and surfaced in CanonFlags.
export interface GhostHolderWarning {
  count: number;
  strings: string[]; // unregistered identity strings encountered
}
