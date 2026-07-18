// Tier 0 of tiered compatibility checking (#232) — quick win 1 of #236.
//
// Structure-only checks whose failures are certain, not judgment calls:
// referential integrity, lifecycle consistency, and schema conformance. They
// run off frontmatter and the declared-source graph alone — no compiled edge
// graph, no LLM. Per the 2026-07-17 through-line spec, these are the checks
// that hard verdicts are allowed for, which is why they get two enforcement
// surfaces:
//
//   1. vault_lint checks (advisory, like every lint check — reported, never
//      auto-fixed).
//   2. The ratify gate in vault_ratify (tools/staged-actions.ts): approving a
//      promote/deprecate that would CREATE a tier-0 violation is blocked.
//      Ratification is already a gate, so blocking there does not violate the
//      advisory-curation rule; the direct write tools stay unblocked.
//
// Scope discipline: referential integrity covers the TYPED dependency
// channels only — the `sources` frontmatter array and `superseded_by`. Body
// links are the advisory channel (see tension-blast.ts) and broken body links
// are the audit engine's territory (audit/checks/broken_refs). A `sources`
// entry is only checked when it looks like a vault path (contains "/" or ends
// in ".md"); opaque citation strings ("interview-2026-04", a book title) and
// external URLs are legitimate non-vault citations and are never flagged.
//
// Lifecycle consistency deliberately does NOT treat a `superseded` source as
// a conflict: a superseded doc has a designated successor and the
// current-source layer forwards readers to it — citing one is aged, not
// broken. The conflict statuses are draft (not yet certified), deprecated
// (retired without forwarding... unless superseded_by is set, but the status
// alone already routes readers away), and archived (no live claim).

import type { Status } from "../frontmatter/types.js";
import { buildPathIndexes, type LoadedDoc, resolveLink } from "./vault-docs.js";

// Lint check names contributed by this module (appended to LINT_CHECKS).
// Exported so consumers can triage findings by confidence class: everything
// under these names is tier-0-certain, not advisory judgment.
export const TIER0_LINT_CHECKS = [
  "brokenSourceRefs",
  "lifecycleConflicts",
  "schemaInvalid",
  "domainLeaks",
] as const;

// A canonical doc citing a source in one of these states is a lifecycle
// conflict — #232's "certified artifact depending on a unit that transitioned
// to draft/deprecated". `superseded` is intentionally absent (see header).
export const CONFLICTING_SOURCE_STATUSES: ReadonlySet<Status> = new Set([
  "draft",
  "deprecated",
  "archived",
]);

const EXTERNAL_REF = /^(https?:|mailto:)/i;

// A sources entry is checked for referential integrity only when it plausibly
// names a vault document. Everything else is an opaque citation.
function isPathLike(raw: string): boolean {
  return raw.includes("/") || raw.endsWith(".md");
}

export interface Tier0Finding {
  path: string;
  detail: string;
}

export interface Tier0Findings {
  brokenSourceRefs: Tier0Finding[];
  lifecycleConflicts: Tier0Finding[];
  schemaInvalid: Tier0Finding[];
  // #4: an accumulation-domain doc citing a generative-domain doc in
  // `sources` — speculative material referenced as if it were settled canon.
  // Certain (both domains are frontmatter facts), and scoped to the TYPED
  // channel per this module's discipline; body-link leaks are the write-time
  // advisory's territory (tools/write.ts domain_warnings).
  domainLeaks: Tier0Finding[];
}

// Runs the three tier-0 checks over a loaded doc set. The doc set is also the
// resolution universe: under RBAC, lint passes the caller-visible subset, so
// findings compute from the caller's vantage (#217) — a source the caller
// cannot read is indistinguishable from one that does not exist, the same
// rule every other lint check follows.
export function tier0Findings(docs: LoadedDoc[]): Tier0Findings {
  const { byPath, byBasename } = buildPathIndexes(docs);
  const docByPath = new Map(docs.map((d) => [d.path, d]));

  const out: Tier0Findings = {
    brokenSourceRefs: [],
    lifecycleConflicts: [],
    schemaInvalid: [],
    domainLeaks: [],
  };

  for (const doc of docs) {
    const broken: string[] = [];
    const conflicts: string[] = [];
    const leaks: string[] = [];

    for (const raw of doc.frontmatter.sources ?? []) {
      if (EXTERNAL_REF.test(raw)) continue;
      const target = resolveLink(raw, doc.path, byPath, byBasename);
      if (!target) {
        if (isPathLike(raw)) broken.push(raw);
        continue;
      }
      if (target === doc.path) continue;
      if (doc.frontmatter.status === "canonical") {
        const status = docByPath.get(target)?.frontmatter.status;
        if (status && CONFLICTING_SOURCE_STATUSES.has(status)) {
          conflicts.push(`${target} (${status})`);
        }
      }
      // #4: the epistemic boundary — durable canon must not cite sketches.
      if (
        doc.frontmatter.domain === "accumulation" &&
        docByPath.get(target)?.frontmatter.domain === "generative"
      ) {
        leaks.push(target);
      }
    }

    // superseded_by is always a vault path by construction (the write tools
    // set it from a validated successor), so it is always checked.
    const sup = doc.frontmatter.superseded_by;
    if (sup && !EXTERNAL_REF.test(sup) && !resolveLink(sup, doc.path, byPath, byBasename)) {
      broken.push(`superseded_by: ${sup}`);
    }

    if (broken.length > 0) {
      out.brokenSourceRefs.push({
        path: doc.path,
        detail: `unresolvable reference(s): ${broken.join(", ")}`,
      });
    }
    if (conflicts.length > 0) {
      out.lifecycleConflicts.push({
        path: doc.path,
        detail: `canonical doc cites non-canonical source(s): ${conflicts.join(", ")}`,
      });
    }
    if (leaks.length > 0) {
      out.domainLeaks.push({
        path: doc.path,
        detail: `accumulation-domain doc cites generative-domain source(s): ${leaks.join(", ")}`,
      });
    }
    if (!doc.validation.valid) {
      out.schemaInvalid.push({
        path: doc.path,
        detail: doc.validation.issues.map((i) => `${i.field}: ${i.message}`).join("; "),
      });
    }
  }

  return out;
}

// --- ratify gates ----------------------------------------------------------
//
// The gates evaluate the POST-state of the proposed action against the full
// (unfiltered) doc set — the gate protects vault-global invariants, not the
// caller's vantage. Disclosure is handled at the message layer: `visible`
// (when RBAC is active) splits offending docs into nameable and hidden, and
// the caller reports the hidden remainder coarsened (#217 B′), never as an
// exact count.

export interface PromoteGateResult {
  violations: string[];
  // Count of non-canonical sources the ratifier cannot read. Never put this
  // number in caller-facing output — coarsen it (bucketHiddenDownstream).
  hiddenConflicts: number;
}

// Would promoting targetPath to canonical create a tier-0 violation? Checks
// the target's schema report, its path-like sources for resolvability, and
// its resolved sources for conflicting lifecycle states (as-if canonical —
// the post-state of the promote).
export function tier0PromoteGate(
  docs: LoadedDoc[],
  targetPath: string,
  visible?: (doc: LoadedDoc) => boolean,
): PromoteGateResult {
  const target = docs.find((d) => d.path === targetPath);
  // A missing/unparseable target is the dispatch layer's error to report.
  if (!target) return { violations: [], hiddenConflicts: 0 };

  const { byPath, byBasename } = buildPathIndexes(docs);
  const docByPath = new Map(docs.map((d) => [d.path, d]));
  const violations: string[] = [];
  let hiddenConflicts = 0;

  if (!target.validation.valid) {
    violations.push(
      `schema-invalid frontmatter (${target.validation.issues
        .map((i) => `${i.field}: ${i.message}`)
        .join("; ")})`,
    );
  }

  for (const raw of target.frontmatter.sources ?? []) {
    if (EXTERNAL_REF.test(raw)) continue;
    const resolved = resolveLink(raw, target.path, byPath, byBasename);
    if (!resolved) {
      if (isPathLike(raw)) violations.push(`unresolvable source: ${raw}`);
      continue;
    }
    if (resolved === target.path) continue;
    const sourceDoc = docByPath.get(resolved);
    if (!sourceDoc) continue;
    const status = sourceDoc.frontmatter.status;
    if (!CONFLICTING_SOURCE_STATUSES.has(status)) continue;
    if (visible && !visible(sourceDoc)) hiddenConflicts += 1;
    else violations.push(`source ${resolved} is ${status}`);
  }

  return { violations, hiddenConflicts };
}

export interface DeprecateGateResult {
  dependents: string[];
  // Count of canonical dependents the ratifier cannot read — coarsen, never
  // report exactly (#217 B′).
  hiddenDependents: number;
}

// Would deprecating targetPath strand canonical dependents on a retired
// source? Only relevant for a deprecate WITHOUT a superseded_by forward — a
// forwarded deprecate leaves dependents a resolution path, same as
// supersede. The caller decides whether forwarding is present.
export function tier0DeprecateGate(
  docs: LoadedDoc[],
  targetPath: string,
  visible?: (doc: LoadedDoc) => boolean,
): DeprecateGateResult {
  const { byPath, byBasename } = buildPathIndexes(docs);
  const dependents: string[] = [];
  let hiddenDependents = 0;

  for (const doc of docs) {
    if (doc.path === targetPath) continue;
    if (doc.frontmatter.status !== "canonical") continue;
    const cites = (doc.frontmatter.sources ?? []).some(
      (raw) =>
        !EXTERNAL_REF.test(raw) && resolveLink(raw, doc.path, byPath, byBasename) === targetPath,
    );
    if (!cites) continue;
    if (visible && !visible(doc)) hiddenDependents += 1;
    else dependents.push(doc.path);
  }

  return { dependents: dependents.sort(), hiddenDependents };
}
