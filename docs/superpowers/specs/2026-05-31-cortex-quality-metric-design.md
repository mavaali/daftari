# Cortex Quality Metric (Sleep Component B) — v1 Design

**Status:** Draft 2026-05-31, awaiting spec-review-loop and user approval.
**Issue:** [mavaali/daftari#97](https://github.com/mavaali/daftari/issues/97) — Daftari Sleep Extensions.
**Relationship to other work:** This spec covers **Component B only** — the quality metric for cortex traversal. Component A (multi-pass curation) and Component C (dependency-triggered re-curation) are explicitly deferred to follow-on specs; both depend on B existing first. The framing was reworked during brainstorming from the original issue's "compiled wiki" phrasing to a **cortex** framing (Daftari as structured external substrate the LLM reads via tools, not a write surface that produces derived docs). The reframing changed the metric's design — it now measures how well an LLM can *traverse* the vault via MCP tools to answer multi-hop questions, not how well a compiled artifact reads.

**Prior art & positioning:** The "sleep" framing (issue #97) builds on Lee et al., *"Language Models Need Sleep"* (arXiv:2605.26099) — iterative offline consolidation beats single-pass storage, with gains proportional to reasoning depth. It is also the layer-complement to Kerestecioglu, Robsky, Vasters, Sharma & Kesselman (Microsoft), *"Human-Inspired Memory Architecture for LLM Agents"* (arXiv:2605.08538), a biologically-grounded agent **working-memory** architecture that forgets at the storage layer (TTL/decay) to optimize store size at iso-accuracy. This metric is the cortex-layer analogue of that paper's retention-precision / LongMemEval evaluation — but it scores **live MCP-tool traversal quality** over a durable, git-versioned, auditable substrate, not retrieval accuracy over a self-forgetting store. The two compose: their forgetting engine as the agent's working cache, Daftari as the substrate. (Their own results matter here: keep-everything is statistically tied on accuracy and "aggressive consolidation is destructive" — which is why Daftari's curation stays advisory and never deletes.)

---

## 1. Purpose

Add a `daftari eval` CLI subcommand that produces a tier-weighted quality score for **how well an LLM can use Daftari as cortex to answer multi-hop questions about the vault**, using only the existing MCP tool surface (read, search, themes, lint, tensions, blast, clusters).

The score is the prerequisite measurement for Components A and C — multi-pass curation and dependency-triggered re-curation can only be validated against a number. Before this spec lands, "did this change make Daftari a better cortex?" has no defensible answer beyond eyeballing.

## 2. Scope

### In scope (v1)

- `daftari eval` CLI subcommand with three modes: `generate`, `run`, `score`, plus a top-level convenience that runs all three.
- Synthetic question generation from a sampled subgraph of the vault, across three tiers: retrieval (1-hop), cross-reference (2–3 hop), contradiction-detection (multi-hop).
- LLM-mediated answering using the full Daftari MCP curation surface, with full tool-call trace capture.
- LLM-mediated grading of answers against generator-produced expected answers.
- Tier-weighted aggregate score (retrieval × 1, cross-reference × 2, contradiction × 3).
- K=2 runs per eval for variance estimation; report mean + std.
- Ephemeral storage under `.daftari/eval/` (gitignored).
- Regression tracking via rolling `history.json` (last 50 runs).
- Fixture-based end-to-end tests with mocked LLM client; opt-in real-LLM smoke test.

### Out of scope (deferred)

- **Multi-pass curation** (Component A). Once this metric exists, the next spec asks "does N=2 curation move the number?"
- **Dependency-triggered re-curation** (Component C). Requires Component A.
- **Cost optimization** for large vaults. Default budget (N=15 questions, K=2 runs) targets ~$2–3 per eval at Sonnet pricing. Larger vaults or higher-confidence runs are explicit opt-ins via flags. Caching, sampling strategies, and cheaper-grader variants earn their own follow-up if real-world cost becomes the bottleneck.
- **Question generation from non-markdown sources.** The cortex framing treats the vault itself as cortex. Compiling external sources is a different problem (and likely a different project — see "What this design explicitly is NOT").
- **A web UI** for browsing eval results. JSON + `jq` is the surface.
- **Real-time scoring during curation runs.** This is a batch eval, not a feedback loop.
- **Cross-vault eval** via the router. Single-vault only in v1.
- **Question-set portability across vaults.** Question sets are vault-specific by design; carrying them across vaults defeats the point.

### Explicit non-goals

- **Not a write surface.** The eval does not modify vault docs. All artifacts live in `.daftari/eval/`, gitignored, ephemeral, regeneratable.
- **Not an LLM dependency in core curation.** The Anthropic SDK is reached only via the `daftari eval` command. `vault_lint`, `vault_themes`, `vault_tension_*`, `daftari audit`, and every other tool remain LLM-free. (This honors the discipline rule established during brainstorming: no hosted-LLM dependency in the core curation path.)
- **Not deterministic.** LLMs are non-deterministic even at temp=0 across model versions and infrastructure. The metric is honest about this — scores are reported as mean + std over K runs, not point estimates.
- **Not a replacement for human judgment.** The metric tracks one thing — multi-hop traversal quality on synthetic questions. It does not score readability, taste, ergonomics, or whether the vault is actually useful for its intended purpose.

---

## 3. User interface

### CLI

```bash
# Top-level convenience: generate + run + score in one shot
daftari eval [--vault <path>] [--n <count>] [--k <count>] [--seed <int>]

# Individual stages (for sensitivity analysis, resume after failure, etc.)
daftari eval generate [--vault <path>] [--n <count>] [--seed <int>] [--output <path>]
daftari eval run      [--questions <path>] [--vault <path>] [--model <id>] [--k <count>] [--resume <results-id>] [--output <path>]
daftari eval score    [--results <path>] [--grader-model <id>] [--output <path>]
```

`daftari eval --help` prints usage. `--vault` defaults to the current working directory (mirrors `daftari audit`). All defaults documented inline in `--help`.

**Defaults:**

- `--n 15` — 5 questions per tier (retrieval / cross-ref / contradiction), 15 total per question set
- `--k 2` — runs per eval, for variance estimation
- `--model claude-sonnet-*` — generator and answerer
- `--grader-model claude-opus-*` — grader; defaults to a **different** model than `--model`. The grader must not be the same model as the generator: the generator writes the `expected_answer`, so a same-model grader largely checks the model against itself (circularity — a high score could mean "the model agrees with itself," not "the vault is a good cortex"). Two distinct models (generator/answerer = Sonnet, grader = Opus) breaks that loop. Override either for sensitivity testing.
- `--seed` — defaults to an explicit seed derived from vault hash + UTC date, so two runs on the same day on the same vault are reproducible; override for parameter sweeps

**Exit codes** (mirror `daftari audit`):

- `0` — eval completed, score computed (no thresholds enforced in v1)
- `2` — config error (missing vault, malformed flags, no Anthropic API key)
- `3` — runtime error (LLM API failure that exhausted retries, vault I/O failure)

### Configuration

No `audit.yaml`-style config file in v1. All knobs are CLI flags. If a configuration file becomes worth adding (e.g., per-vault eval defaults), that's a v2 question.

The Anthropic API key is read from the `ANTHROPIC_API_KEY` environment variable. Not stored in `.daftari/`. Not logged.

---

## 4. Architecture

New top-level domain `src/eval/`, parallel to `src/curation/` and `src/audit/`. Same file conventions as the rest of the codebase: functions + types only (no classes), `Result<T, Error>` returns from every fallible operation, tests mirror `src/` structure.

```
src/eval/
  index.ts         # CLI entry — runEval(argv): Promise<number>
  types.ts         # Question, EvalRun, Trace, Score, Result<T, Error>
  generate.ts      # generateQuestions(vault, opts): Promise<Result<QuestionSet>>
  run.ts           # runAnswerer(questions, vault, opts): Promise<Result<EvalRun>>
  score.ts         # scoreRun(run, opts): Promise<Result<Score>>
  storage.ts       # readQuestions, writeQuestions, readResults, writeResults, history
  llm.ts           # Anthropic client wrapper with retry + JSON-schema validation
  subgraph.ts      # sampleSubgraph(vault, seed, opts): Subgraph

test/eval/
  generate.test.ts # mocked LLM, fixture vault
  run.test.ts      # mocked LLM, mocked MCP tools
  score.test.ts    # deterministic, exhaustive tier-weighting
  storage.test.ts  # round-trip + history rotation
  subgraph.test.ts # deterministic graph traversal
  e2e.test.ts      # fixture vault + mocked LLM, full pipeline
  smoke.test.ts    # opt-in: real LLM, skipIf no ANTHROPIC_API_KEY
```

Wire `daftari eval` into `src/cli.ts` as a third subcommand alongside `--init` and `audit`.

### Module boundaries

- **`subgraph.ts`** — pure function over the vault index. Given a seed and traversal parameters, returns a connected subgraph of 3–5 docs. No LLM. No I/O beyond reading the existing SQLite index.
- **`generate.ts`** — LLM-mediated. Given a subgraph, calls the generator LLM with a structured-output prompt, validates the JSON response against `QuestionSet` schema, filters out questions whose expected sources aren't in the subgraph.
- **`run.ts`** — LLM-mediated. Given a question set and a vault, invokes the answerer LLM with the full curation MCP surface as tools. Captures every tool call + response into a trace. Returns the answer + trace per question.
- **`score.ts`** — LLM-mediated for grading; deterministic for aggregation. The grader compares claimed vs expected answers, returns yes/partial/no. Aggregation is pure arithmetic, fully unit-testable without LLM calls.
- **`storage.ts`** — pure I/O. Reads/writes JSON files under `.daftari/eval/`. Handles history rotation. Schema validation on read (forward-compat for v2).
- **`llm.ts`** — single Anthropic SDK wrapper used by all three LLM stages. Retry-on-5xx with exponential backoff. JSON-schema validated structured outputs. Pinned model IDs recorded in every output.
- **`index.ts`** — CLI plumbing: parse flags, dispatch to subcommand, translate `Result<T, Error>` to exit codes, write outputs to stdout/files.

### MCP tool invocation: in-process for v1

The answerer LLM needs to call the Daftari curation tools (`vault_read`, `vault_search`, etc.) during answering. Two ways to wire this:

| Option | What it does | Tradeoff |
|---|---|---|
| **In-process (chosen for v1)** | `src/eval/run.ts` calls the existing tool handlers (`src/tools/*.ts`) directly as TypeScript functions, no MCP serialization | Faster (no IPC), simpler (no server lifecycle), exercises tool *semantics* but not the MCP *protocol* |
| Real MCP loop | Spawn a daftari MCP server in-process or as subprocess; the answerer LLM talks to it via the Anthropic SDK's tool-use loop with MCP transport | Higher fidelity to what a real agent experiences; adds server lifecycle complexity and serialization latency |

**v1 chooses in-process.** Reasoning: the cortex quality metric is about whether the curation *tools and their outputs* support multi-hop reasoning, not whether the MCP protocol layer correctly relays them. Protocol-layer issues are caught by the existing MCP test surface, not by this eval. In-process keeps each eval run fast (no server warmup per question) and the test harness simple (no subprocess management in unit tests).

**Future trigger for revisiting:** if a meaningful divergence is ever observed between in-process eval scores and real-agent-against-MCP behavior on the same vault and question set, upgrade `run.ts` to the real MCP loop. v2 spec issue at that point.

The smoke test (`smoke.test.ts`, opt-in, real LLM) uses the in-process path too. End-to-end MCP-protocol coverage is the job of existing integration tests in `test/integration/`, not of this eval pipeline.

---

## 5. Pipeline: generate

### 5.1 Subgraph sampling

The generator needs a connected slice of the vault to write questions about. Random doc selection would produce questions whose answers require docs not in scope — useless. The sampler walks the existing structure:

1. Pick a **seed doc** deterministically from `--seed` (default: hash of vault path + UTC date). Stratification is an input to seed derivation, not a per-run rotation: the seed deterministically picks a stratum (e.g., a tag bucket or theme cluster) and then deterministically picks a doc within that stratum. Two runs on the same UTC date with the same vault produce the same seed → same stratum → same doc. The stratification exists to avoid pathological seed collisions on a small set of "central" docs, not to vary seeds across runs.
2. Walk **1–2 hops** from the seed via three edge types:
   - `sources:` frontmatter references (primary edges, authoritative)
   - In-vault markdown links (advisory edges)
   - `vault_tension_log` entries that name the seed doc (tension edges)
3. Cap subgraph size at **3–5 docs**. If the walk produces more, prune to nearest-neighbors by edge count.
4. Return: `{seed: path, nodes: Map<path, DocSnapshot>, edges: Edge[]}`.

The walk is deterministic given the same seed and the same vault state. Re-running `daftari eval` with the same seed reproduces the same subgraph (and hence eligibility for the same question set, up to LLM non-determinism in question generation).

**Caveat for Components A/C:** this reproducibility is a Goodhart hazard once multi-pass curation (A) or dependency-triggered re-curation (C) optimize *against* the score. A fixed daily seed lets an optimizer overfit one subgraph's question set (e.g. keyword-stuffing for retrieval, over-linking for cross-reference) without making the vault more useful. When validating A/C, drive eval with **rotating/fresh seeds** and a held-out human-judged question set — not the reproducible default. See §13.

### 5.2 Question generation

The generator LLM is given the subgraph contents (all docs inlined as markdown) plus a structured-output prompt:

```
You will read a connected subgraph of a Markdown knowledge vault and produce
N questions across three tiers. The questions must be answerable using ONLY
the docs provided. For each question, supply: question text, tier, expected
answer, source paths (must be a subset of the supplied docs).

Tiers:
  retrieval        — single-doc lookup, 1-hop reasoning
  cross-reference  — requires combining 2–3 docs
  contradiction    — surfaces a tension or conflict across docs (use the
                     tension_log entries in the subgraph as seed material
                     where present)

Return JSON matching the QuestionSetSchema declared in src/eval/types.ts.
```

The canonical schema lives in `src/eval/types.ts` as `QuestionSetSchema` (exported as a JSON Schema object). The generator prompt embeds the schema by reference — `llm.ts` injects it into the structured-output call so the spec doc, the prompt, and the runtime validator all share a single source of truth.

### 5.3 Filtering & augmentation

Post-generation filters:

- **Source-in-subgraph check**: drop questions whose `expected_sources` reference paths not in the sampled subgraph. (Hallucination guard.)
- **Triviality check**: drop questions whose expected answer is trivially derivable without reading any doc (e.g., yes/no with no source spans).
- **Tier-mix check**: enforce N/3 per tier; if the LLM under-produced a tier, request a top-up call. Cap top-up retries at 1 — if the subgraph genuinely doesn't support a tier (no tensions → no contradiction questions), accept the imbalance and record it in the question-set metadata.

**Tension-graph augmentation**: the contradiction-tier budget is supplemented by *synthetic questions derived directly from `vault_tension_log` entries*, without a generator-LLM round-trip. This tests cortex traversal of structures Daftari is investing in (clusters, blast radius) and provides a partial ground truth that doesn't depend on the generator LLM's interpretation.

**Augmentation count rule**: `n_augmented = max(1, floor(0.2 × n_contradiction))` if the vault has any unresolved tensions; `0` otherwise. For the default N=15 (5 contradiction questions), this yields 1 augmented question. The augmented questions are *additional* to the generator-produced contradiction questions, not replacements — they don't count against the generator's tier budget.

### 5.4 Output

Question set written to `.daftari/eval/questions/<vault-hash>-<seed>-<timestamp>.json`. Immutable after creation. Metadata includes: vault hash, seed, generator model ID, subgraph node paths, tier counts produced vs requested.

---

## 6. Pipeline: run

### 6.1 Tool surface

The answerer is given the **full read-only Daftari curation MCP surface**:

- `vault_read` — read a doc by path
- `vault_search` — full-text + vector search
- `vault_search_related` — semantic neighbors
- `vault_themes` — theme clustering
- `vault_lint` — coherence report (surfaces tension health, broken refs, staleness)
- `vault_tension_blast` — downstream blast from a contested doc or cluster
- `vault_tension_clusters` — connected components of tension graph

**Write tools excluded** from the answerer's surface: `vault_write`, `vault_append`, `vault_deprecate`, `vault_promote`, **`vault_tension_log`** (creates a tension entry — not read-only), `vault_tension_resolve`. The eval is read-only.

**Index/admin tools excluded**: `vault_index`, `vault_reindex`, `vault_status` — irrelevant to question-answering.

**Note on tension enumeration**: there is no MCP tool today that returns a flat list of tensions. `vault_tension_clusters` returns connected components (which surfaces every tension-bearing doc), and `vault_tension_blast` returns the downstream impact of a contested doc. The answerer reads canonical positions by reading the source docs themselves via `vault_read`. If question-answering on tension-heavy vaults reveals a missing primitive, a follow-up spec adds a read-only `vault_tension_list` tool to the curation surface — out of scope for v1.

### 6.2 Answerer prompt

**System prompt** (passed as `system`):

```
You will answer a question about a Markdown knowledge vault using ONLY the
provided Daftari tools. Do not use training knowledge. Do not guess. If the
vault does not contain the answer, say "Vault does not contain the answer."
Cite source paths in your final answer using the format [path/to/doc.md].
```

**User message** (passed as `user`): the question text verbatim, no template wrapping.

System prompt frozen in `src/eval/run.ts`. Versioned alongside the spec — if the prompt changes, the change ships with a spec-doc note and a new run produces a new score-incompatible baseline (recorded in `history.json` as a version bump).

### 6.3 Trace capture

For each question, capture:

- Full tool-call sequence: `[{tool: string, input: object, output: object | error, latency_ms: number}]`
- Final answer text
- Total tool-call count
- Total tokens consumed (input + output, separately)
- Wall time
- LLM stop reason

The trace is the secondary signal — tracks whether new cortex features (e.g., tension blast) reduce the number of round-trips needed to answer correctly. Not used in the headline score but invaluable for "is this feature pulling its weight."

### 6.4 K runs and resume

`--k 2` means: for each question, the answerer is invoked K times (independent sessions, no shared state between runs of the same question). Per-question scores in section 7 are aggregated across the K runs.

If a run fails mid-question (LLM API error after retry exhaustion), partial results are saved with a `status: incomplete` marker. Resume state is the tuple `(question_index, k_index)` — `daftari eval run --resume <results-id>` picks up from the *next* `(question_index, k_index)` not yet recorded as complete, not just the next question. This matters because K=2 means each question has two independent answerer runs; failing on (q3, k1) and resuming should run (q3, k2) next, not (q4, k1). Re-runs of the same `(question_index, k_index)` overwrite, not append — a per-pair completion record is the unit of resume.

### 6.5 Output

Results written to `.daftari/eval/results/<questions-id>-<model>-<timestamp>.json`. Per-question, per-K-run, with full trace.

**On-disk shape**: results are keyed by `(question_index, k_index)` tuple — concretely, a top-level `runs` object whose keys are `"<question_index>:<k_index>"` strings (e.g., `"3:1"` for question 3, k-run 1). This shape preserves the resume contract from §6.4: partial writes update individual keyed entries rather than appending to an array; `--resume` enumerates which keys are missing or `status: incomplete` and runs only those. The keyed-map representation also makes per-question, per-k-run diffability cleaner (a failed q3:k1 retry is a clean replacement, not an array insertion at an index that may have shifted).

---

## 7. Pipeline: score

### 7.1 Grading

**Grader model differs from the generator/answerer model by default** (Sonnet generates and answers; Opus grades). This is a validity requirement, not a quality preference: the generator authored the `expected_answer` the grader checks against, so a same-model grader collapses into the model judging its own prior. Using a distinct grader breaks that circularity. The contradiction tier's tension-log grounding (§5.3) provides a second, model-independent anchor for the same reason.

The grader LLM is invoked once per (question × K-run) with:

```
You are grading an answer to a question about a Markdown knowledge vault.

Question:           <question text>
Expected answer:    <expected_answer from question set>
Expected sources:   <expected_sources from question set>
Claimed answer:     <answer text from run>
Cited sources:      <paths cited by answerer>

Return JSON: {correct: "yes" | "partial" | "no", reasoning: string}

Definitions:
  yes     — claimed answer is substantively correct and cites at least one
            expected source
  partial — claimed answer is partially correct OR cites the right sources
            but misses key content OR the answerer correctly said "Vault
            does not contain the answer" when the expected answer disagrees
            (records a question-set quality issue, not a cortex failure)
  no      — claimed answer is wrong, hallucinated, or cites no expected
            sources
```

Score per (question × K-run): yes = 1.0, partial = 0.5, no = 0.0.

### 7.2 Aggregation

Per-question score: mean across K runs.

Per-tier score: mean of per-question scores in that tier.

**Tier-weighted aggregate**:

```
score = (1 × n_retrieval × retrieval_mean
         + 2 × n_cross_ref × cross_ref_mean
         + 3 × n_contradiction × contradiction_mean)
        / (1 × n_retrieval + 2 × n_cross_ref + 3 × n_contradiction)
```

This is the **per-question weighted mean**: each question contributes its per-question score weighted by its tier weight, so numerator and denominator both scale with tier size (an earlier draft put tier *means* in the numerator against weighted *counts* in the denominator — dimensionally inconsistent, capping the score at 0.2; fixed here). When tiers are equally sized it reduces to the simple weighted average of tier means — e.g. for the §7.3 example, `(1×0.90 + 2×0.75 + 3×0.55) / (1+2+3) = 4.05/6 = 0.675`. Where `n_tier` = number of questions in that tier (handles tier under-production from section 5.3 gracefully). **Augmented contradiction questions (from §5.3) are counted in `n_contradiction`** — they're contradiction-tier by construction, so they contribute to the contradiction-tier mean and to the weighted denominator on equal footing with generator-produced contradiction questions. A default N=15 run with one augmented question therefore scores against 16 total items, with `n_contradiction = 6` in the formula.

**Variance**: per-question score std across K runs, then mean across questions. Reported alongside the score.

**Trace efficiency** (secondary metric, not weighted into headline): mean tool calls per correct-or-partial answer, per tier. Tracked over time in `history.json`.

### 7.3 Output

Score written to `.daftari/eval/scores/<results-id>.json`:

```json
{
  "score": 0.68,
  "score_std": 0.04,
  "by_tier": {
    "retrieval":     { "mean": 0.90, "std": 0.03, "n": 5 },
    "cross_reference": { "mean": 0.75, "std": 0.05, "n": 5 },
    "contradiction": { "mean": 0.55, "std": 0.08, "n": 5 }
  },
  "trace_efficiency": {
    "retrieval":     2.1,
    "cross_reference": 4.3,
    "contradiction": 7.8
  },
  "models": {
    "generator": "claude-sonnet-4-6-...",
    "answerer":  "claude-sonnet-4-6-...",
    "grader":    "claude-opus-4-8-..."
  },
  "questions_id": "...",
  "results_id":   "...",
  "vault_hash":   "...",
  "k": 2,
  "n": 15,
  "timestamp":    "2026-05-31T17:32:14Z"
}
```

Also appended to `.daftari/eval/history.json` (rolling last 50).

---

## 8. Storage schema

`.daftari/eval/` is the new ephemeral root. **Added to `.gitignore` as part of this change.** Like `.daftari/index.db` and `.daftari/process.lock`, contents are regeneratable and never committed.

```
.daftari/eval/
  questions/
    <vault-hash>-<seed>-<timestamp>.json   # immutable
  results/
    <questions-id>-<model>-<timestamp>.json
  scores/
    <results-id>.json
  history.json   # rolling, last 50 runs
```

### `history.json` schema

```json
{
  "version": 1,
  "runs": [
    {
      "score_id": "...",
      "score": 0.72,
      "score_std": 0.04,
      "by_tier": { "retrieval": 0.90, "cross_reference": 0.75, "contradiction": 0.55 },
      "vault_hash": "...",
      "timestamp": "2026-05-31T17:32:14Z",
      "n": 15, "k": 2,
      "models": { "...": "..." },
      "spec_version": 1
    }
  ]
}
```

`spec_version` lets a future spec change (different prompt, different tier weights, different MCP surface) declare incompatibility with prior scores. Comparisons across `spec_version` mismatches are surfaced as warnings, not silently averaged.

### Rotation

When `runs.length > 50`, drop oldest. Underlying `results/` and `scores/` files are *not* deleted by rotation — they remain on disk for deep dives. Rotation only trims the rolling index.

**Disk growth note**: `results/` and `scores/` therefore grow without bound across many eval runs. A typical results file is dominated by trace JSON (~10–50KB per question for default N=15, K=2); at one eval per day this is roughly a few MB per month — tolerable for v1 single-user usage. If the directory becomes unwieldy, a `daftari eval prune [--keep <n>]` follow-up command is the planned remediation (deferred to v2). v1's `daftari eval --help` calls out the growth pattern so users know they can safely `rm -rf .daftari/eval/results/` to reclaim disk; rerunning regenerates only what's needed.

---

## 9. Reproducibility

Deterministic by design where possible, honest about LLM non-determinism where not.

**Deterministic:**

- Subgraph sampling: same seed + same vault → same subgraph
- Filter/aggregation logic: pure functions
- Storage I/O: byte-stable JSON writes (sorted keys, consistent formatting)

**Non-deterministic (LLM-mediated):**

- Question generation: even at temp=0, identical prompts can produce different outputs across model versions and inference infrastructure
- Answer generation: same caveat, plus tool-use non-determinism (the model may decide to call different tools in different orders)
- Grading: same caveat

**How the spec handles it:**

- `--k 2` runs aggregate per-question scores across independent invocations
- Variance reported alongside score; users see "0.72 ± 0.04", not a fake-precise "0.72"
- Model IDs pinned in every output file; cross-model-version comparisons are surfaced as warnings
- `daftari eval --reproduce <run-id>` re-runs the same question set against the same models, *expected* to match within stated variance but not bit-identical

---

## 10. Error handling

Per project style: `Result<T, Error>` returns from every fallible operation. CLI translates errors to exit codes.

| Error class | Behavior |
|---|---|
| Missing `ANTHROPIC_API_KEY` env | Exit 2, message to stderr, no `.daftari/eval/` writes |
| Malformed CLI flags | Exit 2, usage to stderr |
| Vault not found / not a vault | Exit 2 |
| LLM 429 / 5xx | Retry with exponential backoff (max 5, capped at 60s). After exhaustion: save partial results with `status: incomplete`, exit 3 |
| LLM 4xx other than 429 | No retry. Save partial, exit 3 |
| Malformed generator JSON output | Drop the bad record, continue. Log to stderr. If <50% of requested questions survive, fail eval (exit 3) |
| Tool call failure during answer | Capture in trace as `{tool_error: ...}`, do not crash. The answerer's final answer still gets graded |
| Grader returns malformed JSON | Retry once with a stricter prompt; if still bad, mark question as `ungraded` and exclude from aggregate |
| `.daftari/eval/` I/O failure | Exit 3, partial results preserved if write to a temp file succeeded |

`daftari eval run --resume <results-id>` is the recovery path for any exit-3 mid-run failure.

---

## 11. Testing

### Unit (no LLM, no I/O)

- `score.test.ts` — exhaustive tier-weighting tests: all-perfect, all-zero, partial, tier-missing, K=1, K=5, variance edge cases
- `subgraph.test.ts` — deterministic traversal on fixture vault: known seed produces known subgraph; edge type filters work; cap enforced
- `storage.test.ts` — round-trip JSON read/write; history rotation at boundary; schema version handling on read

### Integration (mocked LLM, real fixture vault)

- `generate.test.ts` — mocked Anthropic client returns canned JSON responses; tests filter logic, tier-mix enforcement, augmentation
- `run.test.ts` — mocked Anthropic client + mocked MCP tools; tests trace capture, K-run aggregation, resume behavior
- `e2e.test.ts` — full pipeline against `test/fixtures/sample-vault/` with mocked LLM; locks pipeline behavior

### Real-LLM smoke (opt-in)

- `smoke.test.ts` — `skipIf(!process.env.ANTHROPIC_API_KEY)`. Runs `daftari eval` once against `test/fixtures/sample-vault/` with N=3 (1 per tier), K=1. Verifies the Anthropic SDK + MCP tool wiring works end-to-end. **Not in CI default.** Run manually before releases that touch `src/eval/`.

### Performance budget

No formal budget in v1 — eval cost is dominated by LLM latency, which is outside our control. Wall time goal: a default run (N=15, K=2) finishes in under 5 minutes. Logged for awareness; not enforced.

---

## 12. Resolved decisions for the plan

The brainstorm resolved the design-level questions (LLM tier = Sonnet, N=15/K=2, full MCP surface, history=50). The remaining implementation questions are resolved as follows; the plan stage implements them rather than re-deciding:

1. **Anthropic SDK: official, pinned, dev-only, quarantined.** Use the official `@anthropic-ai/sdk`, exact-version pinned, isolated behind one wrapper (`src/eval/llm.ts`). This is the first LLM dependency in the codebase and the only one. Because `daftari eval` is a developer/personal tool, not part of the user-facing MCP tool surface, the SDK is added as a **`devDependency` and excluded from the shipped `.mcpb` bundle** — connector users never gain an LLM dependency. A guard test asserts **nothing outside `src/eval/` imports the SDK**, enforcing the §13 "no hosted-LLM in core curation" rule mechanically rather than by convention. (Models: two distinct — generator/answerer = Sonnet, grader = Opus — see §3 and §7.1.)
2. **Sample-vault fixture coverage.** The `test/fixtures/sample-vault/` may not have enough tensions/themes to produce contradiction-tier questions. Plan stage will need to add fixture docs or skip the tier in e2e tests. Specifically: §5.3's augmentation path requires *unresolved* tensions (resolved-with-kind-accepted are excluded by the same rule that excludes them from the aging pipeline), so the fixture needs at least one unresolved tension for the augmentation path to be exercised in e2e tests — not just any tension entry.
3. **Prompt versioning.** Where do the generator/answerer/grader prompts live? Inlined constants in TS, or separate `prompts/` directory? My default: inlined, with a `PROMPT_VERSION` constant.
4. **Trace JSON size — store by reference.** Per-question traces can get large (5+ tool calls × full doc contents in tool responses). Traces store doc contents **by reference** (path + content hash) by default; a `--full-trace` debug flag opts into inlining full bodies. This bounds disk growth and keeps large vault text out of routine eval artifacts.
5. **History.json migration.** If v2 changes the schema, do we read-and-upgrade or read-only-compatible-versions? Cheapest: read-only-compatible-versions with a `spec_version` warning, defer migration.
6. **`daftari eval prune` — deferred.** Section 8's disk-growth note defers a prune command; not filed now. Revisit only if disk pressure actually shows up. (Trace-by-reference in item 4 reduces the pressure that would trigger this.)

---

## 13. What this design explicitly is NOT

- **Not a compiled-wiki feature.** The brainstorming explicitly rejected the write-surface direction. Daftari stays cortex; eval measures cortex quality. If a compiled-wiki product is wanted, it's a separate project that consumes Daftari (and other sources) as input — not a Daftari pivot.
- **Not a benchmark for absolute LLM capability.** The score depends on the specific vault, the specific model, the specific MCP surface. A 0.72 on Mihir's vault is not comparable to a 0.72 on a different vault. The metric is for **regression and improvement tracking on a single vault over time**, not cross-comparison.
- **Not a CI gate.** v1 has no `--fail-on <score>` flag. The score is informational. Once the metric stabilizes and you have a baseline, a CI gate can be a follow-up.
- **Not a substitute for `daftari audit` or `vault_lint`.** Those check structural coherence (broken refs, staleness, tensions, themes). The eval checks *traversal*. Both surfaces complement each other.
- **Not a metric of the LLM's reasoning ability in general.** It measures the LLM's reasoning *when given the Daftari cortex*. A score change can come from changes to the cortex (new tools, better tensions, more curation), changes to the model (new release), or changes to the vault contents. Diagnosing which requires running variations — e.g., the same questions against an older Daftari, or against a different model. The eval supports this via `--questions <path>` letting you re-use a question set across runs.
- **Not an optimization target to be maximized.** The score is a *diagnostic*, not an objective function. When Components A/C are built to move this number they will be tempted to game it — inflating retrieval-tier scores by keyword-stuffing or over-linking without making the vault more useful (Goodhart). Two guards, to be specified in the A/C specs: (1) validate against **fresh/rotating seeds**, never the reproducible daily seed an optimizer can overfit (§5.1); (2) keep a small **human-judged holdout** question set whose score must move in the same direction as the automated score, or the gain is suspect. The `trace_efficiency` secondary metric (§7.2) is an additional tripwire: if the score rises while tool-calls-per-correct-answer *also* rises, the cortex got harder to traverse, not easier.

---

## Appendix A: Brainstorming notes

This spec is the output of a brainstorming session (via the `superpowers:brainstorming` skill) that started from issue #97 and reframed the proposal substantially. Key moves:

1. **Surfaced that the issue's "compile" primitive doesn't exist** in the codebase. Audit is a reader, curation is advisory, neither writes derived docs.
2. **Established the curation/compile/cortex distinction.** Curation observes, audit checks, compile (proposed) transforms. These have different charters and different risk profiles.
3. **Examined the existential risks** of evolving Daftari toward compiled-wiki: identity collapse, competitor surface explosion, trust budget asymmetry, maintenance load, LLM dependency, regeneratable-lie, conceptual drift, "Karpathy said so" trap.
4. **Reframed via the cortex framing** (Daftari as structured external substrate for LLMs). Demonstrated that the cortex framing actually *picks live-compute over pre-compile* — compilation works against the cortex direction, not for it.
5. **Established two discipline rules** that preserve optionality: no compile output in vault git, no hosted-LLM dependency in core curation. This spec honors both.
6. **Scoped to Component B (quality metric)** as the prerequisite for any further sleep work, deferring Components A and C to follow-on specs.

Discipline rules (1) and (2) above are candidate additions to `CLAUDE.md`. Whether to add them is its own decision, deferred to a separate change.
