// realpath-confine — symlink-aware path confinement shared by the storage
// backend (#6/F5) and the hook loader (F2). Lexical resolve()/relative()
// confinement cannot see through symlinks: a component under a root may link
// outside it, and a following read/write/import would escape. These helpers
// resolve real paths and re-check confinement, failing closed when a path
// cannot be proven.
//
// This is IO (realpathSync), so it lives apart from the lexical, IO-free
// helpers in utils/paths.ts. The semantics mirror resolveVaultPath in
// storage/local.ts: a symlink that stays inside the root is allowed; one that
// escapes it is rejected.

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";

// The real (symlink-resolved) path of `p`, walking up over not-yet-existing
// tail components so a target whose leaf does not exist yet (e.g. a fresh put)
// still resolves through its real ancestors. Returns null on any non-ENOENT
// error (EACCES/ELOOP/ENOTDIR) — we cannot prove where the path resolves, so
// the caller must reject rather than trust an unverified lexical path.
export function realpathConfined(p: string): string | null {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? resolve(real, ...tail) : real;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = dirname(current);
      if (parent === current) return null; // reached the fs root; nothing resolved
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

// Confine `target` under `root` by realpath'ing BOTH and re-checking that the
// real target stays within the real root. `root` is realpath'd too so a root
// that legitimately sits under a symlinked prefix (e.g. macOS /var → /private/var)
// does not spuriously reject its own children. Returns the (lexical) target on
// success — the caller performs IO on it, having proven it resolves inside.
//
// TOCTOU: the check precedes the IO, so a component swapped to a symlink
// between this call and the IO could still escape. Node offers no
// directory-relative no-follow open here; this closes the durable-symlink
// vector, not a racing attacker with write access to the traversed path.
export function confineRealpath(
  root: string,
  target: string,
  label = "path",
): Result<string, Error> {
  const realRoot = realpathConfined(root);
  const realTarget = realpathConfined(target);
  if (realRoot === null || realTarget === null) {
    return err(new Error(`${label} escapes root: ${target}`));
  }
  const rel = relative(realRoot, realTarget);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return err(new Error(`${label} escapes root: ${target}`));
  }
  return ok(target);
}
