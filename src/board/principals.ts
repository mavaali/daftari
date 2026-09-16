// principals.ts — configured principal set for board owner / reassign gating.
//
// The principal set is the union of:
//   - server.auth.tokens[].user  (every identity that can authenticate via a
//     static bearer token)
//   - config.principals[]        (an optional explicit list for identities that
//     are known but don't hold bearer tokens, e.g. human operators in stdio mode)
//
// isConfiguredPrincipal is the single gate the U11 reassign path calls.
// Everything resolves from config — no runtime identity inspection.

import type { DaftariConfig } from "../utils/config.js";

// Returns the union of token users and the explicit principals list as a Set.
// An absent block on either side contributes an empty set — the union is always
// well-defined. Exported for tests and for callers that need the full set (e.g.
// to build a pick-list in the board UI).
export function configuredPrincipals(config: DaftariConfig): Set<string> {
  const set = new Set<string>();
  for (const token of config.server.tokens) {
    if (token.user.trim().length > 0) {
      set.add(token.user);
    }
  }
  for (const name of config.principals) {
    if (name.trim().length > 0) {
      set.add(name);
    }
  }
  return set;
}

// Returns true iff `name` is a non-empty, non-whitespace string present in the
// configured principal set. Empty/whitespace names always return false — they
// are not valid identities even if the set is non-empty.
export function isConfiguredPrincipal(config: DaftariConfig, name: string): boolean {
  if (name.trim().length === 0) return false;
  return configuredPrincipals(config).has(name);
}
