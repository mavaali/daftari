// Shared vault-document loading and in-vault link helpers.
//
// Extracted from lint.ts so the same loader and link-resolution machinery can
// back any curation surface that needs the full set of vault docs plus a
// reverse-link view (lint, tension blast radius). Keeps the link-extraction
// regexes and the path-normalisation rules in one place so the two callers
// can't drift apart.

import { stat } from "node:fs/promises";
import { posix } from "node:path";
import { parseDocument } from "../frontmatter/parser.js";
import { type Frontmatter, ok, type Result, type ValidationReport } from "../frontmatter/types.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";

export interface LoadedDoc {
  path: string;
  frontmatter: Frontmatter;
  content: string;
  // The schema-validation report from the SAME parse pass that produced
  // `frontmatter`. Carried so downstream consumers (e.g. the consolidate
  // envelope's provenance check) can tell schema-valid from schema-invalid
  // frontmatter without re-reading or re-parsing the file. `content` is the
  // body only (frontmatter stripped), so validation cannot be recovered from
  // it alone — that is why we surface it here.
  validation: ValidationReport;
}

const DEFAULT_IDLE_MS = 60_000;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  doc: LoadedDoc;
}

interface VaultCache {
  entries: Map<string, CacheEntry>;
  inflight: Promise<Result<LoadedDoc[], Error>> | null;
  idleTimer: NodeJS.Timeout | null;
}

const caches = new Map<string, VaultCache>();

// Test seams (mirrors watcher.ts's injectable hooks). Production defaults; a
// test swaps these to count parses, inject stat results, or shrink the idle
// window. Never mutated by production code.
export const docCacheTestHooks = {
  idleMs: DEFAULT_IDLE_MS,
  statFn: async (absPath: string): Promise<{ mtimeMs: number; size: number }> => {
    const s = await stat(absPath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  },
  parseFn: parseDocument,
};

// Drops every cached vault (and its idle timers). Test-only; production relies
// on idle-eviction. Exported so a test's afterEach can guarantee isolation.
export function resetDocumentCache(): void {
  for (const c of caches.values()) {
    if (c.idleTimer) clearTimeout(c.idleTimer);
  }
  caches.clear();
}

function getCache(vaultRoot: string): VaultCache {
  let c = caches.get(vaultRoot);
  if (!c) {
    c = { entries: new Map(), inflight: null, idleTimer: null };
    caches.set(vaultRoot, c);
  }
  return c;
}

// Re-reads only what changed. Byte-freshness comes from the {mtimeMs,size}
// fingerprint: any content change moves at least one of them (the sole
// accepted miss is a same-mtime-tick edit that also preserves byte length).
async function refresh(vaultRoot: string, c: VaultCache): Promise<Result<LoadedDoc[], Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  // Fingerprint pass: resolve + stat every listed path in parallel. stat holds
  // no file descriptor, so a wide Promise.all is safe on large vaults. A
  // resolve or stat failure yields a null fingerprint => the path is treated as
  // changed (re-read attempt below, which then skips on its own failure).
  const probed = await Promise.all(
    list.value.map(async (relPath) => {
      const resolved = resolveVaultPath(vaultRoot, relPath);
      if (!resolved.ok) return { relPath, absPath: null, fp: null };
      try {
        const fp = await docCacheTestHooks.statFn(resolved.value.absPath);
        return { relPath, absPath: resolved.value.absPath, fp };
      } catch {
        return { relPath, absPath: resolved.value.absPath, fp: null };
      }
    }),
  );

  const nextEntries = new Map<string, CacheEntry>();
  const docs: LoadedDoc[] = [];

  for (const { relPath, absPath, fp } of probed) {
    if (fp) {
      const prior = c.entries.get(relPath);
      if (prior && prior.mtimeMs === fp.mtimeMs && prior.size === fp.size) {
        nextEntries.set(relPath, prior);
        docs.push(prior.doc);
        continue;
      }
    }
    // changed / new / unresolvable / un-stattable: re-read + parse, skipping on
    // any failure exactly as the pre-cache loadDocuments did (never cached).
    if (!absPath) continue;
    const file = await readFile(absPath);
    if (!file.ok) continue;
    const parsed = docCacheTestHooks.parseFn(file.value);
    if (!parsed.ok) continue;
    const doc: LoadedDoc = {
      path: relPath,
      frontmatter: parsed.value.frontmatter,
      content: parsed.value.content,
      validation: parsed.value.validation,
    };
    if (fp) nextEntries.set(relPath, { mtimeMs: fp.mtimeMs, size: fp.size, doc });
    docs.push(doc);
  }

  c.entries = nextEntries;
  return ok(docs);
}

// Loads every markdown file under the vault root as frontmatter + body. Backed
// by a per-vault incremental cache: only files whose {mtimeMs,size} changed
// since the last call are re-read and re-parsed. Byte-fresh and full-fidelity —
// disk stays the source of truth. Files that fail to resolve, read, or parse
// are silently skipped, so one malformed file never crashes the surface.
export async function loadDocuments(vaultRoot: string): Promise<Result<LoadedDoc[], Error>> {
  const c = getCache(vaultRoot);
  if (c.inflight) return c.inflight;
  c.inflight = refresh(vaultRoot, c);
  try {
    return await c.inflight;
  } finally {
    c.inflight = null;
  }
}

// Pulls every internal link target out of a markdown body: both [[wikilinks]]
// and [text](target) markdown links. External URLs and anchors are dropped.
export function extractLinks(content: string): string[] {
  const targets: string[] = [];

  for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    // A wikilink may carry a |display alias and/or a #heading anchor.
    const raw = (m[1] as string).split("|")[0]?.split("#")[0]?.trim();
    if (raw) targets.push(raw);
  }

  for (const m of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = (m[1] as string).split("#")[0]?.trim();
    if (!raw) continue;
    if (/^(https?:|mailto:|#)/i.test(raw)) continue;
    targets.push(raw);
  }

  return targets;
}

// Resolves a raw link target to a vault-relative path, or null if it points
// nowhere. Tries, in order: the target as-is, with a .md suffix, resolved
// relative to the linking file's directory, then a bare basename match (the
// common [[note-name]] wikilink form).
export function resolveLink(
  rawTarget: string,
  fromPath: string,
  byPath: Set<string>,
  byBasename: Map<string, string>,
): string | null {
  const withMd = (p: string) => (p.endsWith(".md") ? p : `${p}.md`);

  if (byPath.has(rawTarget)) return rawTarget;
  if (byPath.has(withMd(rawTarget))) return withMd(rawTarget);

  const relual = posix.normalize(posix.join(posix.dirname(fromPath), rawTarget));
  if (byPath.has(relual)) return relual;
  if (byPath.has(withMd(relual))) return withMd(relual);

  const base = posix.basename(rawTarget).replace(/\.md$/, "");
  return byBasename.get(base) ?? null;
}

// Precomputes the two indexes resolveLink consults: the set of every known
// vault-relative path, and the basename → path map used for bare-name
// wikilinks. First write wins on basename collisions so the mapping is
// deterministic across runs.
export function buildPathIndexes(docs: Pick<LoadedDoc, "path">[]): {
  byPath: Set<string>;
  byBasename: Map<string, string>;
} {
  const byPath = new Set(docs.map((d) => d.path));
  const byBasename = new Map<string, string>();
  for (const d of docs) {
    const base = posix.basename(d.path).replace(/\.md$/, "");
    if (!byBasename.has(base)) byBasename.set(base, d.path);
  }
  return { byPath, byBasename };
}

// The distinct resolved in-vault link targets of one document body, given the
// known-path universe — the producer side of the materialized inbound-link
// graph (#8, index-db.ts doc_links). Uses the SAME extraction and resolution
// as lint's buildInboundMap, so the inline orphan / deprecated-still-linked
// surfaces can never drift from the vault-global lint findings.
export function outgoingLinkTargets(
  content: string,
  fromPath: string,
  indexes: { byPath: Set<string>; byBasename: Map<string, string> },
): string[] {
  const out = new Set<string>();
  for (const raw of extractLinks(content)) {
    const target = resolveLink(raw, fromPath, indexes.byPath, indexes.byBasename);
    if (target && target !== fromPath) out.add(target);
  }
  return [...out];
}
