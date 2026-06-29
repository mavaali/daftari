# Corpus (B) consensus-bench — Wikipedia "Current consensus" supersession benchmark (Design)

**Date:** 2026-06-27
**Status:** Design — pending spec review + user approval, then writing-plans
**Author:** brainstorming session (Claude + Mihir)
**Sibling:** `docs/superpowers/specs/2026-06-22-contract-supersession-benchmark-design.md` (this spec deliberately mirrors its arms, buckets, and WIN/KILL discipline)

---

## Context

Daftari's bet pays off only where **minting fabricates** — a corpus that is *not*
cleanly recency-resolvable, where a deterministic recency extractor returns the
*wrong* value and an LLM-synthesized one *hallucinates*. The contract bench
(MCC) is one such corpus (recency fails by *scoped* supersession). Corpus (B) is
the second, independent corpus in the same regime but with the **opposite cause
of failure**: not drafting hygiene, but its total absence.

`Talk:<article>/Current_consensus` subpages (Donald Trump, COVID-19 pandemic,
Joe Biden, …) are **human-maintained, dated supersession graphs**: active items
are the current editorial consensus; superseded/canceled items carry pointers to
what replaced them (`Superseded by [[#C15|#15]]`). This is the corpus-(B) analog
of the contract amendment chain — the daftari resolution oracle *and* the
held-out ground truth, **free, no LLM labeler** (clears the contamination gate
on the ground-truth side).

### The regime, stated formally (same axis as contracts, opposite hygiene)

A corpus is in daftari's regime when **recency is not a valid resolution
function**: the correct current value of a query is *not* `argmax-by-timestamp`
over assertions in the messy stream.

- **Contracts** satisfy this by *scope* — the latest amendment touches a
  different clause; recency reads the newest doc and is wrong. Drafting hygiene
  keeps stale *restatements* near zero (>100:1 toward clean).
- **Wikipedia consensus** satisfies it by *re-litigation* — there is **no
  hygiene**. Humans re-argue, restate, and assert *against* settled consensus.
  The probe (`docs/superpowers/results/2026-06-27-corpus-b-recency-fails-probe.md`)
  measured this directly: **5–18% of recent article edits are reverted**, with
  explicit **consensus-citing reverts** (`"manual rv per consensus 76"`,
  `"partial rv per consensus 70"`) that restore the governing decision. The
  most-recent assertion in the stream ≠ the governing decision, frequently.

So the most-recent assertion must be read from the **messy stream** (article
edit history / talk re-litigation), NOT from the curated consensus box. The box
is curated: for the lead-sentence topic (11→17→50→70) its most-recent item *is*
the governing one (#70), so recency *over the box* would be **correct**. Recency
fails only in the stream. This is the load-bearing design choice: Arm A reads the
stream; the box is Arm C's oracle and the ground truth.

### What daftari already ships / has built for this

- `[DATA]` **`resolveCurrent`** (`integrations/consensus-bench/src/consensus-resolve.ts`)
  — follows a consensus item's `supersededBy` chain to the active governing item;
  dead-ends (a chain that ends at a superseded item with no in-corpus successor,
  e.g. `{4,15}`) return `resolved:false` and **never mint**. The
  `resolveCurrentSource` analog for corpus (B). Already built + tested.
- `[DATA]` **`parseConsensus`** + **`groupTopics`**
  (`consensus-parse.ts`, `consensus-topics.ts`) — parse the box into items with
  supersession edges; group into topics (connected components of the supersession
  graph). Real fixture (`Talk:Donald_Trump/Current_consensus`): 76 items → **63
  topics (9 multi-item supersession chains + 54 standalone active), 1 unresolved**
  (`{4,15}`). Already built + tested (15 green, tsc clean).
- `[DATA]` Daftari ships `resolveCurrentSource` (`src/search/current-source.ts`,
  SP-A) — the production "foreground the current source, never mint a value"
  mechanism. The bench arm reuses the *same resolution shape* on the consensus
  graph.

## Goal

Measure, on real Wikipedia consensus articles, whether **edge-resolution
(daftari) beats recency-extraction (the deterministic stream reader) and
LLM-synthesis on current-consensus queries**, and whether daftari's never-mint
design produces **near-zero fabrication** where the other two arms invent values —
including the keystone case where daftari must refuse to present a *still-contested*
topic as settled.

Produce the second corpus (independent of contracts) that either validates
daftari's regime claim or kills it. Together with the contract bench, this is the
empirical core of §6.1 of the paper ([[project_daftari_paper]]).

## Non-goals

- Not a Wikipedia-editing or consensus-prediction system. We test **current-value
  resolution** under supersession, nothing else.
- No cross-system leaderboard claim. The contribution is the **within-corpus arm
  comparison** (recency vs synth vs daftari), same posture as contracts and the RB
  ablation.
- Cortex-**acquired** edges from the archives are **deferred to CO4**, gated on the
  oracle arm (CO3) winning. Mirrors the SP1→SP3 and CB3→CB4 oracle-first split.
- No `hybrid.ts` ranking change. Resolution is a chain-follow, not a re-rank.
- Not a market/cost probe. The cost-of-fabrication market thesis is dead
  (edge ⊥ stakes); corpus (B) is a **paper mechanism-proof**, lower priority than
  the Track-1 demand validation. It must not crowd that out.

## Corpus: Wikipedia "Current consensus" + article revision history

`[DATA]` Source: the Wikipedia API (unthrottled, no auth; pull with a descriptive
`User-Agent`). Two layers:

1. **The consensus box** — `Talk:<article>/Current_consensus` (raw wikitext via
   `?action=raw`). The human-maintained supersession graph. Ground truth + Arm C
   oracle. Trump fixture already committed
   (`integrations/consensus-bench/src/__fixtures__/trump-current-consensus.wikitext`).
2. **The article revision history** — `prop=revisions` (rvprop=comment|timestamp|ids|user,
   plus content snapshots at the instances we keep). The messy stream Arm A reads,
   and the source of the deterministic labeling signal.

Staged scope: **Trump first** (the rich case — ~214 talk archives, 18% revert
rate, 76 consensus items). Scale to COVID-19 / Joe Biden / other formal-consensus
articles only if the Trump pilot clears the gate.

### Contamination handling (binding; weaker lever than contracts)

`[DATA]` These are public, training-data-heavy topics. Two mitigations:

1. **Post-cutoff anchor (primary defense).** Trump items **#67–76 are 2025–26**,
   after the model knowledge-cutoff. The pilot and the clean test set live here.
   This is the robust defense — stronger than perturbation for this corpus.
2. **Pre-cutoff extension via perturbation (secondary, limited).** Only where a
   coherent perturbation exists — numeric/factual items (dates, counts, named
   entities) can be perturbed; wording-*decision* items mostly cannot. Reported as
   a **separate** set, never pooled with the post-cutoff anchor. Honest note:
   perturbation is weaker here than in contracts; do not lean on it.

## Ground-truth construction (CO1 — the hard part, the durable artifact)

The genuinely new work vs the contract bench. The box gives the *resolution*
ground truth for free; the labeling problem is connecting **stream assertions** to
**box topics** deterministically. The probe established this is solvable without an
LLM aligner:

1. Pull article revision history (Trump) via the API.
2. Deterministically parse **consensus-citing reverts** — edit summaries matching
   a citation of a consensus item: `\b(rv|revert|undid|undo|restore)\b` near
   `consensus\s*#?\s*(\d+)` **or** an anchor wikilink `\[\[[^]]*#C(\d+)`. Each
   match yields a labeled instance: at revision `T` a recent edit asserted a
   **non-governing** value on topic `#N`; an editor reverted to the governing
   item, **citing #N**.
3. That citation is **editor-provided alignment** (stale assertion → governing
   item #N). No LLM aligner → no contamination on the labeling side.
4. Ground truth for the instance = the consensus box resolved via
   `resolveCurrent(items, N)` to its active terminal.
5. Emit a **human-readable instance dump** (revision id, timestamp, edit summary,
   the reverted diff snippet, parsed #N, resolved terminal) for Mihir spot-check —
   same discipline as the contract pair-dump and the SP2 oracle-builder dump.

**Labeling discipline (locked):** score only instances where alignment is
citation-anchored and stale-vs-novel is determinable from the diff. No LLM
aligner. Small N is the accepted cost.

### Honest precision (carried from the probe, do not overclaim)

A consensus-citing revert proves *most-recent assertion ≠ governing decision*
(recency fails, broadly). It does **not** by itself prove the reverted edit was a
*stale restatement* (re-asserting a specifically superseded value) vs a *novel*
non-consensus edit. Both defeat recency, but the cleanest daftari case is the
stale-restatement subset. The split is determinable per-instance from the diff +
edit summary; record it as an instance attribute, report both.

## QA buckets (3 + the no-mint probe)

- **current-decision** (control) — "current consensus on topic X?" for a settled
  active topic that is *not* in active re-litigation. All arms should pass: Arm A
  reads the *stable* article passage (governing for non-relitigated topics), Arm C
  resolves to the active item. Guards against daftari "winning" merely by always
  returning something; a daftari miss here is a parse/resolve bug, not a finding.
- **stale-restatement-trap** (headline / discriminating) — the consensus-citing
  revert instances. Arm A returns the most-recent (reverted) stale value → wrong;
  Arm C resolves the chain → the governing terminal → right. This is where daftari
  must win.
- **live-tension-not-supersession** (the keystone — the thesis's *"a tension may
  never masquerade as a supersession"*, [[project_daftari_thesis]]) — a genuinely
  still-contested topic: an **active box item explicitly recording "no consensus"**,
  or **bidirectional edit-warring with no consensus-citing stabilization**. Arm C
  must **refuse to present it as settled** (return contested / no single governing
  value); recency and Arm B are tempted to mint one. Honest caveat: small N; this
  is daftari's distinctive guarantee, kept even at small N.
  **Correction (2026-06-28, CO1 planning, evidence-driven):** the originally-planned
  "active 'no consensus' box item" source is **invalid** — inspecting the real
  fixture, the active items matching `/no consensus/i` (#48, #56, #65) are *settled*
  decisions ("no consensus on wording, **but** the status quo is {...}"), each with a
  governing value — the opposite of a tension. The box holds only *settled* items by
  nature; a genuine live tension lives in the **open stream** (unresolved RfC /
  sustained edit-war with no consensus-citing stabilization). So the keystone bucket
  is **stream-sourced and best-effort**, deferred to its own pass after CO1; CO1
  leaves it empty and guards against mis-tagging settled "no consensus" items.
- **no-mint probe** (fabrication test) — ask current consensus on a topic that has
  **no consensus item** (absent) or a **dead-end chain** (`{4,15}`). Correct =
  "not present / cannot determine." Arm C refuses (`resolved:false`, already built
  + tested); Arm B may fabricate; Arm A returns the nearest stream value (record
  as fabrication-of-sorts). **This bucket is box-derived, NOT stream-derived:** its
  instances come from absent topics / dead-end chains in the consensus box, *not*
  from the consensus-citing-revert parser (a citing revert names a live governing
  item, so it never yields a no-mint case). Do not wire CO1's revert parser to feed
  this bucket.

## Arms

| Arm | Mechanism | The failure it embodies |
|---|---|---|
| **A. Recency-extraction** | Deterministic, zero-LLM: for topic X, return the topic-X passage value as of the **most-recent (reverted) edit** in the stream. The strong recency baseline (most-recent *on-topic* assertion, not global latest). **Passage-localization** (mapping a box topic #N to the article passage it governs, so the right reverted value is read) is the least-specified mechanism and is **the first question CO2's plan must resolve** — content snapshots at kept instances are pulled in CO1 to support it. | "Deterministic stream reader returns the stale value" (stale-restatement-trap) |
| **B. LLM-synthesis** *(gated — see WIN/KILL)* | Feed retrieved archive text to an LLM; ask it to state the current consensus on topic X as a single answer, with an explicit "say cannot-determine if unclear" instruction (the charitable baseline). | "Synthesized value hallucinates" (no-mint probe; live-tension confabulation) |
| **C. Daftari (oracle edges)** | `parseConsensus` → `groupTopics` → `resolveCurrent` over the box's `supersededBy` edges → the active governing terminal; refuses (`resolved:false`) on dead-ends and tensions. Never mints. | The thesis under test |

Arm A is a **faithful foil**, not a strawman: on a stale-trap item it must return
the *wrong* (stale) value — a unit test asserts exactly this.

## Architecture (simpler than contracts — no vector store for A/C)

Pure Node + Wikipedia API. Arm A and Arm C are graph/text resolution; **no MiniLM /
no vector store** needed. Only the gated Arm B needs an LLM (+ a blind cross-judge,
OpenRouter second-rater per [[reference_openrouter_second_rater]]). Reuse the
already-shipped `consensus-parse` / `consensus-resolve` / `consensus-topics`
modules.

```
revision history (API) ─► parse consensus-citing reverts ─► labeled instances {topic #N, stale value, T, novel|stale}
consensus box (fixture) ─► parseConsensus ─► groupTopics ─► resolveCurrent   (Arm C oracle + ground truth)
                                          │
qa-build ─► {current-decision | stale-restatement-trap | live-tension | no-mint} buckets
                                          ▼
   per QA:  Arm A recency   │   [gated] Arm B synth(LLM)   │   Arm C resolveCurrent
                                          ▼
              per-bucket accuracy + fabrication rate + tension-respect rate
```

- **Edges are oracle in CO3** (from the box, trust=1) — the SP2/CB3 oracle posture:
  the *resolution code under test is what ships*; only the edge source is
  ground-truth rather than acquired.
- **All API responses are fixture-backed in tests** — committed revision snapshots
  + the committed box wikitext; **no network in the test suite**. Acquisition code
  has a thin fetch layer behind an interface so tests inject fixtures.

## Metrics

- **Primary — stale-restatement-trap accuracy** (current-value match), per arm.
  Thesis: C ≫ A (A is structurally incapable; B confabulates).
- **Fabrication rate — no-mint probe**: fraction of queries where the arm returns a
  concrete value instead of "not present." Thesis: C ≈ 0; B > 0; A returns nearest
  on-topic value (record it).
- **Tension-respect rate — live-tension bucket**: fraction where the arm correctly
  refuses to present a contested topic as settled. Thesis: C ≈ 1; A, B tempted to
  mint.
- **Control — current-decision accuracy**: C must be ≥ A (no regression on the easy
  case). A daftari miss here is a parse/resolve bug, isolated from the thesis.
- Report bucket sizes; the stale-vs-novel split; the post-cutoff vs perturbed
  split; resolve spot-check pass rate.

## The pilot gate (cheap falsifier, runs FIRST)

The contract-bench discipline: **on #67–76 only**, confirm Arm A (recency)
actually fails before scaling acquisition to the full history / other articles.
If recency already recovers current consensus on the post-cutoff items, the win
localizes to the tension/tainted subset — know that cheaply, first, before
building the full pipeline. Build Arm A + Arm C, run the pilot, gate everything
else on it.

## WIN / KILL conditions

- **WIN** — C materially beats A on **stale-restatement-trap**, *and* C's
  fabrication ≈0 on the **no-mint probe** where B fabricates, *and* C respects the
  **keystone** (refuses to settle a live tension) where A/B mint. First independent
  corroboration (alongside contracts) that daftari has a real niche.
- **KILL** — A ties C on stale-restatement-trap (re-litigation turns out
  recency-resolvable once extraction is keyed on the topic passage). The
  load-bearing falsifier; the pilot gate tests it cheaply on #67–76.
- **Partial** — C beats A only with **oracle** edges (CO3), and CO4 later shows
  archive edges can't be acquired unaided → niche is real but gated on a curation
  cost; that cost becomes the honest headline. (The CO4 acquired-edge arm is the
  publishable contribution either way.)

## Decomposition (sub-projects, each spec→plan→impl; "CO" = consensus corpus)

- **CO1** — acquisition + ground-truth: revision-history pull (fixture-backed),
  consensus-citing-revert parser, instance dump, QA-bucket build. The data
  artifact; outlives the experiment. **Arm A's acquisition lives here — the
  immediate build after this spec.**
- **CO2** — Arm A (recency resolver) + *(gated)* Arm B (LLM-synth + blind judge).
- **CO3** — Arm C wiring (`resolveCurrent` + box ground truth). **Mostly already
  built** (parse/resolve/topics shipped).
- **CO4** — *(deferred, gated on CO3 win)* cortex-acquired supersession edges from
  the archives — "can daftari acquire this unaided." The publishable contribution.
- **CO5** — synthesis + writeup → §6.1 of [[project_daftari_paper]].

## Testing (mirrors `src/`, hermetic)

- **revert parser** unit — on fixture edit summaries: matches `rv per consensus 76`
  and `[[…#C70|consensus 70]]`; rejects non-citing reverts and plain edits; extracts
  the right #N. Includes a near-miss ("per the consensus we reached" with no number)
  asserted to NOT match.
- **qa-build** unit — bucket assignment correctness (current-decision vs
  stale-trap vs live-tension vs no-mint), including the `{4,15}` dead-end → no-mint
  and a "no consensus" active item → live-tension.
- **Arm A foil** unit — on a stale-trap fixture, asserts Arm A returns the *stale*
  (wrong) value — proves it is a faithful foil, not a strawman.
- **Arm C** unit — reuses the shipped resolve/topics tests; adds ground-truth
  lookups for the pilot items.
- **acquisition fetch layer** — fixture-injected; no network in tests. A separate,
  non-suite script does the real API pull and writes fixtures.
- Re-use root `npm test` (auto-globs `integrations/**`).

## Risks / open questions

- **Revert-parser precision is the main correctness risk.** Mitigated by the
  human-readable instance dump + Mihir spot-check + golden fixtures. `[HYPOTHESIS]`
  consensus-citing summaries are formulaic enough (`rv per consensus #N`) that a
  deterministic parser clears most cases; **kill:** if >20% of citing reverts need
  hand-resolution, the labelability claim weakens and the corpus is more expensive
  than advertised.
- **Usable N is small** (post-cutoff #67–76; ~13 consensus-citing reverts per 500
  Trump revisions). Most signal is Trump-class. Mitigate by scanning deeper history
  for the citing-revert subset and by adding articles only post-pilot. Report N
  honestly; do not silently truncate.
- **stale-vs-novel ambiguity** — a citing revert may target a novel non-consensus
  edit, not a specifically-superseded value. Record the split; the headline thesis
  rests on the stale subset but both defeat recency.
- **live-tension bucket may be thin** — genuinely-contested-yet-labelable topics are
  rarer than supersessions. Accept small N; it tests the distinctive guarantee.
- **Contamination residue** — post-cutoff handles memorization for #67–76;
  structural memorization of article *form* is fine (we measure consensus values,
  not prose form). Perturbation is a weak secondary, reported separately.
- **Arm B prompt sensitivity** — fabrication/tension-respect is the robust signal;
  run with the charitable "cannot-determine" instruction so a fabrication *with*
  that instruction is a strong finding.

## Definition of done

- **CO1**: Trump revision history fixture-backed; consensus-citing-revert parser +
  instance dump (spot-checked); QA buckets built across the 4 categories with
  bucket sizes reported.
- **CO2+CO3**: Arm A, Arm C runners produce a per-bucket report (stale-trap
  accuracy, fabrication rate, tension-respect rate, control accuracy). Arm B built
  but run only if the pilot doesn't already separate A from C.
- **Pilot verdict** on #67–76 stated explicitly against the kill condition — a
  one-line verdict (regime confirmed: C≫A on stale-trap, C fabrication≈0, keystone
  respected — or regime collapsed: A≈C) with the numbers, not a hedge.
- A short results note in `docs/superpowers/results/`, cross-system caveat stated,
  feeding [[project_corpus_b_consensus_bench]], [[project_contract_supersession_benchmark]],
  and [[project_daftari_paper]].
