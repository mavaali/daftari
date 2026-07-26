// Vault walk shared by `daftari schema infer` and `daftari schema diff`. Reads
// every markdown doc's raw frontmatter (pre-validation, exactly as parsed from
// YAML) — infer and diff both build on this single pass rather than each
// re-reading the vault.

import { parseDocument } from "../frontmatter/parser.js";
import { ok, type Result } from "../frontmatter/types.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import type { ScannedDoc } from "./types.js";

// The folder a doc belongs to: its first path component. Root-level docs
// (no `/`) have no folder and yield "".
export function scopeOf(relPath: string): string {
  const slash = relPath.indexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

export interface ScanResult {
  docs: ScannedDoc[];
  skipped: { path: string; reason: string }[];
}

export interface ScanOptions {
  scope?: string;
}

// Walks the vault (or one folder), returning every doc's raw frontmatter. A
// doc that can't be read or whose YAML is malformed is skipped and recorded —
// schema inference is best-effort across the vault, not blocked by one bad
// file.
export async function scanVault(
  vaultRoot: string,
  opts: ScanOptions = {},
): Promise<Result<ScanResult, Error>> {
  const listed = await listFiles(vaultRoot);
  if (!listed.ok) return listed;

  const docs: ScannedDoc[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const relPath of listed.value) {
    const scope = scopeOf(relPath);
    if (opts.scope !== undefined && scope !== opts.scope) continue;

    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) {
      skipped.push({ path: relPath, reason: resolved.error.message });
      continue;
    }
    const source = await readFile(resolved.value.absPath);
    if (!source.ok) {
      skipped.push({ path: relPath, reason: source.error.message });
      continue;
    }
    const parsed = parseDocument(source.value);
    if (!parsed.ok) {
      skipped.push({ path: relPath, reason: parsed.error.message });
      continue;
    }
    docs.push({ relPath, scope, raw: parsed.value.raw });
  }

  return ok({ docs, skipped });
}
