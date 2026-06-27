# Spec — E2: EDGAR chain-discovery tooling (contract-bench realism run)

**Date:** 2026-06-26
**Branch:** `feat/contract-bench-arms`
**Decomposition parent:** `docs/superpowers/handoffs/2026-06-26-contract-bench-edgar-realism-pickup.md` (E2 of E1–E4)
**Builds on:** E1 (shipped) — `docs/superpowers/specs/2026-06-26-e1-edgar-acquisition-design.md`. Reuses E1's `fetchFiling`/`htmlToText`/`buildChainDocs`/`parseCitations` wholesale.
**Related:** `docs/superpowers/specs/2026-06-22-contract-supersession-benchmark-design.md` (parent methodology), memory `project_contract_supersession_benchmark`.

## Why this exists

E1 proved a *single* real chain (NGS TCB A&R Credit Agreement) pulls and converts to `parseCitations`-ready text. E2 answers: **can we find such chains at scale, automatically, and which are labelable enough to use?** Per the decomposition (and the user's choice), E2 is **discovery tooling first** — a deterministic pipeline that auto-discovers prolific amenders, reconstructs their chains, scores each chain's labelability, and emits a ranked candidate set plus the **natural-unrecoverable-rate distribution** (itself a publishable finding about how labelable real amendments are). The final N≥20 curated benchmark is a *consume-the-output* follow-on (E3-adjacent), not this tool.

This sub-project gets its own spec → plan → impl cycle.

## Scope

### Goal & boundary
A zero-LLM EDGAR chain-discovery pipeline that produces, from a broad full-text query: a ranked candidate-chain manifest, E1-format seed JSONs for selected chains, per-chain human-readable `pairs.md` dumps, and the unrecoverable-rate distribution report — verified by a human spot-check of a sample.

**In scope (E2):**
- The discovery pipeline (units below), reusing E1.
- One real run over a broad credit-agreement query producing the ranked candidate set + distribution report.
- A human spot-check of a sampled chain's `pairs.md` against the source filings.

**Out of scope (named displacements):**
- Running `assemble()` / Arm A / Arm C → **E3**.
- The final N≥20 hand-curation → an E3-adjacent consume step (E2 *produces the ranked candidates*; a human finalizes).
- Agreement types beyond credit agreements (mechanism is general; the initial query is credit-focused) → later.
- The `unamended` bucket; LLM-assisted clustering (zero-LLM by choice).

### Done-criterion
`node discover-edgar.mjs '<broad-query>'` produces: (1) a ranked manifest of candidate chains (chain → unrecoverable rate, unit-type, length, CIK), (2) E1-format seed JSONs for the chains passing the selection gate, (3) per-chain `pairs.md`, (4) the unrecoverable-rate distribution report — **and** a human has spot-checked one selected chain's `pairs.md` against the filings and confirmed the parser's annotations. The NGS A&R chain (already E1-verified) should appear as a selected candidate, serving as a known-good anchor.

## Architecture — sequential units of one pipeline

```
broad EFTS query ─► tallyCiks ─► top-N CIK worklist
                                      │  (per CIK, serial, throttled)
        EFTS(ciks=) ─► parsePreamble ─► reconstructChains ─► candidate Seed[]
                                      │
        scoreChain (reuse E1 buildChainDocs + parseCitations) ─► {unrecoverableRate, unitType, length, opCounts}
                                      │
        rankCandidates ─► manifest + seeds + pairs.md + distribution report ─► [human spot-check]
```

Each unit is its own file + test (mirrors E1's pure-core/thin-IO split; tests hermetic, network only in the runner):

1. **`efts-search.ts`** — `searchFullText(query, opts)`: query EDGAR full-text search (`https://efts.sec.gov/LATEST/search-index`), handle pagination and the **10k result-window cap** (proven: ~100 hits/page, `hits.total.value` caps at 10000). Returns normalized hits `{cik, accession, filename, formType, fileDate, description}`. Pure parsing of an EFTS JSON response is separated from the network call (curl+UA, injectable transport — same pattern as E1's `fetchFiling`) so parsing is hermetically testable against a recorded fixture.
2. **`cik-tally.ts`** — `tallyCiks(hits): {cik, count}[]` ranked by amendment-exhibit frequency. The worklist source (auto-discovery). Pure.
3. **`preamble.ts`** — `parsePreamble(text): {ordinal, baseDate, agreementType} | null`. The linkage extractor. Pulls the ordinal (`First/Second/Third…Amendment`), the base date (`dated as of <date>`), and the agreement type (`Credit Agreement`) from an amendment's opening. **Verified live 2026-06-26:** NGS amd-1 yields `{First, "February 28, 2023", "Credit Agreement"}`. Pure.
4. **`reconstruct.ts`** — `reconstructChains(cik, docs): Seed[]`: group a CIK's amendment exhibits by `(agreementType, baseDate)` signature, order by ordinal, identify the base, emit E1-format `Seed`s. Pure (operates on already-fetched `{ref, text}` records).
5. **`score.ts`** — `scoreChain(seed, opts): ChainScore`: reuse E1's `buildChainDocs` → `parseCitations` per doc → `{unrecoverableRate, unitType, length, opCounts, perDoc}`. Thin reuse of E1.
6. **`select.ts`** — `rankCandidates(scores, opts): {selected, distribution}`: filter (length ≥ 3, unrecoverableRate ≤ `maxUnrecoverable`), rank, partition by unit-type; compute the full distribution. Pure.
7. **`discover-edgar.mjs`** — the runner wiring all stages: broad query → tally → top-N CIKs → per-CIK fetch+reconstruct → score → rank → write manifest + seeds + `pairs.md` + report. Network via curl+UA, throttled; reuses E1's `.edgar-cache/`.

## The hard part — preamble linkage + base identification (the dominant risk)

`reconstructChains` is the load-bearing, failure-prone step. Rules:
- **Group** a CIK's amendment exhibits by their preamble `(agreementType, baseDate)` signature — this is what deterministically separates NGS's 2023 A&R chain (`dated as of February 28, 2023`) from its older 2012 Chase chain. Amendments whose preamble doesn't parse (`parsePreamble` → null) are dropped from chain assembly and **counted** (a reported coverage stat).
- **Order** within a group by ordinal (First < Second < …).
- **Identify the base** (looser-but-reasonable rule, user-approved): the base is the CIK filing that *is* the agreement dated `<baseDate>` (an "Amended & Restated …" counts as a master). **If no separate base filing is found, base = the earliest doc in the linked amendment set** (the chain is amendments-only; still usable — `resolveChain` treats `ordered[0]` as master). The chain records which case applied.
- A reconstructed chain with fewer than 3 docs (base + <2 amendments) is emitted but flagged below the scoped-current minimum (see selection).

**Risk + mitigation:** preamble formats vary across filers. Mitigation = (a) hermetic fixture tests on the verified NGS preambles, (b) the **human spot-check gate** before E3, (c) `parsePreamble` returning null (not a wrong guess) on unrecognized formats, with the null-rate reported. Kill signal: if the null-rate is high across the run, the linkage heuristic is too narrow — widen `parsePreamble` patterns before trusting the corpus.

## Scoring, selection, and the labelability finding

- `scoreChain` computes **unrecoverableRate = unrecoverable ops / total ops** across the chain's amendments (E1's `parseCitations` already classifies recoverable vs unrecoverable; CB1 saw 53–55% on a dense MSA — real amendments are partial-edit-dominated).
- **Selection gate (both tunable params, the distribution reported regardless):**
  - `minLength = 3` (base + ≥2 amendments — the minimum for a scoped-current case to *exist*: an earlier amendment governs a clause the latest doesn't touch).
  - `maxUnrecoverable = 0.20` **default — a deliberately *generous* cutoff (user-noted).** Because the **full distribution is always reported** and selection is a pure re-rank over already-scored chains, tightening to e.g. 0.10 is free and needs no re-acquisition. The 20% default is the handoff's labelability kill-metric; document it as lenient and trivially tunable.
- **The distribution report is a first-class output**, not a byproduct: the natural unrecoverable-rate histogram across all reconstructed chains is the publishable labelability finding (how often real amendments are even cleanly labelable). Selection is downstream of, and never replaces, this report.

## Output + the spot-check gate

The runner writes (under a gitignored output dir, like `.edgar-cache/`):
- **`manifest.json`** — every reconstructed chain with `{chainId, cik, agreementType, baseDate, length, unitType, unrecoverableRate, selected: bool, baseCase: "filed"|"earliest"}`.
- **`seeds/<chainId>.json`** — E1-format seeds for **selected** chains (ready for E1's `buildChainDocs` / E3's `assemble`).
- **`pairs/<chainId>.md`** — per selected chain, the `parseCitations` annotation dump (clause → op → recoverable) for human spot-check.
- **`distribution.md`** — the unrecoverable-rate histogram + null-preamble rate + unit-type breakdown.

**Spot-check gate (required before E3 consumes):** a human verifies one selected chain's `pairs/<chainId>.md` against the actual filings — does the parser's clause→op annotation match the contract text? Parser accuracy on *real, varied* chains is the dominant correctness risk (the project's "labels are the canary for ungrounded generation" discipline). The tool *proposes*; a sampled human verification *confirms*. E2's done-criterion includes this spot-check, anchored on the known-good NGS chain plus one unfamiliar selected chain.

## Testing — no network in CI

- **`efts-search.test.ts`** — parse a **recorded EFTS JSON fixture** (`src/__fixtures__/efts/*.json`, a real captured response) into normalized hits; pagination/window logic unit-tested with a fake transport. No live EFTS in CI.
- **`preamble.test.ts`** — against the committed NGS amendment fixtures (reuse E1's `amd1.htm`/`amd2.htm` via `htmlToText`): `parsePreamble(htmlToText(amd1))` → `{ordinal:"First", baseDate:"February 28, 2023", agreementType:"Credit Agreement"}`; unrecognized format → `null`.
- **`reconstruct.test.ts`** — a synthetic two-chain CIK (two different `baseDate`s, same agreement type) must split into two chains, each ordered, base identified; an amendments-only group falls back to earliest-as-base.
- **`cik-tally.test.ts`** — ranks CIKs by frequency from a hit list.
- **`score.test.ts`** — reuse E1 on the NGS chain (or a small fixture chain) → known unrecoverable rate / unit-type; **a Section-op and a defined-term chain both score correctly** (both paths, per E1's two oracles).
- **`select.test.ts`** — filter + rank + distribution math on synthetic scores; verify `maxUnrecoverable`/`minLength` are honored and the distribution counts all chains regardless of selection.
- The live run (broad EFTS query → real corpus) is exercised by `discover-edgar.mjs` manually, not in CI.
- Conventions (CLAUDE.md): no classes; fallible IO returns `Result`-style unions, no throw across boundaries; `"type":"module"`/NodeNext `./x.js`; tests mirror `src/`. Build `cd integrations/contract-bench && npx tsc`; test `npx vitest run`.

## Decisions (settled — do not relitigate)

- **Discovery tooling first**, not hand-curation — the durable artifact is the pipeline; the curated set falls out of scores. *(User-selected.)*
- **Per-CIK + preamble-reference linkage**, not global clustering or LLM clustering — deterministic, auditable, zero-LLM. *(User-selected.)*
- **Auto-tally CIKs from a broad query**, not a hand-seeded list — real discovery. *(User-selected.)*
- **Looser base-identification** (filed-base else earliest-in-set) — accepted as reasonable. *(User-approved.)*
- **`maxUnrecoverable = 0.20` default, tunable, full distribution always reported** — accepted as generous. *(User-approved.)*
- **Credit-agreement-focused initial query**, mechanism general. *(User-approved.)*

## Risks & assumptions

- **[HYPOTHESIS — dominant risk] `parsePreamble`/`reconstruct` accuracy across varied filers.** Mitigated by null-not-guess, the reported null-rate, fixture tests, and the human spot-check gate. Kill: high null-rate ⇒ widen patterns before trusting the corpus.
- **[ASSUMPTION] EFTS 10k-window is sufficient for ranking top amenders.** The window returns the most-relevant 10k hits; tallying CIKs over them surfaces prolific filers. If top-amender ranking proves unstable, date-window the query into slices (deferred unless needed).
- **[ASSUMPTION] selection over already-scored chains is pure** — so re-running selection at a tighter threshold needs no re-acquisition (the cache + scored manifest persist).
- **Contamination:** discovery reads public filings; E3's perturbation handles measured values. Out of E2 scope.
- **SEC fair-access:** curl + compliant UA, throttle (proven in E1); `WebFetch` 403s. The broad query + per-CIK queries are additional EFTS calls — throttle them too.

## What E2 explicitly does NOT decide

- The final benchmark composition / N (E3-adjacent human curation consumes E2's ranked output).
- Answer normalization, the arms, the `unamended` bucket (E3).
- Non-credit agreement types (mechanism supports them; initial query is credit-focused).
