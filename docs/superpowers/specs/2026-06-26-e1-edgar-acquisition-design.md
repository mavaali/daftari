# Spec — E1: EDGAR acquisition + `htmlToText` (contract-bench realism run)

**Date:** 2026-06-26
**Branch:** `feat/contract-bench-arms`
**Decomposition parent:** `docs/superpowers/handoffs/2026-06-26-contract-bench-edgar-realism-pickup.md` (E1 of E1–E4)
**Related:** `docs/superpowers/specs/2026-06-22-contract-supersession-benchmark-design.md` (parent methodology), `docs/superpowers/specs/2026-06-25-synthetic-contract-supersession-falsifier-design.md` (mechanism falsifier), `docs/superpowers/results/2026-06-25-synthetic-contract-supersession.md` (mechanism WIN), memory `project_contract_supersession_benchmark`.

## Why this exists

The synthetic falsifier validated the **mechanism** (daftari's clause-scoped `resolveCurrentSource` beats clause-keyed recency on a corpus that *contains* scoped supersession with stale mentions; never mints). It cannot answer the **regime** question: do *real* contract amendment chains contain the STALE structure (a later doc mentioning a clause it does not govern) often enough that clause-keyed recency fails? Answering that needs real chains. The only path is reconstructing master→amendment chains from **EDGAR Exhibit-10 filings** (MCC ruled out: binary amendment flag, zero cross-doc linkage, zero clause annotation — see parent handoff).

E1 is the first of four sub-projects (E1 acquisition + `htmlToText`; E2 selection + annotation; E3 run the arms; E4 Arm B + CB4). It produces the durable, net-new artifact everything else gates on. Each sub-project gets its own spec → plan → impl cycle.

## Scope

### Goal & boundary
E1 delivers two net-new, independently-testable units plus a hand-seeded chain assembler, and proves them end-to-end on the **NGS credit-agreement chain** (CIK 1084991: base + First Amendment + Second Amendment — a known defined-term case). It stops at **"text is `parseCitations`-ready."**

**In scope (E1):**
- A SEC puller over an explicit, hand-authored seed list of `{cik, accession, filename}` filings.
- `htmlToText` — the EDGAR HTML → clean-text converter.
- `buildChainDocs(seed)` → `ChainDoc[]` (the exact input `assemble()` consumes in E3).

**Out of scope (named displacements):**
- Automated exhibit-description chain *discovery* (CIK + agreement-type + contract-number cross-referencing) → **E2 / scaling**.
- Selecting restate/delete-dominant chains, computing per-chain unrecoverable rates, spot-checking `pairs.md` → **E2**.
- Running `assemble()` + Arm A/Arm C → **E3**.
- Chains beyond NGS → **E2** (E1 only needs NGS to prove the path).
- A node-fetch transport → **deferred** (curl is the proven path; see Decisions).

### Done-criterion
`node pull-edgar.mjs seeds/ngs.json` produces 3 cached HTML files + an in-memory `ChainDoc[]`, **and** the `htmlToText` fixture tests (including the `parseCitations` oracle assertion below) are green. That is "real text, pipeline-ready" — the gate E2/E3 build on.

## Architecture

Three units, mirroring CB1's existing pure-core / thin-I/O split (`assemble` pure vs `writeAssembly` I/O):

```
seeds/ngs.json  ──►  buildChainDocs()  ──►  ChainDoc[]  (E3 consumes this)
                          │
                          ├─ fetchFiling()  ──► raw HTML  (cached to .edgar-cache/)
                          └─ htmlToText()   ──► clean text
```

### Unit 1 — `htmlToText(html: string): string`
- **File:** `integrations/contract-bench/src/html-to-text.ts`. Pure, zero-dep (preserves the harness's current zero-runtime-dep stance — only typescript + vitest).
- **The load-bearing risk.** The existing `parseCitations` keys on three things EDGAR HTML breaks: literal operative phrases, `Section X` patterns, and quoted-name-then-`means` defined terms. A regex-strip is insufficient (proven on the NGS doc per the parent handoff). Requirements:
  1. **Entity decode.** Closed named-entity map for what EDGAR emits (`&amp; &lt; &gt; &quot; &apos; &nbsp; &#167;`/`&sect;` …) **plus** a numeric decoder for `&#NNNN;` (decimal) and `&#xHH;` (hex). The numeric decoder is what yields the curly quotes (`&#8220;`→`“`, `&#8221;`→`”`, `&#8217;`→`’`) that `TERM_DEF` (`/[“"”]\s*([A-Z]…)\s*[”"“]\s+(?:means|shall mean)/`) requires.
  2. **Inline tag unwrap.** Inline tags (`<b> <i> <u> <em> <strong> <font> <span> <a> <sup> <sub>`) are removed with **no inserted whitespace**, so a quoted term split across tags collapses correctly: `<u>“Applicable Margin”</u>` → `“Applicable Margin”`; `“<b>Applicable Margin</b>”` → `“Applicable Margin”`.
  3. **Block tag → single newline.** Block/structural tags (`<p> <div> <br> <tr> <li> <h1>…<h6>` and their closers, plus `</table>`) emit exactly one `\n`. Then collapse runs of whitespace/newlines so **no spurious** `[.”"]\s+(?=[A-Z“"(]|\d+[).])` sentence boundary is minted mid-clause — the exact failure that would corrupt `SENTENCE_BOUNDARY`/`phraseSentence`.
  4. **Comments / scripts / style / doctype** stripped.
- **Table policy [HYPOTHESIS — kill condition stated].** Flatten cell text inline within a row; row → newline. Rationale: we measure clause *values* and the operative phrases live in prose, so tables become low-noise text rather than structured grids. **Kill condition:** if NGS tables inject `Section X`-shaped noise that `resolveSubject` mistakes for a clause subject, revisit (e.g. drop table contents entirely).
- **Interface:** `string → string`. No dependence on chain/seed types. Fully unit-testable in isolation.

### Unit 2 — the puller (`src/edgar-fetch.ts` + `pull-edgar.mjs`)
- **`filingUrl({cik, accession, filename}): string` (pure, testable):** `https://www.sec.gov/Archives/edgar/data/{cik}/{accession-without-dashes}/{filename}`.
- **`fetchFiling(ref, opts): Promise<string>` (I/O, swappable):** fetches via **curl** shell-out with a compliant `User-Agent` (a real contact string per SEC fair-access policy). This is the path **PROVEN in CB1** — `WebFetch` is 403'd by SEC; curl+UA works. Isolated behind one function so the transport is swappable.
  - **Throttle:** serial requests, ≤ ~5 req/s spacing (well under SEC's 10 req/s ceiling).
  - **Cache:** raw HTML written to a **gitignored** working dir `integrations/contract-bench/.edgar-cache/`, keyed by `{accession}-{filename}`. On re-run, read from cache; never re-hit SEC for a cached filing. (Add `.edgar-cache/` to the contract-bench `.gitignore` scope.)
- **`pull-edgar.mjs`:** thin runner — reads a seed JSON path, calls `buildChainDocs`, writes the cache, prints a `ChainDoc[]` summary (id, order, char count). This is the manual acquisition entrypoint; not exercised in CI.

### Unit 3 — seed + chain assembly
- **Seed format** (`seeds/ngs.json`), hand-authored. **Resolved live 2026-06-26 (gate-zero pre-confirmed — see below); all 6 filings fetched OK via curl+UA.** The benchmark chain is NGS's Texas Capital Bank **Amended & Restated Credit Agreement** (a defined-term *and* Section-numbered credit agreement) plus its sequential amendments:
  ```json
  {
    "chainId": "ngs-tcb-ar-credit-agreement",
    "unitType": "mixed",
    "docs": [
      { "id": "ngs-ar-base", "order": 0, "role": "master-ar",   "cik": "1084991", "accession": "0001084991-23-000019", "filename": "exhibit101tcbamendedandres.htm" },
      { "id": "ngs-amd-1",   "order": 1, "role": "amendment-1",  "cik": "1084991", "accession": "0001084991-23-000124", "filename": "exhibit101firstamendmentto.htm" },
      { "id": "ngs-amd-2",   "order": 2, "role": "amendment-2",  "cik": "1084991", "accession": "0001084991-24-000066", "filename": "exhibit101_secondamendme.htm" },
      { "id": "ngs-amd-3",   "order": 3, "role": "amendment-3",  "cik": "1084991", "accession": "0001084991-24-000080", "filename": "exhibit101thirdamendment.htm" },
      { "id": "ngs-amd-4",   "order": 4, "role": "amendment-4",  "cik": "1084991", "accession": "0001084991-25-000044", "filename": "exhibit101_fourthxamendm.htm" }
    ]
  }
  ```
  - **`ngs-amd-5`** (`0001084991-26-000054` / `exhibit101fifthamendmentto.htm`, 2026-06-15) is itself a ~1.5MB **second A&R restatement** (258 defined terms) — a chain-boundary case. **Excluded from the E1 seed**; whether it terminates the chain or opens a new master is an **E2/E3** decision (don't guess). E1 proves the path on base + amd-1..4.
  - For E1's pipeline-readiness proof, base + amd-1 + amd-2 are sufficient and richest (amd-2 carries 5 Section-restate + 1 term-restate ops; amd-1 carries the defined-term oracle).
- **`buildChainDocs(seed): Promise<ChainDoc[]>`:** for each `docs[]` entry, `fetchFiling` → `htmlToText` → `{ id, order, text }`; sort by `order`. `ChainDoc` is the existing type from `clause-edge.ts` (`{ id, order, text }`) — E3's `assemble(rawDocs, opts)` consumes this array unchanged.

## Test strategy — **no network in CI**

- **Fixtures:** commit the 3 real NGS Exhibit-10 HTML files under `src/__fixtures__/ngs/` (public-domain SEC filings; the large base doc may be trimmed to the definitions/amended sections if size bloats — amendments carry the operative phrases and stay full). **User-approved** the ~1–2MB fixture cost for hermetic/offline tests.
- **`html-to-text.test.ts` (hermetic, against fixtures):**
  1. Entity decode — named + numeric (`&#8220;`→`“` etc.).
  2. Tag-split quoted-term unwrap (`<u>“X”</u>` and `“<b>X</b>”` → `“X”`).
  3. No spurious sentence boundary minted on a known multi-clause prose passage (assert a `parseCitations` subject resolves to the right clause across a paragraph break).
  4. **Oracle assertion (user-approved coupling to E2's parser):** `parseCitations(htmlToText(ngsAmd1))` surfaces the **verified** defined term **`"Commitment"`** as a `recoverable` restate — confirmed live 2026-06-26: amd-1 restates `"Commitment"` "amended and restated in their respective entireties to read in full as follows: &#8220;Commitment&#8221; means …". This is the only way to assert "pipeline-ready" rather than "looks clean." It couples E1's test to `parseCitations` deliberately; it does **not** make E1 own selection/annotation (E2). (The handoff's `"Applicable Margin"` guess was superseded by the actually-present `"Commitment"`.)
     - **Fixture precondition (load-bearing):** `parseDefinedTermCitations` only emits a `Citation` for a term when a `TERM_OP_PATTERNS` operative phrase (e.g. `"amended and restated in their respective entireties"`, `"amended to add … following definitions"`) precedes the term list — a doc containing merely `"Applicable Margin" means …` yields **nothing**. The oracle fixture (First Amendment) MUST contain such a trigger, else the oracle returns empty for reasons unrelated to `htmlToText`. Verify the chosen fixture carries a `TERM_OP_PATTERNS` phrase as part of gate-zero below; if NGS's amendment phrases its restatements differently, either pick a fixture that triggers or assert via a Section-op oracle instead.
- **`edgar-fetch.test.ts`:** `filingUrl` URL-construction unit tests (dashes stripped, path shape) — pure, no network. The actual `fetchFiling`/curl path is exercised by `pull-edgar.mjs` run manually (proven path), not asserted in CI.
- **Conventions:** tests mirror `src/` structure (per CLAUDE.md); functions-and-types, no classes; `Result`-style returns at I/O boundaries where a failure is expected (a 403/404 from `fetchFiling` returns an error result, does not throw). Build `cd integrations/contract-bench && npx tsc`; test `npx vitest run --root integrations/contract-bench`.

## Decisions (settled — do not relitigate)

- **Puller-over-seed, not discovery.** E1 takes an explicit filing list; automated exhibit-description chain discovery is deferred (E2/scaling). Retires the htmlToText risk fastest. *(User-selected.)*
- **Hand-rolled zero-dep `htmlToText`, not a library.** A general lib's block-structure heuristics (tables, mid-sentence newlines) could inject false `SENTENCE_BOUNDARY` hits — the exact failure that corrupts segmentation; and a dep breaks the harness's zero-dep stance. The entity set is closed and the contract is narrow, so hand-rolling is bounded and fully testable. *(User-selected.)*
- **curl + compliant UA, not node-fetch.** `WebFetch` 403s (proven CB1); curl+UA works (proven). node-fetch+UA is untested; cost of being wrong is a 403 mid-run, so use the proven path, isolated behind `fetchFiling` for swappability. *(Assumption named per Operating Tenet 1.)*

## Risks & assumptions

- **[HYPOTHESIS] `htmlToText` accuracy is the dominant correctness risk.** Mitigated by the oracle assertion + hermetic fixtures. Kill signal: oracle test cannot surface known NGS terms ⇒ converter is wrong, fix before E2.
- **[HYPOTHESIS] Table flattening is low-noise.** Kill condition stated above.
- **[RESOLVED 2026-06-26] GATE-ZERO PASSED — pre-confirmed during planning.** All five chain filings (base + amd-1..4) were fetched live via curl+UA (exit 0; base 1.72MB, amd-1 70KB, amd-2 37KB, amd-3 21KB, amd-4 37KB). Verified: (a) curly quotes encode as `&#8220;`/`&#8221;` numeric entities (17× each in amd-1) — confirming the numeric-decoder requirement on real data; (b) amd-1 carries `amended and restated in their respective entireties` + `amended to add … following definitions` (both `TERM_OP_PATTERNS` triggers); (c) the oracle term `"Commitment"` is present as a recoverable restate. The accession/filename triples are now recorded in the seed above, so implementation **starts from confirmed-fetchable filings** — the "first executable step" is cache-and-convert, not discovery. Residual risk is now purely `htmlToText` *correctness*, retired by the fixture + oracle tests.
- **Contamination:** structural memorization of contract *form* is fine; we measure perturbed *values* (E3's `perturbValues`). Out of E1's scope but noted.

## What E1 explicitly does NOT decide

- The `unamended` bucket's master-clause value format (deferred — needs a real format decision, don't guess).
- Real-data answer normalization (whitespace/currency) for Arm comparison — that's E3.
- How many chains / which unit-type mix — E2.
