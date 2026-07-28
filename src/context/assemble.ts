// Context-pack assembly (spec 2026-07-26-context-packs-progressive-
// disclosure-design.md, Decision 2 / Decision 3, final-plan Phase 2.1-2.4).
//
// Pure, deterministic selection + templating over an already-enriched,
// already-RBAC-filtered PackEntry[]. This module knows nothing about the
// index, RBAC, or the ranker — src/tools/context.ts owns retrieval, RBAC
// filtering, supersession dedup, and head-keyed enrichment (C3); this module
// only sorts, greedily cuts to budget, and renders markdown. That split is
// what makes assemble.test.ts able to prove determinism (same PackEntry[] in
// twice ⇒ byte-identical brief out) without a database, a fixture vault, or a
// golden-file pin on retrieval-dependent snippet content (C6).
//
// Decision 3's refusal is enforced HERE, structurally, not by convention: a
// tension flag always renders BOTH claims from `claimSelf`/`claimOther` — a
// blended sentence is not a shape this renderer can produce. Supersession
// prints only the pointer and hop count; the chain head's own snippet is
// what carries content, and it arrives already-resolved on the entry (the
// tool handler set `snippet` to `currentSource.snippet` for a collapsed
// chain). No field here is prose daftari composed *about* the truth of vault
// content — every flag line is a direct rendering of an index fact.

import type { HiddenDownstream } from "../curation/tension-blast.js";
import { estimateTokens } from "./estimate.js";

// 10% headroom on top of the chars/4 estimate (spec §5): a brief cut at
// budget * 0.9 estimated tokens stays inside the caller's stated budget even
// when the estimator's ~±15% error runs hot.
export const BUDGET_HEADROOM = 0.9;

export interface PackTensionFlag {
  kind: string;
  counterpart: string; // vault-relative path of the other side
  claimSelf: string;
  claimOther: string;
}

export interface PackDecayFlag {
  level: "deprecated" | "warn" | "aging";
  banner: string | null;
}

export interface PackStructuralFlag {
  orphan: boolean;
  deprecatedStillLinked: boolean;
}

export interface PackUpstreamFlag {
  pendingBrokenUpstream?: "some" | "many";
  hiddenPendingUpstream?: "some" | "many";
}

export interface PackProvenanceFlag {
  updatedBy: string;
  updated: string;
}

// One candidate document, already enriched and RBAC-filtered by the tool
// handler. Every flag field below is keyed on THIS entry's own `path` — for
// a collapsed supersession chain, that is the HEAD's path, never the stale
// member's (C3: "all flags describe the entry's path, no exceptions"). A
// stale member that collapsed into a head contributes exactly three things
// to the head entry: `score` (max over the collapsed members), `supersedes`
// (the collapsed count), and `reason` — never its own flags.
export interface PackEntry {
  path: string;
  title: string;
  score: number;
  reason: string;
  snippet: string;
  // Present only on a chain-head entry: the count of stale members collapsed
  // into it.
  supersedes?: number;
  // Present only on a stale hit whose current-source chain hit an unreadable
  // hop — the path-free marker (2026-07-14 spec, RBAC omission). Mutually
  // exclusive with `supersedes` in practice (a restricted chain never
  // resolves to a head), but the renderer does not assume that.
  currentSourceRestricted?: boolean;
  // Present only on a stale hit whose supersession chain could not be
  // followed to a head at all — a broken `superseded_by` pointer or a cycle.
  // Kept as itself (never collapsed), same as the restricted case.
  supersessionIssue?: "dangling" | "cycle";
  tensions?: PackTensionFlag[]; // open only, capped by the caller (CONTESTED_CAP)
  contestedCount?: number; // true total; may exceed tensions.length
  decay?: PackDecayFlag | null;
  structural?: PackStructuralFlag | null;
  upstream?: PackUpstreamFlag;
  provenance?: PackProvenanceFlag;
}

export interface ContextPackManifestEntry {
  path: string;
  score: number;
  reason: string;
}

export interface ContextPackManifest {
  included: ContextPackManifestEntry[];
  omitted_over_budget: number;
  // Lower-bound signal over OBSERVABLE withholding, never a completeness
  // claim (C4) — see src/tools/context.ts for how the caller computes this.
  hidden_remainder: HiddenDownstream;
}

export interface ContextPack {
  task: string;
  budget: number;
  estimatedTokens: number;
  brief: string;
  manifest: ContextPackManifest;
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function renderHeader(task: string, n: number, bodyTokens: number, budget: number): string {
  return (
    `# Context brief: ${task}\n\n` +
    `_${pluralize(n, "document")}, ~${bodyTokens} tokens (budget ${budget}). ` +
    "Selected, not synthesized — drill in with vault_read._"
  );
}

// Decision 3, structurally enforced: a tension always renders both claims —
// there is no code path here that could merge them into one sentence.
function renderFlagLines(entry: PackEntry): string[] {
  const lines: string[] = [];
  if (entry.supersedes !== undefined) {
    lines.push(`- supersedes ${pluralize(entry.supersedes, "older document")} matching this task`);
  }
  if (entry.currentSourceRestricted) {
    lines.push("- current source: restricted");
  }
  if (entry.supersessionIssue === "dangling") {
    lines.push("- current source: chain broken (points at a document that no longer exists)");
  }
  if (entry.supersessionIssue === "cycle") {
    lines.push("- current source: chain forms a cycle");
  }
  if (entry.tensions && entry.tensions.length > 0) {
    for (const t of entry.tensions) {
      lines.push(
        `- contested (${t.kind}, open): this doc claims "${t.claimSelf}"; ` +
          `${t.counterpart} claims "${t.claimOther}"`,
      );
    }
    const shown = entry.tensions.length;
    const total = entry.contestedCount ?? shown;
    if (total > shown) lines.push(`- +${total - shown} more unresolved tension(s)`);
  }
  if (entry.decay) {
    const suffix = entry.decay.banner ? ` — ${entry.decay.banner}` : "";
    lines.push(`- decay: ${entry.decay.level}${suffix}`);
  }
  if (entry.structural?.orphan) {
    lines.push("- structural: orphan — no readable document links here");
  }
  if (entry.structural?.deprecatedStillLinked) {
    lines.push("- structural: deprecated but still linked from a canonical document");
  }
  if (entry.upstream?.pendingBrokenUpstream) {
    lines.push(
      `- upstream: ${entry.upstream.pendingBrokenUpstream} pending-broken compiled input(s)`,
    );
  }
  if (entry.upstream?.hiddenPendingUpstream) {
    lines.push(
      `- upstream: ${entry.upstream.hiddenPendingUpstream} pending change(s) outside your read scope`,
    );
  }
  if (entry.provenance) {
    lines.push(
      `- updated ${entry.provenance.updated} by ${entry.provenance.updatedBy || "unknown"}`,
    );
  }
  return lines;
}

function renderEntry(entry: PackEntry): string {
  const parts = [
    `### ${entry.title}`,
    `\`${entry.path}\` — score ${entry.score.toFixed(3)}`,
    "",
    entry.snippet,
  ];
  const flagLines = renderFlagLines(entry);
  if (flagLines.length > 0) {
    parts.push("", ...flagLines);
  }
  return parts.join("\n");
}

function renderFooter(omitted: number, hiddenRemainder: HiddenDownstream): string {
  const lines: string[] = [];
  if (omitted > 0) {
    lines.push(`_${pluralize(omitted, "more document")} omitted over budget._`);
  }
  // Absent-is-healthy (spec §"no LLM call" / Decision 3): the scope line
  // prints only when there is something to disclose, never affirming
  // completeness (C4).
  if (hiddenRemainder !== "none") {
    lines.push(`_${hiddenRemainder} additional document(s) withheld outside your read scope._`);
  }
  return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

// Assembles a ContextPack from an unsorted candidate pool. Deterministic:
// calling this twice on the same `entries` array produces byte-identical
// output (no Date.now, no randomness, no I/O) — the property assemble.test.ts
// pins directly, instead of a golden-fixture brief (C6).
//
// Selection: sort by score desc (path asc tie-break, matching the ranker's
// own tie-break), then append greedily while the CANDIDATE brief (header +
// body-so-far + the next entry) stays within budget * BUDGET_HEADROOM
// estimated tokens. The first entry that does not fit stops the walk —
// no skip-ahead, so `included` is always a PREFIX of the score-sorted pool
// (final-plan 2.2 step 7). The footer (omitted count, hidden-remainder scope
// line) is appended unconditionally afterward — it is disclosure, never
// budget-gated, so a caller always learns what was left out even when
// nothing fits (C9).
export function assembleContextPack(
  task: string,
  budget: number,
  entries: PackEntry[],
  hiddenRemainder: HiddenDownstream,
): ContextPack {
  const sorted = [...entries].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const included: PackEntry[] = [];
  const bodyBlocks: string[] = [];
  for (const entry of sorted) {
    const candidateBody = [...bodyBlocks, renderEntry(entry)].join("\n\n");
    // The header's own "~N tokens" line reports the CANDIDATE body's size —
    // reported metadata, not itself a byte-exact constraint; the 10%
    // headroom is precisely what absorbs a chars/4 estimate describing
    // itself (see the module comment and estimate.ts).
    const candidateHeader = renderHeader(
      task,
      included.length + 1,
      estimateTokens(candidateBody),
      budget,
    );
    const candidateBrief = `${candidateHeader}\n\n${candidateBody}`;
    if (estimateTokens(candidateBrief) <= budget * BUDGET_HEADROOM) {
      included.push(entry);
      bodyBlocks.push(renderEntry(entry));
    } else {
      break; // stop at the first entry that does not fit — no skip-ahead
    }
  }

  const omitted = sorted.length - included.length;
  const body =
    sorted.length === 0
      ? "_No matching documents._"
      : included.length === 0
        ? "_Nothing fit the requested budget — raise `budget` to include results._"
        : bodyBlocks.join("\n\n");
  const header = renderHeader(task, included.length, estimateTokens(body), budget);
  const footer = renderFooter(omitted, hiddenRemainder);
  const brief = `${header}\n\n${body}${footer}`;

  return {
    task,
    budget,
    estimatedTokens: estimateTokens(brief),
    brief,
    manifest: {
      included: included.map((e) => ({ path: e.path, score: e.score, reason: e.reason })),
      omitted_over_budget: omitted,
      hidden_remainder: hiddenRemainder,
    },
  };
}
