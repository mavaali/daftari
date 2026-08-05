// Triage — the UNRANKED mode of the court. Where the docket briefs and
// priority-ranks open tensions (stale-first, then blast) toward a ruling, the
// triage card deliberately does NOT rank: it lists every live tension grouped
// by cluster, enriched with blast and per-side tier/confidence/read-heat, and
// leaves the ordering judgment to the human. Legibility before automation.
//
// Rendering is pure (no stdout) so it can be asserted directly; the court
// entrypoint wires the vault load (loadTensionTriage) and prints the string.

import type { TensionTriageResult, TriageSide, TriageTension } from "../curation/tension-triage.js";

export const TRIAGE_DEFAULT_LIMIT = 50;
export const TRIAGE_DEFAULT_WINDOW_DAYS = 30;
const CLAIM_WIDTH = 100;

function truncate(text: string, width: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= width ? oneLine : `${oneLine.slice(0, width - 1)}…`;
}

function renderReadHeat(side: TriageSide): string {
  const rh = side.read_heat;
  if (rh === null) return "read unknown";
  if (rh.count === 0) return rh.instrumented ? "read 0 (cold)" : "read 0 (pre-log)";
  const day = rh.last_read ? rh.last_read.slice(0, 10) : "?";
  return `read ${rh.count} (last ${day})`;
}

function renderSide(label: string, side: TriageSide): string[] {
  const tier = side.tier === null ? "—" : String(side.tier);
  const conf = side.confidence === null ? "—" : side.confidence;
  const crit = side.criticality === null ? "—" : side.criticality;
  const prov = side.provenance === null ? "—" : side.provenance;
  const by = side.updated_by === null ? "—" : side.updated_by;
  const head = `    ${label}  ${side.path}  ·  tier ${tier} · conf ${conf} · crit ${crit} · prov ${prov} · by ${by} · ${renderReadHeat(side)}`;
  const claim = `       "${truncate(side.claim, CLAIM_WIDTH)}"`;
  return [head, claim];
}

function renderBlast(t: TriageTension): string {
  if (t.primary_blast === null || t.advisory_blast === null) return "blast unavailable";
  return `blast ${t.primary_blast} primary / ${t.advisory_blast} advisory (hidden: ${t.hidden_downstream ?? "none"})`;
}

function renderTension(t: TriageTension): string[] {
  const lines: string[] = [];
  lines.push(`  [${t.id}] ${t.kind} · ${t.age_days}d old · ${renderBlast(t)}`);
  lines.push(...renderSide("A", t.a));
  lines.push(...renderSide("B", t.b));
  return lines;
}

// Pure renderer — takes the engine result and produces the terminal card.
export function renderTriageCard(
  result: TensionTriageResult,
  limit: number = TRIAGE_DEFAULT_LIMIT,
): string {
  if (result.tension_count === 0) return "No open tensions.\n";

  const shown = result.clusters.slice(0, limit);
  const clusterWord = result.cluster_count === 1 ? "cluster" : "clusters";
  const tensionWord = result.tension_count === 1 ? "tension" : "tensions";

  const lines: string[] = [
    `${result.tension_count} open ${tensionWord} across ${result.cluster_count} ${clusterWord}.`,
    "",
  ];

  for (const c of shown) {
    lines.push(`━ ${c.cluster_id} (${c.documents.length} docs: ${c.documents.join(", ")})`);
    for (const t of c.tensions) {
      lines.push(...renderTension(t));
    }
    lines.push("");
  }

  const hidden = result.cluster_count - shown.length;
  if (hidden > 0) {
    lines.push(
      `… ${hidden} more ${hidden === 1 ? "cluster" : "clusters"} not shown (raise --limit).`,
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
