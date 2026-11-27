// `daftari review-stats` — read-only review-burden report over the review
// journal (.daftari/review-log.jsonl, bead 9mpe). Answers: who is deciding
// (human / agent / unknown), how long items wait between first surfacing and
// decision, how many decisions changed the vault, and whether the tension
// backlog is growing week over week.
//
// Only events the journal holds are counted: decisions made before the
// instrumentation shipped are not in it, so a young journal under-reports.
//
// Exit codes: 0 — report produced; 2 — usage error.

import { resolve } from "node:path";
import {
  DECIDED_BY_KINDS,
  type DecidedByKind,
  type ReviewEvent,
  readReviewEvents,
} from "./review-log.js";
import { nearestRank } from "./review-throughput.js";

type KindCounts = Record<DecidedByKind, number>;

export interface TimingSummary {
  n: number;
  p50Hours: number | null;
  p90Hours: number | null;
}

export interface TensionWeek {
  weekStart: string; // YYYY-MM-DD, Monday (UTC)
  opened: number;
  resolved: number;
  backlog: number; // open at week end, among tensions the journal saw opened
}

export interface ReviewStats {
  since: string;
  until: string;
  decisions: {
    total: number;
    byKind: KindCounts;
    bySurface: Record<string, KindCounts>;
    changed: number;
    changedPct: number | null;
  };
  // Time from an item's first surfacing to a reviewer of the DECIDER'S kind
  // until the decision. Decisions with no such surfacing are unmeasured.
  timeToDecision: {
    measured: number;
    unmeasured: number;
    overall: TimingSummary;
    byKind: Record<DecidedByKind, TimingSummary>;
  };
  tensions: { weeks: TensionWeek[] };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function zeroKinds(): KindCounts {
  return { human: 0, agent: 0, unknown: 0 };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function summarize(hours: number[]): TimingSummary {
  const sorted = [...hours].sort((a, b) => a - b);
  const p50 = nearestRank(sorted, 0.5);
  const p90 = nearestRank(sorted, 0.9);
  return {
    n: sorted.length,
    p50Hours: p50 === null ? null : round2(p50),
    p90Hours: p90 === null ? null : round2(p90),
  };
}

// Monday 00:00 UTC of the week containing `t`.
function weekStart(t: number): number {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

// `30d`, `4w`, or an ISO date/instant. Null when unparseable or non-positive.
export function parseSince(raw: string, now: Date): Date | null {
  const m = raw.trim().match(/^(\d+)([dw])$/);
  if (m) {
    const n = Number.parseInt(m[1] as string, 10);
    if (n <= 0) return null;
    return new Date(now.getTime() - n * (m[2] === "w" ? 7 : 1) * DAY_MS);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw.trim())) return null;
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t) : null;
}

export function reviewStats(events: ReviewEvent[], since: Date, now: Date): ReviewStats {
  const from = since.getTime();
  const to = now.getTime();

  // First surfacing per (viewer kind, item), across the whole journal — an
  // item shown before the window and decided inside it still times.
  const firstShown = new Map<string, number>();
  for (const e of events) {
    if (e.ev !== "shown") continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    const key = `${e.viewer_kind}\u0000${e.item}`;
    const prev = firstShown.get(key);
    if (prev === undefined || t < prev) firstShown.set(key, t);
  }

  const byKind = zeroKinds();
  const bySurface: Record<string, KindCounts> = {};
  const hours: Record<DecidedByKind, number[]> = { human: [], agent: [], unknown: [] };
  let total = 0;
  let changed = 0;
  let unmeasured = 0;
  for (const e of events) {
    if (e.ev !== "decision") continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || t < from || t > to) continue;
    total += 1;
    byKind[e.decided_by_kind] += 1;
    bySurface[e.surface] ??= zeroKinds();
    (bySurface[e.surface] as KindCounts)[e.decided_by_kind] += 1;
    if (e.changed_anything) changed += 1;
    const shownAt = firstShown.get(`${e.decided_by_kind}\u0000${e.item}`);
    if (shownAt === undefined || shownAt > t) unmeasured += 1;
    else hours[e.decided_by_kind].push((t - shownAt) / HOUR_MS);
  }

  // Tension weeks: every week from the one holding `since` to the one holding
  // `now`. Backlog runs over the WHOLE journal so it is right at week one.
  const opened = new Map<string, number>(); // item → open instant
  const resolvedAt = new Map<string, number>(); // item → first resolve instant
  for (const e of events) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    if (e.ev === "tension_open" && !opened.has(e.item)) opened.set(e.item, t);
    if (e.ev === "decision" && e.surface === "tension" && !resolvedAt.has(e.item)) {
      resolvedAt.set(e.item, t);
    }
  }
  const weeks: TensionWeek[] = [];
  for (let w = weekStart(from); w <= to; w += 7 * DAY_MS) {
    const end = w + 7 * DAY_MS;
    let o = 0;
    let r = 0;
    let backlog = 0;
    for (const [item, t] of opened) {
      if (t >= w && t < end) o += 1;
      const rt = resolvedAt.get(item);
      if (t < end && (rt === undefined || rt >= end)) backlog += 1;
    }
    for (const t of resolvedAt.values()) if (t >= w && t < end) r += 1;
    weeks.push({
      weekStart: new Date(w).toISOString().slice(0, 10),
      opened: o,
      resolved: r,
      backlog,
    });
  }

  const byKindTiming = {} as Record<DecidedByKind, TimingSummary>;
  for (const k of DECIDED_BY_KINDS) byKindTiming[k] = summarize(hours[k]);
  const all = [...hours.human, ...hours.agent, ...hours.unknown];

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    decisions: {
      total,
      byKind,
      bySurface,
      changed,
      changedPct: total === 0 ? null : round2((changed / total) * 100),
    },
    timeToDecision: {
      measured: all.length,
      unmeasured,
      overall: summarize(all),
      byKind: byKindTiming,
    },
    tensions: { weeks },
  };
}

function fmtHours(h: number | null): string {
  if (h === null) return "—";
  return h < 1 ? `${round2(h * 60)}m` : `${h}h`;
}

function fmtKinds(c: KindCounts): string {
  return `human ${c.human} · agent ${c.agent} · unknown ${c.unknown}`;
}

export function renderReviewStats(s: ReviewStats): string {
  const lines: string[] = [];
  lines.push(`Review stats ${s.since.slice(0, 10)} → ${s.until.slice(0, 10)}`);
  lines.push("");
  lines.push(`Decisions: ${s.decisions.total} (${fmtKinds(s.decisions.byKind)})`);
  for (const surface of Object.keys(s.decisions.bySurface).sort()) {
    lines.push(`  ${surface}: ${fmtKinds(s.decisions.bySurface[surface] as KindCounts)}`);
  }
  lines.push(
    `  changed the vault: ${s.decisions.changed}` +
      (s.decisions.changedPct === null ? "" : ` (${s.decisions.changedPct}%)`),
  );
  lines.push("");
  const t = s.timeToDecision;
  lines.push(
    `Time to decision (first shown → decided): measured ${t.measured}, unmeasured ${t.unmeasured}`,
  );
  const timing = (label: string, x: TimingSummary) =>
    `  ${label}: n=${x.n} p50 ${fmtHours(x.p50Hours)} p90 ${fmtHours(x.p90Hours)}`;
  lines.push(timing("all", t.overall));
  for (const k of DECIDED_BY_KINDS) lines.push(timing(k, t.byKind[k]));
  lines.push("");
  lines.push("Tensions by week (opened / resolved / backlog at week end):");
  for (const w of s.tensions.weeks) {
    lines.push(`  ${w.weekStart}  ${w.opened} / ${w.resolved} / ${w.backlog}`);
  }
  return `${lines.join("\n")}\n`;
}

const HELP = `daftari review-stats — how much review is humans, and how fast.

Usage:
  daftari review-stats [--vault <path>] [--since <30d|4w|YYYY-MM-DD>] [--json]

Reads .daftari/review-log.jsonl (read-only) and reports decisions by kind
(human / agent / unknown), median and p90 time from first surfacing to
decision, the share of decisions that changed the vault, and tensions
opened / resolved / backlog per week. Default --since is 30d.

Exit codes:
  0 — report produced   2 — usage error
`;

function readStringArg(argv: string[], flag: string): string | undefined {
  const raw = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (raw === undefined) return undefined;
  const idx = argv.indexOf(raw);
  return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : argv[idx + 1];
}

export async function runReviewStats(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const vaultRoot = resolve(readStringArg(argv, "--vault") ?? ".");
  const now = new Date();
  const rawSince = readStringArg(argv, "--since") ?? "30d";
  const since = parseSince(rawSince, now);
  if (since === null) {
    process.stderr.write(
      `daftari review-stats: --since must be <n>d, <n>w or an ISO date (got '${rawSince}')\n`,
    );
    return 2;
  }
  const stats = reviewStats(readReviewEvents(vaultRoot), since, now);
  process.stdout.write(
    argv.includes("--json") ? `${JSON.stringify(stats, null, 2)}\n` : renderReviewStats(stats),
  );
  return 0;
}
