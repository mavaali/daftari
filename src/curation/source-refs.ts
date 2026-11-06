import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { parseSourceRef } from "../frontmatter/source-ref.js";
import type { DocEdge } from "../storage/index-db.js";
import { outgoingLinkTargets, resolveLink } from "./vault-docs.js";

export type VaultSourceResolution =
  | { kind: "vault"; explicit: boolean; target: string | null }
  | { kind: "non-vault" };

function normalizeExplicitVaultTarget(rawTarget: string): string | null {
  if (
    rawTarget.length === 0 ||
    rawTarget.includes("\\") ||
    rawTarget.startsWith("/") ||
    rawTarget.split("/").includes("..")
  ) {
    return null;
  }
  const normalized = posix.normalize(rawTarget);
  if (normalized === "." || normalized.startsWith("../")) return null;
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

// The normalized root-relative target named by an explicit `vault:` source,
// whether or not that target currently exists. Callers that diagnose absence
// need the candidate path without weakening legacy-source compatibility.
export function explicitVaultSourceTarget(raw: string): string | null {
  const parsed = parseSourceRef(raw);
  return parsed.kind === "vault" ? normalizeExplicitVaultTarget(parsed.target) : null;
}

function resolveExplicitVaultTarget(rawTarget: string, byPath: Set<string>): string | null {
  const target = normalizeExplicitVaultTarget(rawTarget);
  return target !== null && byPath.has(target) ? target : null;
}

// Resolves only the subset of `sources` that are genuine vault dependencies.
// Explicit vault addresses are root-relative and strict. Legacy values use the
// historical resolver, but an unresolved legacy citation remains opaque rather
// than becoming a certain broken-dependency finding.
export function resolveVaultSourceRef(
  raw: string,
  fromPath: string,
  byPath: Set<string>,
  byBasename: Map<string, string | null>,
): VaultSourceResolution {
  const parsed = parseSourceRef(raw);
  if (parsed.kind === "vault") {
    return {
      kind: "vault",
      explicit: true,
      target: resolveExplicitVaultTarget(parsed.target, byPath),
    };
  }
  if (parsed.kind !== "legacy") return { kind: "non-vault" };
  const target = resolveLink(parsed.target, fromPath, byPath, byBasename);
  return target ? { kind: "vault", explicit: false, target } : { kind: "non-vault" };
}

// Whether any `sources` entry could resolve to a vault document. Lets a
// single-document index skip the O(vault) path universe, like write.ts does.
export function hasLocalSourceRef(sources: string[]): boolean {
  return sources.some((raw) => {
    const kind = parseSourceRef(raw).kind;
    return kind === "vault" || kind === "legacy";
  });
}

// The single producer of the inbound-reference graph (#641): lint's in-memory
// map and the materialized doc_links table both read this, so the two orphan
// surfaces cannot drift. Sources resolve exactly as tier0 and tension-blast
// resolve them; self-citations are not edges. `superseded_by` is deliberately
// absent: it is lifecycle routing, not a reference, and counting it would
// un-orphan every successor nothing live cites.
export function outgoingEdges(
  content: string,
  sources: string[],
  fromPath: string,
  indexes: { byPath: Set<string>; byBasename: Map<string, string | null> },
): DocEdge[] {
  const edges: DocEdge[] = outgoingLinkTargets(content, fromPath, indexes).map((target) => ({
    target,
    kind: "link",
  }));
  const cited = new Set<string>();
  for (const raw of sources) {
    const source = resolveVaultSourceRef(raw, fromPath, indexes.byPath, indexes.byBasename);
    const target = source.kind === "vault" ? source.target : null;
    if (target && target !== fromPath) cited.add(target);
  }
  for (const target of cited) edges.push({ target, kind: "source" });
  return edges;
}

// Vault paths a body names in inline code. A code span is literal text, not an
// authored reference (`rm decisions/a.md` matches too), so these are never
// edges: lint only reports them on an orphan as a hint that a real reference
// may be missing. Fenced blocks are skipped for the same reason.
export function backtickedVaultPaths(content: string, byPath: Set<string>): string[] {
  const prose = content.replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1[`~]*\s*$/gm, "");
  const found = new Set<string>();
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    const span = (m[1] as string).trim();
    if (byPath.has(span)) found.add(span);
  }
  return [...found];
}

export type RepoSourceStatus =
  | { status: "exists" }
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "outside_root" }
  | { status: "unavailable" };

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function nearestExistingAncestor(path: string): string | null {
  let cursor = path;
  for (;;) {
    try {
      statSync(cursor);
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

// Metadata-only repository reference verification. The lexical check rejects
// traversal before touching the filesystem; realpath checks then close symlink
// escapes for both existing targets and missing targets below an existing link.
export function verifyRepoSourceRef(repoRoot: string, target: string): RepoSourceStatus {
  if (
    target.length === 0 ||
    target.includes("\\") ||
    isAbsolute(target) ||
    target.split("/").includes("..")
  ) {
    return { status: "invalid" };
  }
  const candidate = resolve(repoRoot, target);
  if (!isContained(resolve(repoRoot), candidate)) return { status: "invalid" };

  let realRoot: string;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    return { status: "unavailable" };
  }

  try {
    const metadata = statSync(candidate);
    if (!metadata.isFile()) return { status: "invalid" };
    const realTarget = realpathSync(candidate);
    return isContained(realRoot, realTarget) ? { status: "exists" } : { status: "outside_root" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "unavailable" };
    const ancestor = nearestExistingAncestor(dirname(candidate));
    if (!ancestor) return { status: "unavailable" };
    try {
      return isContained(realRoot, realpathSync(ancestor))
        ? { status: "missing" }
        : { status: "outside_root" };
    } catch {
      return { status: "unavailable" };
    }
  }
}

export interface SourceRefFinding {
  path: string;
  detail: string;
}

export const DISTILL_SOURCE_UNVERIFIABLE_REASON =
  "external source, discarded by design — re-derivation means re-presenting the source";

export interface SourceVerifiabilityAnnotation {
  source: string;
  status: "born-unverifiable";
  reason: typeof DISTILL_SOURCE_UNVERIFIABLE_REASON;
}

export function sourceVerifiabilityAnnotations(sources: string[]): SourceVerifiabilityAnnotation[] {
  const seen = new Set<string>();
  const annotations: SourceVerifiabilityAnnotation[] = [];
  for (const raw of sources) {
    const parsed = parseSourceRef(raw);
    if (parsed.kind !== "distill" || seen.has(parsed.raw)) continue;
    seen.add(parsed.raw);
    annotations.push({
      source: parsed.raw,
      status: "born-unverifiable",
      reason: DISTILL_SOURCE_UNVERIFIABLE_REASON,
    });
  }
  return annotations;
}

// One advisory finding per citing document. Grouping avoids duplicate board
// identities when a doc mixes repo and distill refs. Repository verification
// is capability-gated; distill refs need no filesystem access and are always
// labeled because the readable document already discloses the raw breadcrumb.
// Absolute host paths never enter the result.
export function unverifiableSourceFindings(
  docs: Array<{ path: string; frontmatter: { sources?: string[] } }>,
  opts: { repoRoot?: string; verifyRepoSources: boolean },
): SourceRefFinding[] {
  const findings: SourceRefFinding[] = [];
  for (const doc of docs) {
    const repoRefs: string[] = [];
    const distillRefs: string[] = [];
    for (const raw of doc.frontmatter.sources ?? []) {
      const parsed = parseSourceRef(raw);
      if (parsed.kind === "distill") {
        distillRefs.push(parsed.raw);
        continue;
      }
      if (parsed.kind !== "repo" || !opts.verifyRepoSources) continue;
      const status = opts.repoRoot
        ? verifyRepoSourceRef(opts.repoRoot, parsed.target).status
        : "unconfigured";
      if (status !== "exists") repoRefs.push(`${parsed.raw} (${status})`);
    }
    const clauses: string[] = [];
    if (repoRefs.length > 0) {
      clauses.push(`unverifiable repository source(s): ${repoRefs.join(", ")}`);
    }
    if (distillRefs.length > 0) {
      clauses.push(
        `born-unverifiable distill source(s): ${distillRefs.join(", ")} — ` +
          DISTILL_SOURCE_UNVERIFIABLE_REASON,
      );
    }
    if (clauses.length > 0) {
      findings.push({
        path: doc.path,
        detail: clauses.join("; "),
      });
    }
  }
  return findings;
}
