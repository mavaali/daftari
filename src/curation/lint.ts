// vault_lint's engine — advisory cross-vault curation checks.
//
// Lint loads every document once, builds the inter-document link graph, then
// runs five checks. It only ever *reports*: no file is edited, no status is
// changed, nothing is auto-fixed. The output is a structured report grouped by
// check, for a human (or an agent acting on a human's behalf) to triage.

import { posix } from "node:path";
import { parseDocument } from "../frontmatter/parser.js";
import {
  ok,
  type Frontmatter,
  type Result,
} from "../frontmatter/types.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { ageInDays, computeStaleness } from "./staleness.js";

export const LINT_CHECKS = [
  "staleFiles",
  "orphanFiles",
  "oldDrafts",
  "stagnantLowConfidence",
  "deprecatedStillLinked",
] as const;
export type LintCheckName = (typeof LINT_CHECKS)[number];

export interface LintFinding {
  path: string;
  detail: string;
}

export interface LintReport {
  generatedAt: string;
  checks: Record<LintCheckName, LintFinding[]>;
  totalFindings: number;
}

export interface LintOptions {
  now?: Date;
  draftMaxDays?: number; // a draft older than this is flagged
  lowConfidenceMaxDays?: number; // a low-confidence doc unchanged this long is flagged
}

interface LoadedDoc {
  path: string;
  frontmatter: Frontmatter;
  content: string;
}

// --- link extraction ------------------------------------------------------

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
function resolveLink(
  rawTarget: string,
  fromPath: string,
  byPath: Set<string>,
  byBasename: Map<string, string>,
): string | null {
  const withMd = (p: string) => (p.endsWith(".md") ? p : `${p}.md`);

  if (byPath.has(rawTarget)) return rawTarget;
  if (byPath.has(withMd(rawTarget))) return withMd(rawTarget);

  const relual = posix.normalize(
    posix.join(posix.dirname(fromPath), rawTarget),
  );
  if (byPath.has(relual)) return relual;
  if (byPath.has(withMd(relual))) return withMd(relual);

  const base = posix.basename(rawTarget).replace(/\.md$/, "");
  return byBasename.get(base) ?? null;
}

// --- check orchestration --------------------------------------------------

async function loadDocuments(
  vaultRoot: string,
): Promise<Result<LoadedDoc[], Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  const docs: LoadedDoc[] = [];
  for (const relPath of list.value) {
    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) continue;
    const file = await readFile(resolved.value);
    if (!file.ok) continue;
    const parsed = parseDocument(file.value);
    if (!parsed.ok) continue;
    docs.push({
      path: relPath,
      frontmatter: parsed.value.frontmatter,
      content: parsed.value.content,
    });
  }
  return ok(docs);
}

// Maps each document to the set of documents that link to it.
function buildInboundMap(docs: LoadedDoc[]): Map<string, Set<string>> {
  const byPath = new Set(docs.map((d) => d.path));
  const byBasename = new Map<string, string>();
  for (const d of docs) {
    const base = posix.basename(d.path).replace(/\.md$/, "");
    // First write wins, so a basename collision resolves deterministically.
    if (!byBasename.has(base)) byBasename.set(base, d.path);
  }

  const inbound = new Map<string, Set<string>>();
  for (const d of docs) {
    for (const raw of extractLinks(d.content)) {
      const target = resolveLink(raw, d.path, byPath, byBasename);
      if (!target || target === d.path) continue;
      if (!inbound.has(target)) inbound.set(target, new Set());
      (inbound.get(target) as Set<string>).add(d.path);
    }
  }
  return inbound;
}

// Runs every lint check across the vault and returns a grouped report.
export async function runLint(
  vaultRoot: string,
  opts: LintOptions = {},
): Promise<Result<LintReport, Error>> {
  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;
  const docs = loaded.value;

  const now = opts.now ?? new Date();
  const draftMaxDays = opts.draftMaxDays ?? 30;
  const lowConfidenceMaxDays = opts.lowConfidenceMaxDays ?? 30;
  const inbound = buildInboundMap(docs);
  const byPath = new Map(docs.map((d) => [d.path, d]));

  const checks: Record<LintCheckName, LintFinding[]> = {
    staleFiles: [],
    orphanFiles: [],
    oldDrafts: [],
    stagnantLowConfidence: [],
    deprecatedStillLinked: [],
  };

  for (const doc of docs) {
    const fm = doc.frontmatter;

    // 1. Stale: a document at or past its TTL.
    const staleness = computeStaleness(
      { updated: fm.updated, ttl_days: fm.ttl_days },
      now,
    );
    if (staleness.expired) {
      checks.staleFiles.push({
        path: doc.path,
        detail:
          `${staleness.ageDays}d since update, ttl ${staleness.ttlDays}d ` +
          `(decay score ${staleness.score.toFixed(2)})`,
      });
    }

    // 2. Orphan: no other document links to it.
    if (!inbound.has(doc.path)) {
      checks.orphanFiles.push({
        path: doc.path,
        detail: "no inbound links from any vault document",
      });
    }

    // 3. Old draft: still a draft well past the draft age limit.
    if (fm.status === "draft") {
      const anchor = fm.created || fm.updated;
      const draftAge = ageInDays(anchor, now);
      if (draftAge > draftMaxDays) {
        checks.oldDrafts.push({
          path: doc.path,
          detail: `draft for ${draftAge}d (limit ${draftMaxDays}d)`,
        });
      }
    }

    // 4. Stagnant low-confidence: low confidence and untouched too long.
    if (fm.confidence === "low") {
      const idleDays = ageInDays(fm.updated, now);
      if (idleDays >= lowConfidenceMaxDays) {
        checks.stagnantLowConfidence.push({
          path: doc.path,
          detail:
            `low confidence, unchanged for ${idleDays}d ` +
            `(limit ${lowConfidenceMaxDays}d)`,
        });
      }
    }

    // 5. Deprecated but still linked from a canonical document.
    if (fm.status === "deprecated") {
      const linkers = [...(inbound.get(doc.path) ?? [])].filter(
        (from) => byPath.get(from)?.frontmatter.status === "canonical",
      );
      if (linkers.length > 0) {
        checks.deprecatedStillLinked.push({
          path: doc.path,
          detail: `still linked from canonical: ${linkers.sort().join(", ")}`,
        });
      }
    }
  }

  const totalFindings = LINT_CHECKS.reduce(
    (n, name) => n + checks[name].length,
    0,
  );

  return ok({ generatedAt: now.toISOString(), checks, totalFindings });
}
