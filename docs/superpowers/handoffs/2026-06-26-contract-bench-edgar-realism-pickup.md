# Handoff — Contract-bench EDGAR realism run (the regime question)

**Date:** 2026-06-26
**Branch:** `feat/contract-bench-arms` (cut clean from main @ v1.29.0; CB1 + arms + runner live here, NOT pushed)
**One-line:** The synthetic falsifier validated the *mechanism* (daftari's clause-scoped `resolveCurrentSource` beats recency on scoped-current, never mints). The EDGAR run answers the *regime* question it cannot: **do real contract amendment chains actually contain the STALE structure** (later docs mentioning a clause without governing it) **often enough that clause-keyed recency fails?** That frequency is the publishable real-world finding.

## Where things stand (read first)

- **Mechanism: WIN (2026-06-25).** Synthetic two-variant kill race: STALE → daftari 1.0 vs recency 0.0 on scoped-current (Δ1.0, 0 fabrication); CLEAN → 1.0=1.0 tie (clean scoped supersession *is* recency-resolvable). Results: `docs/superpowers/results/2026-06-25-synthetic-contract-supersession.md`. This greenlit the EDGAR run.
- **CB1 pipeline is built + 63 tests green** on this branch (`integrations/contract-bench/`): `citation-parse`, `clause-edge`, `perturb`, `qa-build`, `corpus`, `serialize`, `assemble` (+ the arms `synth-gen`, `arm-recency`, `metrics` and `falsifier-runner.mjs`). Build: `cd integrations/contract-bench && npx tsc`; test: `npx vitest run --root integrations/contract-bench`.
- **Specs:** `docs/superpowers/specs/2026-06-22-contract-supersession-benchmark-design.md` (parent methodology — arms A/B/C, buckets, kill condition), `docs/superpowers/specs/2026-06-25-synthetic-contract-supersession-falsifier-design.md` (the mechanism variant + the EDGAR deferral). Prior CB1 build pickup: `docs/superpowers/handoffs/2026-06-24-contract-bench-cb1-pickup.md`.
- **Memory:** `project_contract_supersession_benchmark` (full arc + the 2026-06-25 CB2/CB3 banner).

## Why EDGAR, not MCC (settled — don't relitigate)

MCC (Stanford, arXiv 2504.02864) was **probed and ruled out as a chain corpus** (2026-06-25): it has a binary `amendment` flag (~29% of 1.04M docs) but **zero cross-document linkage and zero clause annotation** — it cannot tell you which master an amendment amends, nor which clause. The only pre-linked corpus (Song 2021, arXiv 2106.14619) is confidential. ISDA CSAs are the best structural match but not public. **EDGAR Exhibit-10 filings are the source** (MCC is built from them); chains must be reconstructed, not downloaded.

## What the EDGAR run must produce

Real master→amendment chains, clause-annotated, run through the EXISTING `assemble()` → Arm A (recency) vs Arm C (daftari) on the four buckets, **plus the headline real-world metric: the natural frequency of scoped-current-with-stale-mention** (how often latest ≠ governing AND a later doc mentions the clause with a non-governing value). That frequency is what the synthetic run could not give.

## Acquisition path (the net-new work)

1. **Pull Exhibit-10 chains from EDGAR.** Seed chain candidates from the exhibit *description* strings ("Amendment No. 2 to Master Services Agreement"), same CIK + agreement type + contract number cross-references in the body. The `edgar-crawler` toolkit (github.com/lefterisloukas/edgar-crawler) pulls Exhibit-10 filings; or hit EDGAR's full-text/filing endpoints directly.
   - **SEC fair-access gotcha (PROVEN in CB1):** `WebFetch` is **403'd by SEC**. `curl` with a compliant `User-Agent` (a real contact string, per SEC policy) works. Throttle to SEC's rate limits.
2. **`htmlToText` entity-decoder (REQUIRED, net-new).** EDGAR HTML uses entities — quotes are `&#8220;`/`&#8221;`, not literal `"`/`"` — and tag-wrapped term names. The existing parser keys on quoted terms and "as follows:"; a regex-strip is insufficient (proven on the NGS doc). Build a real `htmlToText` that decodes entities + handles tag-wrapped names BEFORE feeding text to `parseCitations`.
3. **Build `ChainDoc[]` and run `assemble()`.** Each filing → `{id, order, text}` (order by filing date). `assemble(rawDocs, {seed, noValueClauses})` already perturbs, resolves clause edges, builds buckets + the atomized vault. **No pipeline rebuild** — this is the payoff of CB1.
4. **Clause annotation = spot-check, not from scratch.** `parseCitations`/`resolveChain` produce the (clause → governing doc → value) map automatically; `assemble` emits a `pairs.md` human-readable dump. Hand-verify a sample against the filings (the parser's accuracy is the main correctness risk).

## Chain SELECTION is load-bearing (CB1 finding)

Real amendments are **partial-edit-dominated**: on a dense Master Services Agreement amendment, **53–55% of ops were unrecoverable** (sub-part edits: "the second paragraph of Section 5.1 is deleted", "amended by inserting…" — no whole-clause value inline). `parseCitations` flags these (downgrades to `partial`/`indirect`, taints the clause `clean:false`, excluded from ground truth). **The `>20% hand-resolution` figure is the kill metric** — the parser computes the unrecoverable rate per chain. So: **select restate/delete-dominant chains** (whole-clause "amended and restated in its entirety" / defined-term "amended and restated in their respective entireties"), don't sample blindly, and report the natural unrecoverable rate (itself a finding about labelability).

- **Two unit types both supported:** Section-numbered clauses AND defined terms (credit-agreement style — "'Applicable Margin' means…"). Credit agreements (e.g. the NGS Credit Agreement, CIK 1084991: base + First + Second Amendment) are a strong defined-term candidate chain. Pick a handful across both unit types.

## Arm wiring (reuse `falsifier-runner.mjs`, two changes)

The synthetic runner is the template. For EDGAR:
- **Arm A (recency):** `recencyAnswer(perturbedDocs, clause)` — unchanged. Operates on the perturbed whole-contract docs `assemble` now returns (`perturbedDocs`).
- **Arm C (daftari):** retrieve the clause's atomized version docs, `resolveCurrentSource` to the governing terminal, return its value. **LESSON FROM THE SYNTHETIC RUN:** the v1.29.0 chunk-BM25 default is body-only, and atomized clause bodies are bare values with the clause id only in the title/frontmatter → use `lexicalGranularity:"document"` + a high `limit` so retrieval reliably *surfaces* the clause's docs and **resolution** (the thing under test) is what's measured, not retrieval ranking. A genuine retrieval miss on real data is a separate coverage concern (`applyCoveragePass`) — record it separately, don't conflate with a supersession finding.
- **Real-data answer matching:** synthetic used exact string match. Real perturbed values may need light normalization (whitespace/currency formatting) before comparison — decide in the brainstorm; keep it conservative (a normalizer that could mask a wrong answer is worse than a few false-misses).

## Decomposition (each its own spec→plan→impl)

- **E1 — acquisition + `htmlToText`:** EDGAR Exhibit-10 puller (curl + UA), chain candidate assembly from exhibit descriptions, entity-decoder. The durable, net-new artifact.
- **E2 — chain selection + annotation:** run `parseCitations` over candidates, filter to restate/delete-dominant (report unrecoverable rates), spot-check the `pairs.md` dump, finalize N≥20 chains (mix Section + defined-term).
- **E3 — run the arms:** adapt `falsifier-runner.mjs` to read the EDGAR-assembled chains; produce per-bucket A-vs-C + **the natural scoped-current/stale frequency**.
- **E4 (then) — Arm B (LLM-synth) + CB4 (acquired edges via the cortex loop):** the publishable contribution per the parent spec — after E3 confirms the regime exists.

## Win / kill at the REGIME level (the honest framing)

- **WIN (regime confirmed):** real chains contain scoped-current-with-stale-mention at a non-trivial natural rate, and on those, Arm C ≫ Arm A. This is the first evidence daftari has a real-world niche, not just a constructible one.
- **KILL (regime collapses):** if real amendments are cleanly scoped (later docs don't carry stale mentions) — i.e. the CLEAN variant is what the wild looks like — then clause-keyed recency suffices and daftari has no niche even here. **This is the load-bearing falsifier.** The synthetic CLEAN tie already shows daftari adds nothing without stale mentions; EDGAR decides which world is real.
- **Partial:** the regime exists but only with oracle edges (CB3); whether the cortex loop can *acquire* clause-supersession unaided (CB4) becomes the gating cost — the real paper contribution.

## Constraints / gotchas checklist

- SEC: `curl` + compliant `User-Agent`, throttle; `WebFetch` 403s.
- `htmlToText` must entity-decode (`&#8220;` etc.) + unwrap tag-wrapped term names before `parseCitations`.
- Select restate/delete-dominant chains; report the unrecoverable rate (>20% = labelability weak).
- Arm C: `lexicalGranularity:"document"` + high limit (chunk default is title/short-body weak).
- `assemble()` already returns `perturbedDocs` for Arm A; vault is gitignored under `integrations/contract-bench/dist` and `/tmp` artifacts are ephemeral.
- Contamination: perturbation handles measured values; structural memorization of contract *form* is fine (we measure values).
- `unamended` bucket still deferred (needs a real master-clause value format decision — don't guess).

## First action

Brainstorm E1 (acquisition + `htmlToText`) — the net-new artifact everything else gates on. Confirm a small set of candidate chains is pullable (start with the NGS credit-agreement chain, CIK 1084991, as the known defined-term case) before scaling. Branch continues on `feat/contract-bench-arms`.
