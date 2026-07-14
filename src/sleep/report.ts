// The Morning Report — what the vault metabolized overnight, rendered for
// the human who ratifies. Same conventions as the audit and court reports:
// markdown to stdout by default, JSON with full detail, capped lists with an
// explicit "+n more" so truncation is visible, never silent.

import type { SleepCycleResult, WakeTask } from "./cycle.js";
import type { TensionScanOutcome } from "./tension-scan.js";

export interface SleepReport {
  generatedAt: string;
  vault: string;
  cycle: SleepCycleResult;
  wakeQueuePath: string | null; // null when --no-queue
  wakeLimit: number;
}

function wakeLine(w: WakeTask): string {
  return (
    `| ${w.path} | ${w.ageDays}d / ${w.ttlDays ?? "—"}d | ` +
    `${w.blastTotal} (${w.blastPrimary}p/${w.blastAdvisory}a) | ${w.sources.join(", ") || "—"} |`
  );
}

export function renderMarkdown(report: SleepReport): string {
  const c = report.cycle;
  const lines: string[] = [];

  lines.push("# Morning Report");
  lines.push("");
  lines.push(
    `Overnight pass of ${report.vault} — decay measured, nothing resolved. ` +
      `The vault proposes; you ratify.`,
  );
  lines.push("");

  lines.push("## Freshness");
  lines.push(
    `- ${c.staleness.fresh} fresh · ${c.staleness.aging} aging · ` +
      `**${c.staleness.stale} stale** of ${c.staleness.total} documents`,
  );
  if (c.generativeStale > 0) {
    lines.push(
      `- generative docs past TTL: ${c.generativeStale} (expected for the domain — not woken)`,
    );
  }
  lines.push("");

  lines.push(`## Wake list — ${c.wake.length} load-bearing decayed document(s)`);
  if (c.wake.length === 0) {
    lines.push("Nothing needs waking. Every canonical document with dependents is inside TTL.");
  } else {
    lines.push(
      "Canonical, past TTL, with downstream dependents. Point an agent at the " +
        "wake queue to re-verify each against its sources and stage diffs for " +
        "ratification — the vault never re-verifies on its own.",
    );
    lines.push("");
    lines.push("| doc | age / TTL | blast | sources |");
    lines.push("|-----|-----------|-------|---------|");
    for (const w of c.wake.slice(0, report.wakeLimit)) lines.push(wakeLine(w));
    if (c.wake.length > report.wakeLimit) {
      lines.push(
        `| …and ${c.wake.length - report.wakeLimit} more (full list in the queue) | | | |`,
      );
    }
    if (report.wakeQueuePath) {
      lines.push("");
      lines.push(`Queue written to \`${report.wakeQueuePath}\`.`);
    }
  }
  lines.push("");

  if (c.decayedQuiet.length > 0) {
    lines.push(`## Quiet decay — ${c.decayedQuiet.length} expired doc(s) with no dependents`);
    for (const q of c.decayedQuiet.slice(0, 10)) lines.push(`- ${q.path} (${q.ageDays}d)`);
    if (c.decayedQuiet.length > 10) lines.push(`- …and ${c.decayedQuiet.length - 10} more`);
    lines.push("");
  }

  lines.push("## Tensions");
  lines.push(`- open: ${c.tensions.open} · stale tier: ${c.tensions.stale.length}`);
  if (c.tensions.docketTop.length > 0) {
    lines.push("- docket head (see `daftari court` for full briefs):");
    for (const d of c.tensions.docketTop) {
      lines.push(`  - [${d.tier}] ${d.title} — blast ${d.blastTotal}${d.id ? ` (${d.id})` : ""}`);
    }
  }
  lines.push("");

  lines.push("## Ratification queue");
  lines.push(`- pending: ${c.ratification.pending}`);
  if (c.ratification.expiringSoon.length > 0) {
    lines.push("- expiring within 3 days:");
    for (const a of c.ratification.expiringSoon) {
      lines.push(`  - ${a.id} · ${a.actionType} · ${a.targetPath} · ${a.daysLeft}d left`);
    }
  }
  if (c.sweptExpired.length > 0) {
    lines.push(`- expired overnight (swept): ${c.sweptExpired.length}`);
  }
  const h = c.ratification.history;
  lines.push(
    `- decision history: ${h.ratified} ratified · ${h.rejected} rejected · ${h.expired} expired`,
  );
  // The circadian kill-condition monitor, stated where the human will see it.
  if (h.ratified + h.rejected >= 10 && h.rejected === 0) {
    lines.push(
      "- ⚠ zero rejections on record — if everything staged gets approved, " +
        "ratification may be rubber-stamping. Sample a few approvals and check.",
    );
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

export function renderJson(report: SleepReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// --- tension-scan dream report --------------------------------------------
//
// Same posture as the Morning Report: the scan records, it never resolves.
// Every count is machine-derived from the pass — the anti-theatre
// instrumentation the demo established (searches, judgments, tensions all
// counted; no eyeball verification).

export function renderTensionScanMarkdown(
  vault: string,
  model: string,
  s: TensionScanOutcome,
): string {
  const lines: string[] = [];
  lines.push("# Dream Report — tension scan");
  lines.push("");
  lines.push(
    `Contradiction pass of ${vault} (judge: ${model}) — conflicts recorded ` +
      `on the tension ledger, nothing resolved. The vault proposes; you ratify.`,
  );
  lines.push("");
  lines.push("## Spend");
  lines.push(
    `- ${s.candidates} candidate doc(s), ${s.docsScanned} fully scanned · ` +
      `${s.searchCalls} related-doc searches`,
  );
  lines.push(
    `- ${s.pairsJudged} pairwise LLM judgment(s)` +
      (s.budgetExhausted ? " · **budget exhausted — pass short-circuited**" : ""),
  );
  lines.push(
    `- skipped without spend: ${s.pairsSkippedJudged} already judged · ` +
      `${s.pairsSkippedExistingTension} already on the ledger · ` +
      `${s.pairsSkippedAccess} access-denied`,
  );
  if (s.parseFailures > 0) {
    lines.push(`- unparseable verdicts (defaulted to no-conflict): ${s.parseFailures}`);
  }
  lines.push("");
  lines.push(`## Tensions logged — ${s.tensionsLogged}`);
  if (s.tensions.length === 0) {
    lines.push("No conflicts found among the judged pairs.");
  } else {
    for (const t of s.tensions) {
      lines.push(
        `- [${t.kind}] ${t.sourceA} <-> ${t.sourceB}` +
          `${t.id ? ` (${t.id})` : ""}${t.reason ? ` — ${t.reason}` : ""}`,
      );
    }
    lines.push("");
    lines.push("Review with `daftari court`; resolve with `vault_tension_resolve`.");
  }
  if (s.tensionLogFailures > 0) {
    lines.push("");
    lines.push(`⚠ ${s.tensionLogFailures} tension write(s) failed — see stderr.`);
  }
  if (s.budgetExhausted) {
    lines.push("");
    lines.push(
      "Budget exhausted before every candidate was scanned — the remainder " +
        "re-enters the next pass's queue (judged pairs are not re-billed).",
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function renderTensionScanJson(s: TensionScanOutcome): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}
