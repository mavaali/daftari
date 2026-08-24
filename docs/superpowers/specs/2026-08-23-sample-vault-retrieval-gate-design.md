# Sample-vault retrieval regression gate

**Date:** 2026-08-23

**Status:** Implemented

**Issue:** #301

**Depends on:** `2026-07-07-regression-suite-design.md`, PR #448

## Problem

[DATA] PR #448 added recall@5, MRR, and nDCG@5 to the existing synthetic
Tier-1 retrieval suite. Its 300 field-isolated queries all rank their singleton
answer first, so every aggregate metric is 1.0. That gate proves the metric
plumbing and catches mechanical field-indexing failures; it does not exercise
ranking ambiguity over the real prose, overlapping topics, superseded/current
pairs, or multi-document answers in `test/fixtures/sample-vault`.

[DATA] The approved regression-suite design keeps PR-gating retrieval hermetic:
committed fixtures, no network, no model load, and exact golden diffs. #301 also
requires the shipped `vault_search` surface and fusion where feasible. A
committed replay of vectors produced once by the default local MiniLM provider
makes that fusion path deterministic and CI-safe. Credentialed provider
comparisons still belong to Tier 2 because OpenAI requires network access and a
secret.

## Decision

[DATA] Add a second Tier-1 retrieval test over the existing 10-document sample
vault. Freeze 25 natural-language questions in JSONL. Questions carry stable
IDs, one or more known relevant paths, their provenance (`questions_answered`,
`questions_raised`, or `curated`), and a rationale so the ground truth is
reviewable in the PR rather than hidden in test code.

[DATA] Run each question through the exported `vaultSearch` tool logic at limit
10 under two shipped configurations:

- pure lexical weights `{ bm25: 1, vector: 0 }`;
- the shipped default fusion weights (currently `{ bm25: 0.8, vector: 0.2 }`),
  selected by omitting the tool's `weights` argument.

[DATA] The fixture stores 35 float vectors as base64: 10 sample-vault chunks and
25 queries, produced by the shipped `local-minilm` provider. SHA-256 input hashes
bind every vector to exact chunk/query text, and usage labels make the mapping
reviewable. A fixture provider fails on any unrecognized text. It is installed
before reindex, never loads MiniLM, never accesses the network, and its `warm`
method deliberately fails if called. The test asserts lexical queries make no
embedding call, fusion queries report `vectorUsed: true`, no warmup occurs, and
every committed vector is consumed. At least one query's ranked answer paths
must differ between lexical and fusion, preventing a vector-on arm that is
technically exercised but behaviorally inert.

[DATA] The temporary vault is assembled from an explicit manifest of the 12
Git-tracked sample-vault inputs. It never recursively copies the source tree,
so ignored local state such as `index.db`, read logs, staged actions, or
untracked Markdown cannot contaminate the corpus or satisfy an embedding-cache
lookup.

[DATA] Runtime parsers validate the JSONL question shape, source enum, trimmed
non-empty values, normalized ID/query/path uniqueness, and corpus membership.
TypeScript assertions alone are not treated as fixture validation.

## Evidence and threshold

[DATA] The committed baseline records, per query and per arm:

- the 1-based rank of every relevant path (`0` means absent from the top 10);
- recall@5 and recall@10;
- reciprocal rank;
- binary nDCG@10.

[DATA] It also records mean recall@5, mean recall@10, MRR, and mean nDCG@10
for the lexical and fusion arms. Scores are rounded to six decimal places. The
stated Tier-1 tolerance is **0**: deterministic lexical and vector-replay
behavior must exact-diff. A changed rank or metric blocks the PR until the
search regression is fixed or a reviewer accepts a baseline delta generated
with `npm run regression:update-baseline`.

[DATA] The question-set evidence threshold is 20–50 unique questions, matching
#301. Every question must have non-empty rationale and at least one relevant
path present in the indexed corpus. The gate also pins the corpus at 10 indexed
documents, zero skipped documents, and the one intentional invalid-frontmatter
fixture.

## CI placement and failure semantics

[DATA] `.github/workflows/ci.yml` already runs `npx vitest run test/regression`
as the named required `regression` job, so placing this test under
`test/regression/retrieval/` wires it into CI without adding another workflow or
duplicating installation/indexing machinery.

[DATA] A red means one of three things:

1. the frozen question/answer evidence is malformed;
2. the sample corpus changed without an intentional golden update;
3. retrieval ranks or metrics changed.

[DATA] This gate measures retrieval only. It does not judge generated answers,
download embeddings, call an LLM, mutate the source fixture, or define Tier-2
credentialed-provider tolerances. Regenerating the committed vector fixture is
an explicit developer action (`npm run regression:update-sample-embeddings`),
never part of CI.
