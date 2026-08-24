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
committed fixtures, lexical ranking, no network, no model load, and exact
golden diffs. Vector and hybrid-provider measurements belong to Tier 2 because
their platform-dependent floats and model availability require tolerance and a
retry policy.

## Decision

[DATA] Add a second Tier-1 retrieval test over the existing 10-document sample
vault. Freeze 25 natural-language questions in JSONL. Questions carry stable
IDs, one or more known relevant paths, their provenance (`questions_answered`,
`questions_raised`, or `curated`), and a rationale so the ground truth is
reviewable in the PR rather than hidden in test code.

[DATA] Run each question through `hybridSearch` at limit 10 under both shipped
lexical granularities:

- document BM25: title, tags, and whole body;
- chunk BM25: passage scoring with the title/tag fallback.

[DATA] Both arms use weights `{ bm25: 1, vector: 0 }` after a
`lexicalOnly: true` reindex. The test asserts that zero embeddings were created,
the index reports vectors disabled, and every query reports `vectorUsed: false`.
The provider matrix is therefore explicitly excluded from the PR gate: local
MiniLM requires a model artifact; OpenAI requires network and credentials; zero
vectors would be a fake fusion test. Those arms remain in Tier 2 per the
approved design.

## Evidence and threshold

[DATA] The committed baseline records, per query and per arm:

- the 1-based rank of every relevant path (`0` means absent from the top 10);
- recall@5 and recall@10;
- reciprocal rank;
- binary nDCG@10.

[DATA] It also records mean recall@5, mean recall@10, MRR, and mean nDCG@10
for each arm. Scores are rounded to six decimal places. The stated Tier-1
tolerance is **0**: deterministic lexical behavior must exact-diff. A changed
rank or metric blocks the PR until the search regression is fixed or a reviewer
accepts a baseline delta generated with `npm run regression:update-baseline`.

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
vector tolerances.
