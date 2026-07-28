// paths — lexical vault-relative path canonicalization shared by the search
// and curation layers, plus realpath-based filesystem confinement shared by
// the audit and citation-anchor classifiers.

import { realpathSync } from "node:fs";
import { isAbsolute, relative as nodeRelative, posix } from "node:path";

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

// Realpath-based filesystem confinement: true iff targetAbs exists AND its
// REAL location sits under rootAbs. realpathSync resolves every path
// component, so a symlink committed inside an audited/referenced tree
// (escape -> /) cannot route the probe outside the containment root — a
// lexical check plus a bare existsSync would (security review on #255).
// rootAbs is expected to be already-real: repo roots are realpathSync'd at
// config load, and the parent prefix of a real path is itself real.
// A nonexistent target makes realpathSync throw ENOENT -> false, which is
// exactly the "missing" answer.
//
// Originally `src/audit/collect.ts#symlinkSafeExistsWithin`; lifted here
// (2026-07-26 citation-anchors-jit spec, C5) so the anchor classifier
// (src/anchors/classify.ts) shares the same confinement primitive instead of
// growing a second, lexical-only implementation. Re-exported from
// collect.ts for existing callers.
export function symlinkSafeExistsWithin(rootAbs: string, targetAbs: string): boolean {
  let real: string;
  try {
    real = realpathSync(targetAbs);
  } catch {
    return false;
  }
  const rel = nodeRelative(rootAbs, real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
