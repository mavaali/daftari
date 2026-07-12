// consensus-cb7-instances — assemble the CB7 decision-divergence instance set
// from artifacts that already exist. No new corpus, no new ground truth, no
// LLM calls: tension instances come from the CB6 second-rater-gated pairs,
// settled controls from the consensus box's own supersession chains, and
// stale traps from the CO2 revert diffs. Everything here is deterministic.
//
// Spec: docs/superpowers/specs/2026-07-11-corpus-b-cb7-decision-divergence-design.md

import type { TruePair } from "./consensus-cb4-pairs.js";
import type { TensionPair } from "./consensus-cb6-tension.js";
import type { ConsensusItem } from "./consensus-parse.js";
import { resolveCurrent } from "./consensus-resolve.js";

// The Trump-box item numbers that are CB6 tensions — the standard exclusion
// for buildSettledInstances over the Trump fixture.
export function tensionNumsFor(pairs: TensionPair[], article: string): Set<number> {
  return new Set(pairs.filter((p) => p.article === article).map((p) => p.num));
}

export type Cb7Bucket = "tension" | "settled" | "trap";

export interface Cb7Instance {
  id: string;
  bucket: Cb7Bucket;
  topic: string;
  // The two candidate wordings, semantically labeled. For a tension,
  // "governing" is the status quo (held by default, NOT by merit — ground
  // truth is that neither supersedes). For settled/trap it is the governing
  // consensus text.
  positionGoverning: string;
  positionOther: string;
  // What the collapsed (consolidation) memory holds: ONE value, no epistemic
  // metadata. Chosen deterministically per bucket — see the builders.
  collapsedValue: string;
  // The tension record carried by the held memory (tension bucket only).
  tensionNote: string | null;
}

// M-collapsed for a tension = the CHALLENGER position (the alternative).
//
// Deliberate deviation from the design spec's "the value the CB6 forced foil
// minted": the CB6 foil's per-instance verdicts were not committed as a
// fixture, and depending on them would make the instance set nondeterministic
// across reruns. The recency rationale is stronger anyway: in the real edit
// stream the challenger wording is the more recent assertion (that is what
// the CO1 reverts revert), so a last-write-wins consolidation memory holds
// it — the same failure shape Arm A embodies at `@before` in CO2. Recorded
// here so the results note can state the deviation.
export function buildTensionInstances(pairs: TensionPair[]): Cb7Instance[] {
  return pairs.map((p) => ({
    id: `tension:${p.article.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${p.num}`,
    bucket: "tension" as const,
    topic: p.topic,
    positionGoverning: p.statusQuo,
    positionOther: p.alternative,
    collapsedValue: p.alternative,
    tensionNote:
      `Unresolved tension (no consensus): neither wording has superseded the ` +
      `other. Provenance: ${p.rfc}`,
  }));
}

// Settled controls: consensus-box supersession chains. The superseded
// predecessor's text is the "other" wording; the resolved active terminal is
// the governing one. Deduped on the terminal (one instance per chain), and an
// instance is kept only when both statements are non-empty and differ — a
// chain whose predecessor text didn't parse can't make a two-sided case.
//
// Foil fairness (locked by test): M-collapsed holds the GOVERNING value here.
// The box is curated, so a consolidation memory over the box gets settled
// topics right — the control must not handicap the foil where it is correct.
//
// `excludeNums`: terminals that are CB6 tension items (e.g. Trump #48 — an
// active "no consensus on wording, but the status quo is X" item that also
// terminates a chain). The same topic must not sit in both the tension
// bucket and the hedge-tax control, or an escalation on it would be charged
// as a tax when it is arguably the right call.
export function buildSettledInstances(
  items: ConsensusItem[],
  excludeNums: ReadonlySet<number> = new Set(),
): Cb7Instance[] {
  const seenTerminal = new Set<number>();
  const out: Cb7Instance[] = [];
  for (const item of items) {
    if (item.status !== "superseded" || item.supersededBy.length !== 1) continue;
    const resolved = resolveCurrent(items, item.num);
    if (!resolved.resolved || !resolved.item) continue;
    const terminal = resolved.item;
    if (seenTerminal.has(terminal.num) || excludeNums.has(terminal.num)) continue;
    if (item.statement.length === 0 || terminal.statement.length === 0) continue;
    if (item.statement === terminal.statement) continue;
    seenTerminal.add(terminal.num);
    out.push({
      id: `settled:trump-${terminal.num}`,
      bucket: "settled",
      topic: `consensus item #${terminal.num}`,
      positionGoverning: terminal.statement,
      positionOther: item.statement,
      collapsedValue: terminal.statement,
      tensionNote: null,
    });
  }
  return out;
}

// Stale traps: the CO2 scorable revert pairs. M-collapsed holds the STALE
// text — the most recent assertion in the stream, exactly what Arm A holds at
// `@before` (CO2 measured that condition stale 33/33).
export function buildTrapInstances(pairs: TruePair[]): Cb7Instance[] {
  return pairs.map((p) => ({
    id: `trap:${p.revid}`,
    bucket: "trap" as const,
    topic: `consensus item #${p.governingNum}`,
    positionGoverning: p.govText,
    positionOther: p.staleText,
    collapsedValue: p.staleText,
    tensionNote: null,
  }));
}
