# Compile-on-Ingest + Retention Hygiene v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan Implementation-Unit by Implementation-Unit. The execution skill owns the per-unit test-first cycle.

**Readiness:** implementation-ready
**Goal:** Ship a Daftari-owned compile-on-ingest front door — raw stream in, staged graded-claim proposals out (raw discarded), human-ratified — plus distill-and-discard hardening and a minimal git-history scrub.
**Architecture:** A batch engine `src/distill/` in the sleep/consolidate family runs an internally-held LLM to extract claims from a source, emits them ONLY as `vault_stage_action` proposals (draft/low), and relies on `vault_ratify` to dispose. "Distill proposes, ratify disposes." Idempotency is by claim-key identity, not post-hoc tension. v1 is CLI-first and eval-gated; the MCP trigger and full subject-erasure subsystem are deferred.
**Tech Stack:** TypeScript/Node, existing daftari internals (staged-actions, sleep/consolidate LLM stack, git plumbing, recall-bench), `git filter-repo` (new dep).
**Source spec:** `docs/superpowers/specs/2026-08-12-compile-on-ingest-retention-v1-design.md`

---

## Requirements traceability

R1–R16 defined in the source spec. Each unit cites the R-IDs it advances.

## File structure

**Net-new**
- `src/distill/index.ts` — engine entry (orchestrates adapter → chunk → extract → emit).
- `src/distill/adapters/chat-transcript.ts` — first source adapter (ports an existing chat-export parser prototype).
- `src/distill/adapters/types.ts` — `SourceAdapter` interface.
- `src/distill/chunk.ts` — chunker.
- `src/distill/extract.ts` — claim-extraction (internal LLM call).
- `src/distill/propose.ts` — proposal emitter → `vault_stage_action`.
- `src/distill/state.ts` — `.daftari/distill-state.json` read/write + claim-key identity + upsert join.
- `src/distill/cost.ts` — `--plan` pre-flight estimate + budget wiring.
- `src/tools/erase.ts` — `vault_erase` minimal scrub tool.
- `src/utils/git-erase.ts` — filter-repo + reflog/gc + remote force-push.
- `docs/PRIVACY.md`, `docs/erasure-protocol.md` — R10, R14.

**Modified**
- `src/cli.ts` / `src/index.ts` — register `daftari distill` (+ `--review`) and `vault_erase`.
- `src/utils/config.ts` — `distill:` config block + `erase` role capability.
- `src/curation/lint.ts` — `verbatim_quote_overrun` advisory sub-check.
- `src/frontmatter/types.ts` (declare field) + `src/frontmatter/schema.ts` (hand-rolled validator) — reserve `subjects: string[]`.
- `integrations/recall-bench/src/adapter.ts` (`ingestDay` / `cfg.compile`) + `integrations/recall-bench/src/compiler.ts` — wire the distill compile path as a new compiler-arm mode.
- `src/utils/vault-gitignore.ts` — add `.daftari/distill-state.json`, `.daftari/erasures.jsonl`.

---

## Implementation Units

### U1. Distill engine skeleton + chat-transcript adapter
**Goal:** The `src/distill/` module boundary, a `SourceAdapter` interface, and a chat-transcript adapter that turns `_chat.txt` into normalized messages.
**Requirements:** R1, R7.
**Dependencies:** none.
**Files:** `src/distill/index.ts`, `src/distill/adapters/types.ts`, `src/distill/adapters/chat-transcript.ts`, `test/distill/chat-transcript.test.ts`.
**Approach:**
1. Define `SourceAdapter` (`parse(raw): NormalizedMessage[]`, `sourceId()`), so later adapters (mailbox, notes) drop in.
2. Port the proven chat-export parser prototype (iOS+Android export formats, multiline join, call/attachment/edited/deleted/system classification) to TS.
3. Engine entry is a thin orchestrator stub for now (adapter → [chunk] → [extract] → [propose]) filled by later units.
**Test scenarios:**
- iOS `[M/D/YY, H:MM:SS AM/PM] Sender: msg` line → one message with correct ts/sender/text.
- Continuation line (no bracket) → appended to previous message body.
- `<attached: file>` / "image omitted" / call / edited / deleted lines → correct type classification.
- Empty file → `[]`, no throw.
**Patterns to follow:** existing adapter/module layout under `src/`; the Python parser's classification rules.
**Verification:** adapter parses the real sample transcript to the same message count the Python prototype produced.

### U2. Internal LLM client + `distill:` config gate
**Goal:** Distill holds an LLM client via the existing stack, and refuses to run without an explicit `distill:` config block.
**Requirements:** R2, R6.
**Dependencies:** U1.
**Files:** `src/distill/index.ts`, `src/utils/config.ts`, `test/distill/config-gate.test.ts`.
**Approach:**
1. Reuse `createAnthropicClient`/`createOpenRouterClient` via `resolveTransport` (mirror `src/sleep/`/`src/consolidate/` construction incl. fail-fast key check).
2. Add a `distill:` config block (model, `max_llm_calls`, `max_claims`, `max_verbatim_chars`, MCP `in_call_input_cap`).
3. Absent `distill:` → refuse to run with a clear error (the shadow_mode refuse-to-run posture).
**Test scenarios:**
- Config with `distill:` present → client constructs, transport resolves.
- Config missing `distill:` → distill errors "distill not configured", no LLM call.
- Missing API key for the resolved transport → fail-fast before any spend.
**Patterns to follow:** `src/consolidate` / `src/sleep` client construction + config-block conventions.
**Verification:** run against a vault with and without the block; correct refuse/allow.

### U3. Chunker + claim extraction
**Goal:** Turn normalized messages into proposed claims via a budgeted internal LLM pass.
**Requirements:** R1, R2.
**Dependencies:** U1, U2.
**Files:** `src/distill/chunk.ts`, `src/distill/extract.ts`, `test/distill/extract.test.ts`.
**Approach:**
1. Chunker: turn-window chunking over messages (strategy is a `## Deferred to Implementation` knob).
2. Extraction prompt asks for discrete claims/decisions/facts with a stable in-chunk anchor; each claim gets `{claim_key, statement, proposed_frontmatter}`.
3. Wrap calls in `withCallBudget`; extraction is deterministic-enough that the same source yields the same `claim_key`s (feeds U5).
**Test scenarios:**
- A short transcript chunk → ≥1 claim with non-empty statement + a `claim_key`.
- Re-running extraction on identical input → identical `claim_key`s (determinism contract; mock the LLM).
- Budget exhausted mid-run → stops, returns partial with a `budget_exhausted` marker (no throw).
**Patterns to follow:** `withCallBudget` usage in consolidate/sleep; prompt-file layout if the repo externalizes prompts.
**Execution note:** mock the LLM in tests; assert on the engine's handling of responses, not model quality (quality is U10's job).

### U4. Proposal emitter → staged actions
**Goal:** Emit each claim as a `vault_stage_action("write")` proposal at draft/low/synthesized, stamped with `run_id`.
**Requirements:** R3.
**Dependencies:** U3.
**Files:** `src/distill/propose.ts`, `test/distill/propose.test.ts`.
**Approach:**
1. Map each claim to a `write` staged-action payload (`{frontmatter, body}`) with `status: draft`, `confidence: low`, `provenance: synthesized`, `proposed_by: "agent:distill"`, `run_id`.
2. Route through `stageActionWithConflictCheck` so inter-proposal conflicts + tier-0 gates fire (reuse, no new gate).
3. Never call `performWrite` directly — staging only.
**Test scenarios:**
- One claim → one staged `write` action with the correct frontmatter defaults + `run_id`.
- A proposal that declares `status: canonical` → blocked by the tier-0 gate (reused).
- Two proposals targeting the same path in one run → conflict surfaced via `stageActionWithConflictCheck`.
- Assert no `performWrite`/commit occurs during distill (spy).
**Patterns to follow:** `src/tools/staged-actions.ts`, `src/curation/staged-actions.ts`.
**Verification:** staged actions appear in the queue; ratifying one lands the doc via existing `vault_ratify`.

### U5. Claim-level idempotency (state + upsert)
**Goal:** Re-distilling a source upserts by claim-key instead of minting duplicate siblings.
**Requirements:** R4.
**Dependencies:** U3, U4.
**Files:** `src/distill/state.ts`, `src/utils/vault-gitignore.ts`, `test/distill/idempotency.test.ts`.
**Approach:**
1. `.daftari/distill-state.json`: per `source-id` → `{content_hash, claims: {claim_key → landed_path}}`. Mark processed only after the proposal lands (consolidate `birthProcessed` lesson).
2. Each claim carries `sources: ["distill:<source-id>#<claim-key>"]` (tier0 EXTERNAL_REF-tolerated).
3. Re-distill join: unchanged content_hash ⇒ no-op; changed ⇒ per claim: match+unchanged skip, match+changed stage update-in-place (write to same path), no-match stage new write (F3 policy: `supersede` only when meaning flips).
4. Add both jsonl/json state files to gitignore.
**Test scenarios:**
- Distill source S twice unchanged → run 2 stages 0 proposals (no-op).
- Edit one claim in S, re-distill → exactly one update proposal for that claim-key, others skipped.
- Add a new message producing a new claim → one new-write proposal; existing untouched.
- State marks a claim processed only after its proposal lands (simulate ratify), not at emit.
**Patterns to follow:** `src/consolidate/birth.ts` content-hash processed-state.
**Verification:** the near-duplicate-on-re-distill failure does not occur; tension surface stays clean across two runs.

### U6. `--plan` pre-flight + cost/ZDR receipt
**Goal:** Free pre-flight estimate and per-run cost/provider recording.
**Requirements:** R6.
**Dependencies:** U3.
**Files:** `src/distill/cost.ts`, `test/distill/cost.test.ts`.
**Approach:**
1. `--plan`: compute chunk count + estimated LLM calls + `estimateCostUSD` with zero spend.
2. On `--propose`, record actuals + `provider` + ZDR flag into the run receipt.
3. Hard caps from config (`max_llm_calls`, `max_claims`) enforced via `withCallBudget`.
**Test scenarios:**
- `--plan` over a source → estimate returned, zero LLM calls made (spy).
- `--propose` exceeding `max_claims` → stops at the cap, receipt notes truncation.
- Receipt records provider + ZDR flag.
**Patterns to follow:** `estimateCostUSD`/`isModelPriced`; langgraph `--plan/--apply` two-step.
**Verification:** `--plan` never spends; `--propose` honors caps.

### U7. CLI front door `daftari distill`
**Goal:** The primary invocation surface.
**Requirements:** R1.
**Dependencies:** U1–U6.
**Files:** `src/cli.ts`, `src/distill/index.ts`, `test/distill/cli.test.ts`.
**Approach:**
1. `daftari distill <file|-> [--source-id <id>] [--plan|--propose] [--max-llm-calls n] [--max-claims n] [--model id] [--transport ...]`.
2. Exit-code convention: 0 ok, 2 usage, 3 config/refuse, distinct code for partial-emit failure.
**Test scenarios:**
- `--plan` path prints estimate, exit 0.
- Missing `distill:` config → exit 3 with the refuse message.
- Bad usage (no source) → exit 2.
**Patterns to follow:** existing `src/cli.ts` command registration (`daftari import`, `daftari sleep`).
**Verification:** `daftari distill --plan <sample>` runs end-to-end with no spend.

### U8. Overlap hint on proposals
**Goal:** Attach likely-collision neighbors to each proposal without an LLM.
**Requirements:** R5.
**Dependencies:** U4.
**Files:** `src/distill/propose.ts`, `test/distill/overlap-hint.test.ts`.
**Approach:** for each proposed claim, run `vault_search_related` (no LLM) and attach top-K neighbor paths to the proposal rationale as "possible overlaps." Tension detection itself stays with the existing sleep tension-scan — distill runs none.
**Test scenarios:**
- A proposal near an existing canonical doc → that doc appears in the overlap hint.
- A novel claim → empty/short hint, no throw.
- Assert distill triggers no tension-scan / LLM during hinting.
**Patterns to follow:** `vault_search_related` callers.
**Verification:** ratifier sees overlaps; no tension code runs at distill time.

### U9. Batch-ratify by run_id
**Goal:** Review/approve a whole run's proposals without one-by-one elicitation.
**Requirements:** R3 (net-new convenience).
**Dependencies:** U4.
**Files:** `src/cli.ts`, `src/distill/index.ts`, `test/distill/review.test.ts`.
**Approach:** `daftari distill --review <run_id>` lists that run's staged actions and dispatches approvals through the existing ratify path (F2: CLI-first, don't grow the MCP ratify tool). Commits land per claim (F3 taste: history per claim).
**Test scenarios:**
- `--review <run_id>` lists exactly that run's proposals.
- Approve-all → each lands via `vault_ratify`; N commits.
- Unknown run_id → empty list, exit 0.
**Patterns to follow:** `vault_ratify` invocation.
**Verification:** a full distilled run can be reviewed and landed in one command.

### U10. Eval gate — wire distill into recall-bench
**Goal:** Measure compile quality on the benchmark before user exposure.
**Requirements:** R16.
**Dependencies:** U1–U5.
**Files:** `integrations/recall-bench/src/adapter.ts` (`ingestDay` / `cfg.compile`), `integrations/recall-bench/src/compiler.ts`, `test/eval/distill-arm.test.ts`.
**Approach:** register the distill compile path as a new `cfg.compile` mode in the recall-bench adapter's `ingestDay` (alongside the existing `raw` / `write+consolidate` modes) so recall-bench runs the fixed internal compiler over benchmark days and scores recall. Because Daftari owns the compiler (R2), the arm is reproducible.
**Test scenarios:**
- Compiler-arm ingests a benchmark day via distill → produces landed claims recall-bench can query.
- Arm is deterministic across two identical runs (mock LLM) — same claims.
**Execution note:** this is the gate; prefer running it before U7/U9 expose distill to real use.
**Patterns to follow:** existing recall-bench compiler-arm scaffolding.
**Verification:** a recall-bench number exists for the distill arm.

### U11. Distill-and-discard fence
**Goal:** Raw never lands under the vault, even transiently.
**Requirements:** R8.
**Dependencies:** U1.
**Files:** `src/distill/index.ts`, `src/fence/detect.ts`, `test/distill/fence.test.ts`.
**Approach:** buffer raw in an OS tmp dir outside `vaultRoot`; a fence check refuses any distill output path under a `raw/` prefix or a `tier: source` landing (reserved for `daftari import`).
**Test scenarios:**
- Raw buffered path is outside `vaultRoot` (assert).
- A proposal whose target is under `raw/` → refused by fence.
- A `tier: source` distill landing → refused.
**Patterns to follow:** `src/fence/detect.ts`.
**Verification:** no raw artifact appears anywhere under the vault after a run.

### U12. Verbatim-quote budget + lint
**Goal:** Cap verbatim raw fragments in compiled notes.
**Requirements:** R9.
**Dependencies:** U3.
**Files:** `src/distill/extract.ts`, `src/curation/lint.ts`, `test/curation/verbatim-lint.test.ts`.
**Approach:** extraction paraphrases by default; any quote is capped at `distill.max_verbatim_chars` and attributed to a `sources[]` pointer; an advisory lint flags overruns (register the check as `verbatimQuoteOverrun` in `LINT_CHECKS` — camelCase per the existing convention like `malformedPins`; the user-facing string may be `verbatim_quote_overrun`), advisory-only like `positionIntegrity`/`malformedPins`.
**Test scenarios:**
- A doc with a quote over the cap → advisory lint flags it; lint still passes overall.
- A within-cap quote → no flag.
- Quote lacks a `sources[]` attribution → flagged.
**Patterns to follow:** advisory sub-check registration in `src/curation/lint.ts`.
**Verification:** lint surfaces overruns without blocking.

### U13. PRIVACY + provenance-pointer docs
**Goal:** Document the retention boundary honestly.
**Requirements:** R10.
**Dependencies:** none.
**Files:** `docs/PRIVACY.md`.
**Approach:** state that distill-and-discard bounds Daftari's retention, not the provider's (raw transits the synthesis provider); the `distill:<source-id>#<claim-key>` pointer is an audit breadcrumb, not a re-derivation source (dangling acceptable).
**Test expectation:** none — documentation only.
**Verification:** doc reviewed for accuracy against R2/R10.

### U14. `vault_erase` minimal scrub
**Goal:** Source/path-keyed history scrub for accidental sensitive commits.
**Requirements:** R11, R12, R13.
**Dependencies:** none (independent of distiller).
**Files:** `src/tools/erase.ts`, `src/utils/git-erase.ts`, `src/access/rbac.ts`, `src/utils/config.ts`, `src/utils/vault-gitignore.ts`, `test/tools/erase.test.ts`.
**Approach:**
1. `vault_erase({path|source_ref, confirm})`: RBAC `erase` capability + confirmation (echo the path).
2. `git-erase.ts`: worktree removal + `filter-repo` history rewrite + `reflog expire` + `gc` in the git_dir-aware location. **`filter-repo` is a required dependency** — if absent, refuse the history op and return `incomplete:["git-history: filter-repo not installed"]`; never a silent worktree-only no-op (R11).
3. Configured remote: force-push rewritten refs; GitHub/ADO can't self-serve gc → name the remote in the `incomplete[]` receipt.
4. Append a content-free receipt to `.daftari/erasures.jsonl`; for secret-shaped input, receipt/guidance says rotate first.
**Test scenarios:**
- Erase a path present in history → gone from worktree AND history; receipt written.
- `filter-repo` unavailable → history op refused, `incomplete:["git-history: filter-repo not installed"]`, worktree untouched-or-safe, loud.
- No `erase` capability → denied.
- Confirm token mismatch → aborted.
- Configured remote → receipt names it in `incomplete[]` (can't guarantee remote gc).
- Separate-git-dir vault → gc runs against the resolved git_dir.
**Patterns to follow:** `src/utils/git.ts` execFile-array no-shell discipline; RBAC capability checks in `src/access/rbac.ts`.
**Verification:** canary — erase a synthetic marker, then grep worktree + history + logs for it → absent (locally).

### U15. Coordinated multi-clone rewrite protocol docs
**Goal:** Document the human protocol for a shared git-pushed vault.
**Requirements:** R14.
**Dependencies:** U14.
**Files:** `docs/erasure-protocol.md`.
**Approach:** force-push → all clones re-clone/reset → request remote (GitHub/ADO) purge → rotate any exposed secret.
**Test expectation:** none — documentation only.
**Verification:** doc reviewed against R12/R14.

### U16. Reserve `subjects[]` field
**Goal:** Format hook for the deferred subject-erasure subsystem.
**Requirements:** R15.
**Dependencies:** none.
**Files:** `src/frontmatter/types.ts` (declare the field on `Frontmatter`), `src/frontmatter/schema.ts` (hand-rolled validation), `test/frontmatter/subjects-field.test.ts`.
**Approach:** add `subjects: string[]` as a built-in optional field, default `[]`, validated by the **hand-rolled** frontmatter validator (not Zod) — follow the existing built-in array-field pattern (e.g. `tags`/`sources`). Not populated by distill, no cascade — reserved so future subject-keyed erasure is a feature-add, not a migration.
**Test scenarios:**
- Doc without `subjects` → validates, defaults `[]`.
- Doc with `subjects: ["person:x"]` → validates.
- `subjects` of wrong type → schema error.
**Test expectation:** minimal — schema validation only.
**Verification:** schema accepts/rejects as above; no behavior change elsewhere.

---

## Deferred to Implementation

- Chunker strategy for chat transcripts (turn-window size vs semantic) — decide against real extraction quality (U3).
- `<claim-key>` construction stability across re-chunking as an append-only source grows (U5).
- Exact extraction prompt + whether prompts are externalized files (U3).
- Whether U14's worktree removal reuses `vault_deprecate` semantics or is a clean path-scrub (spec open question).
- Default synthesis transport/model (Anthropic vs OpenRouter) + cost-cap defaults (U2/U6).

## Deferred to Follow-Up Work

- **MCP `vault_distill` bounded trigger** (spec F1) — add after the CLI + eval arm prove the compiler; it would be Daftari's first spending MCP tool.
- **Full subject-keyed GDPR erasure subsystem** — gated on the third-party-PII trigger (design: `daftari-retention-erasure-design.md`).
- **Policy auto-accept of proposals** — ratifier-side change; v1 is human-ratifies.
- **Additional source adapters** (mailbox, meeting notes) — after the chat adapter proves out.

## Sequencing rationale

Engine first (U1–U6), then the eval gate (U10) measures compile quality on a fixed internal compiler before any user exposure (eval-first, the one Posture-A failure that can't be walked back). Only then the CLI/UX surface (U7–U9). Retention hardening (U11–U13) and the independent scrub (U14–U15) and the format hook (U16) can proceed in parallel with the distiller track — U14/U16 have no distiller dependency.
