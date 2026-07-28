// src/audit/docs-repo.ts
// Resolves the single unambiguous docs repo a flag needs to act on — shared
// by --auto-tension (tension entries land in one vault's .daftari/tensions.md)
// and --pin --apply (pins are written to one vault's markdown files).
// Generalized from the original resolveTensionVault per the 2026-07-26
// citation-anchors-jit plan resolution (C10).

import type { AuditConfig } from "./types.js";

export function resolveSingleDocsRepo(
  config: AuditConfig,
  flagLabel: string,
): string | { error: string } {
  const docsRepos = config.repos.filter((r) => r.type !== "code");
  if (docsRepos.length !== 1) {
    return {
      error: `${flagLabel} requires exactly one docs repo to act on; found ${docsRepos.length}`,
    };
  }
  return (docsRepos[0] as { path: string }).path;
}
