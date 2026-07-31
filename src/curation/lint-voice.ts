// The ledger-keeper voice for vault_lint's `content` channel.
//
// This is a presentation layer only: it re-renders the SAME findings the plain
// summary reports (`summarizeLint` in ../tools/curation.ts), in the dry,
// margin-note register of a three-centuries-old ledger-keeper. It selects and
// orders findings with the SAME shared constants the plain summary uses
// (TIER0_LINT_CHECKS, LINT_SUMMARY_TOP_FINDINGS), so the two voices surface the
// same documents — the voice changes wording, never what is flagged. It is a
// pure function of its input: no I/O, no LLM, no randomness, no clock. The full
// structured report still rides the tool's structured channel untouched.

// Type-only import: erased at compile time, so no runtime import cycle with
// curation.ts (which imports renderLedgerKeeper from here).
import type { VaultLintResult } from "../tools/curation.js";
import {
  clip,
  LINT_CHECKS,
  LINT_SUMMARY_DETAIL_CHARS,
  LINT_SUMMARY_TOP_FINDINGS,
  type LintCheckName,
  type LintFinding,
  TIER0_LINT_CHECKS,
} from "./lint.js";

// One clause per check, in the ledger-keeper's register. Exhaustive by type: a
// new entry in LINT_CHECKS will not compile until it is given a clause here, so
// every check the summary can surface has a voice.
const LEDGER_CLAUSE: Record<LintCheckName, string> = {
  staleFiles: "has lapsed its warranty and gone unattended",
  orphanFiles: "speaks to no one, and no one to it",
  oldDrafts: "has lingered in draft past all reason",
  stagnantLowConfidence: "sits uncertain and untouched",
  deprecatedStillLinked: "is retired, yet the canon still leans upon it",
  unansweredQuestions: "poses questions this house has not answered",
  tierDemotions: "has been put down from its tier",
  brokenSourceRefs: "cites a source that cannot be found",
  lifecycleConflicts: "claims two lifecycles at once",
  schemaInvalid: "will not keep to the ledger's schema",
  domainLeaks: "lets one domain bleed into another",
  validityConflicts: "asserts a validity that quarrels with another",
};

// "1 matter" / "3 matters" — a small deterministic pluralizer for the copy.
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Renders a vault_lint result in the ledger-keeper voice. Mirrors the plain
// summary's structure line-for-line so it is a re-skin, not a redesign, and
// honors the same content-channel budget (top findings capped, detail clipped).
export function renderLedgerKeeper(report: VaultLintResult): string {
  const perCheck: string[] = [];
  let certain = 0;
  let advisory = 0;
  const flat: Array<{ check: LintCheckName; finding: LintFinding }> = [];
  for (const check of LINT_CHECKS) {
    const findings = report.checks[check] ?? [];
    if (findings.length === 0) continue;
    perCheck.push(`${check} ${findings.length}`);
    if (TIER0_LINT_CHECKS.includes(check)) certain += findings.length;
    else advisory += findings.length;
    for (const finding of findings) flat.push({ check, finding });
  }
  // Certain (tier-0) findings first; stable sort preserves LINT_CHECKS order
  // within each severity — identical selection to the plain summary.
  flat.sort(
    (a, b) =>
      Number(TIER0_LINT_CHECKS.includes(b.check)) - Number(TIER0_LINT_CHECKS.includes(a.check)),
  );

  const h = report.tensionHealth;
  const lines: string[] = [
    `The daftari has read the ledger. ${count(report.totalFindings, "matter", "matters")} noted` +
      ` — ${certain} beyond dispute, ${advisory} left to your judgment. [${report.generatedAt}]`,
    perCheck.length > 0
      ? `By my account: ${perCheck.join(", ")}.`
      : "By my account: the books balance.",
    `Of disputes: ${h.total} entered, ${h.resolvedLifetime} settled, ` +
      `${h.stableAcknowledged} left standing by your leave; ` +
      `${h.aging.fresh} fresh, ${h.aging.aging} aging, ${h.aging.stale} past patience; ` +
      `${count(h.clusters.count, "knot", "knots")} (${h.clusters.large} large, ${h.clusters.aged} aged); ` +
      `${count(h.blastRadiusOfStaleTensions, "entry", "entries")} shadowed by a stale dispute.`,
    `Awaiting your ruling: ${report.stagedActions.length} staged, ` +
      `${report.reviewThroughput.lifetime.expired} lapsed unread; ` +
      `${report.shadowActions.total} write(s) watched in shadow, ` +
      `${report.shadowActions.gated} the budget would have stayed; ` +
      `${report.coverageEquity.backstopOverdue.count} edge(s) overdue for backstop.`,
  ];

  const top = flat.slice(0, LINT_SUMMARY_TOP_FINDINGS);
  if (top.length > 0) {
    lines.push(
      `The ${count(top.length, "entry", "entries")} most wanting your eye, of ${flat.length}:`,
    );
    for (const { check, finding } of top) {
      lines.push(
        `  Entry ${finding.path} ${LEDGER_CLAUSE[check]}. ` +
          `(${clip(finding.detail, LINT_SUMMARY_DETAIL_CHARS)})`,
      );
    }
  } else {
    lines.push("Nothing demands correction today. I have recorded as much. — the daftari");
  }

  return lines.join("\n");
}
