# Handoff — Contract-supersession benchmark: CB1 code complete; next is data + wiring (CB2/CB3)

**Date:** 2026-06-24
**Prev session:** Designed the contract-supersession benchmark, then built CB1 (the corpus-generation machinery) end-to-end for both amendment dialects. Real EDGAR data forced a design change (defined-term units) mid-build.

---

## TL;DR

- **CB1 code is essentially complete** — parse amendments → resolve per-clause supersession → perturb values → build QAs → build an atomized daftari vault. **35 tests, `tsc --noEmit` clean.**
- It handles **both** amendment dialects: numbered-clause (MSA/lease style) **and** defined-term (credit-agreement style). The defined-term path was added because real EDGAR data demanded it.
- **What's left is the experiment, not machinery:** an HTML→text decoder, acquiring a real amendment chain, wiring the daftari arm + a recency baseline, and running the kill-condition race.
- ⚠️ **The work is NOT on the branch you'll land on.** Main checkout is `exp/atomization-granularity-pr` (your BM25 prototype). CB1 lives on `feat/contract-bench`, checked out in a **worktree** — see "Where the work lives" before doing anything.

## Where the work lives (read first)

| Thing | Location |
|---|---|
| CB1 code (branch) | `feat/contract-bench` |
| Checked-out worktree | `/Users/mihirwagle/projects/daftari/.claude/worktrees/contract-bench` |
| node_modules | symlinked to root (`ln -sfn <root>/node_modules <worktree>/node_modules`) — already done |
| Run tests | `cd <worktree> && node_modules/.bin/vitest run integrations/contract-bench/` |
| Code | `<worktree>/integrations/contract-bench/src/` |
| Spec | `docs/superpowers/specs/2026-06-22-contract-supersession-benchmark-design.md` (untracked in main tree) |
| Memory | `project_contract_supersession_benchmark.md` |

**CB1 commits on `feat/contract-bench`:** `a85229d` (corpus pipeline) → `20ae265` (serializer + assembler) → `3bebd34` (defined-term units) → `4a717a1` (defined-term end-to-end). Note `feat/contract-bench` also carries an interleaved `cb63fd1` (your recall-bench commit) — rebase/cherry-pick to isolate if you PR it standalone.

If the worktree was cleaned up, recreate it: `git worktree add <worktree> feat/contract-bench && ln -sfn <root>/node_modules <worktree>/node_modules`.

## What CB1 does (the pipeline)

```
raw chain → perturb → resolveChain → buildQAs → buildCorpus → renderDoc → writeAssembly → disk
```

| Module | Role |
|---|---|
| `citation-parse.ts` | Classify amendment ops: recoverable (whole-clause/term restate·delete·add) vs unrecoverable (partial·indirect). Section subjects AND defined-term lists. |
| `clause-edge.ts` | `resolveChain(docs)` → per-clause governing doc (held at last recoverable op), supersession `history`, `clean` flag (tainted by any unrecoverable op). |
| `perturb.ts` | Deterministic (FNV-1a), type/magnitude-preserving substitution: durations, currency ($), percentages. Cross-doc-consistent via carried mapping. |
| `qa-build.ts` | Buckets: scoped-current / latest-current / no-value. `extractValue` (Section + defined-term paths). Tainted clauses excluded. |
| `corpus.ts` | Atomize each clause version → own doc with clause-scoped `superseded_by` (the SP2-intra-doc answer). Term names slugged into paths. |
| `serialize.ts` | CorpusDoc → daftari frontmatter markdown. `superseded_by` = successor's vault PATH (resolveCurrentSource follows by `getDocument(db, path)`). |
| `assemble.ts` | Orchestrator: `assemble(rawDocs, {seed, noValueClauses})` → `{vault, groundTruth, pairDump, mapping}`; `writeAssembly(a, outDir)` writes `vault/` + `ground-truth.json` + `pairs.md` + `perturbation.json`. |

## Next steps (in order)

### 1. `htmlToText` entity-decoder module (TDD)
Real SEC HTML encodes quotes as `&#8220;` etc. A naive `replace(/<[^>]+>/g,' ')` strip **silently drops every defined term** (proven on NGS — the parser found 0 ops until entities were decoded). Build a small module:
- strip tags, decode `&#NNN;` / `&#xNN;` / named entities (`&nbsp; &amp; &mdash; &ldquo; &rdquo;`), collapse whitespace.
- handle tag-wrapped term names (`<fo …>Applicable Margin</fo>` → contiguous after strip).
- Reference impl already drafted in a throwaway last session; turn it into a tested module.

### 2. Acquire a real chain (curl, compliant UA)
SEC **403s WebFetch**; `curl -A "daftari-research mihir.wagle@gmail.com"` works. EDGAR FTS API: `https://efts.sec.gov/LATEST/search-index?q=...` (form filter is unreliable — omit it).
Target chain: **Natural Gas Services Group (NGS), CIK 1084991** —
- Second Amendment to Credit Agreement (Jan 18 2023): `https://www.sec.gov/Archives/edgar/data/1084991/000108499123000007/ex101secondamendmenttocred.htm` (was at `/tmp/ngs-amd2.htm`, ephemeral). It restates `Applicable Margin`, `Commitment`, `Loan Documents` and adds 2 terms.
- **Still need:** the original Credit Agreement (dated **May 11, 2021**) + the **First Amendment**. Find via EDGAR FTS / the CIK's submissions JSON (`https://data.sec.gov/submissions/CIK0001084991.json`).
- A good chain needs a term **restated in an early amendment but NOT the latest** → that's the scoped-current case (governing ≠ latest). Verify one exists before committing to the chain.

### 3. Chain-loader + run
`htmlToText` the 3 docs → `ChainDoc[]` (master = original, order by date) → `assemble({seed})` → `writeAssembly` to an out dir. **Inspect:** unrecoverable rate (expect lower than 53% MSA figure for defined-term restatements), bucket counts (need ≥1 scoped-current), and that perturbation hit the margins/amounts. Spot-check `pairs.md`.

### 4. Arm C — the daftari arm
Ingest the generated `vault/` via `reindexVault` (`src/storage/reindex.ts`), answer "current value of clause X" via `resolveCurrentSource` chain-follow + retrieval. (In-process, no server/process-lock — see the recall-bench adapter for the pattern; handlers run with `access: undefined` to bypass RBAC.)

### 5. Arm A — recency-extraction baseline (the CF `wiki.py` analog)
Deterministic, zero-LLM: for clause X, return the value from the **most-recent document that mentions X**. This is the strong baseline that *structurally* fails scoped-current.

### 6. The race (kill condition)
**Run A and C first — they're cheap.** Compare scoped-current accuracy (exact perturbed-value match), A vs C.
- **WIN:** C ≫ A on scoped-current.
- **KILL:** A ≈ C ⇒ scoped supersession is recency-resolvable after all ⇒ no daftari niche even here. Stop before building Arm B.
- Only if C wins: add **Arm B** (LLM-synthesis) to measure fabrication on the no-value probe.

## Findings to carry (don't rediscover)

- **HTML must be entity-decoded** before parsing (see step 1).
- **`"in its entirety"` ≠ whole-clause:** real amendments restate *sub-parts* ("the last sentence of Section 5.2.1 … in its entirety"). The parser's sub-part guard downgrades these to unrecoverable — keep it.
- **Dense MSA amendments are ~53% unrecoverable** (partial edits). **Select restate/delete/term-restate-dominant chains.** The parser computes the rate = the >20% hand-resolution kill metric.
- **Credit agreements are defined-term-centric** and are the *abundant, clean, post-cutoff* corpus — a defined term has exactly one current value. Favor them.
- **Contamination:** prefer 2022–2023 filings AND rely on perturbation (the value-swap) so memorized contracts can't be answered from priors.

## Deferred (not blocking the kill-condition race)

- **`unamended` bucket** — needs a real master-clause value format; defer until a real master is loaded.
- **Arm B (LLM-synthesis)** — only after Arm C wins.
- **CB4 (acquired edges)** — can the cortex loop detect clause/term supersession unaided? **This is the actual publishable contribution** (oracle-edge C beating recency A is near-tautological). It's also the connection point that makes this corpus the cortex loop's evaluation surface (the agreed framing).

## Housekeeping

- The worktree at `.claude/worktrees/contract-bench` persists with a symlinked node_modules. Remove with `git worktree remove` when done (or leave for the next session).
- Nothing here touches `main` or your `exp/atomization-granularity-pr` work.
