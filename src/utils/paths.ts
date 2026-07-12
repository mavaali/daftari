// paths — lexical vault-relative path canonicalization shared by the search
// and curation layers.

import { posix } from "node:path";

// Lexical, IO-free canonicalization of a vault-relative path: aliasing
// (`pricing/../pricing/a.md`) must join its canonical hit (#127/#128 class).
// A path that escapes the root normalizes to a `..`-leading form, which can
// never equal an indexed hit path — escapes simply never join. normalize("")
// returns "." — map it back to "" so the missing-source guard in buildByPath
// fires on entries with a blank Source line instead of indexing the valid
// side under a junk "." counterpart.
export function canonicalRel(p: string): string {
  const n = posix.normalize(p.trim().replace(/\\/g, "/"));
  return n === "." ? "" : n.replace(/^\.\//, "");
}
