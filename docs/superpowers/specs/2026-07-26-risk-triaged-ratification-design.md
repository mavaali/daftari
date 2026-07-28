# Risk-triaged ratification — design

2026-07-26. Status: **implemented (2026-07-28)**, after Jugalbandi dialectical
review. The final plan resolved eight challenges (see
`.jugalbandi/risk-triaged-ratification/final-plan.md`) and Mihir's 2026-07-27
decision on the one escalated contradiction (Decision 1 vs. kill condition #1,
below). The amendments below (C bullet, diff-size buckets, T-term
canonicalization, W/witness keying, and the Decision 1 carve-out) are the
disposition of that review, applied to this text per the plan's Phase 6 —
corrected in place, not silently deviated from, because the spec was still
"proposed" when implementation started.

## Why

docs/architecture.md's Honest assessment names the kill condition for the
central wager: advisory-only curation is right *if* ratification keeps pace
with the flags, and the kill signal is the staged-action queue and the
unresolved-tension count growing without bound — "advisory quietly becomes
ignored." We already built the instrument that watches for it:
`reviewThroughputSummary` (src/curation/review-throughput.ts) counts arrivals vs.
decisions vs. expiries, and its own comment calls an expiry "the
review-capacity wall showing up in the data." This spec is the defense that
instrument was waiting for: make the reviewer's scarce attention land on the
proposals where a wrong verdict costs the most.

The 2026 HITL literature converges on the same shape. Velt's review-queue
guidance (June 2026), alldaystech's "AI Review Queues 2026," and MindStudio's
HITL patterns all land on **risk-triggered routing**: an unranked review
queue becomes a rubber stamp; a queue item should show *proposed action, key
evidence, likely consequence*; routing should key on large diffs, conflicting
sources, and agent retries; and every reviewer decision should be logged with
a correction category, because the corrections are the signal the system
learns from. Meanwhile memorywire/AMP (arXiv 2606.01138, June 2026)
standardizes diff-and-approve HITL governance for agent memory — daftari's
staged-action queue predates the standard, and this spec is where it catches
up on the one axis the standard got right and we lack: triage.

Today the queue is ordered by the only clock it has. `pendingLintItems`
(src/curation/staged-actions.ts) sorts pending actions soonest-to-expire
first. That ordering answers "what dies next," not "what matters most" — a
typo-fix `confidence-up` expiring Tuesday outranks a `supersede` of a
20-dependent pricing doc expiring Thursday. Four decisions fix that.

## Decision 1 — the risk score is derived, deterministic, never stored

Every pending staged action gets a risk score in [0, 1], **recomputed on
read, never stored as authority** — the same posture as `derives_from`
strength (docs/architecture.md: "Strength is never stored as a counter. It is
recomputed from the trail on every read"). No `risk` field is appended to
`.daftari/staged-actions.jsonl`, no column lands in the sqlite
`staged_actions` table. A stored score goes stale the moment the vault moves
under it — the blast radius changes when a dependent is written, the tension
term changes when a tension resolves — and a stale authority is worse than a
recomputed estimate. Derivation also keeps the log honest: the JSONL remains
a record of what was *proposed and decided*, never of what some scorer once
thought.

**Amendment (Mihir, 2026-07-27), narrow carve-out:** every decision record
(ratify or reject) additionally carries a `risk_at_decision` field —
JSONL-only, still never mirrored to sqlite, and **never read to influence
queue ordering** (`rankPendingActions` does not read it; nothing does but the
kill-condition-#1 analysis). It resolves the contradiction between this
paragraph's ban and Kill condition #1's need for "risk quartile at decision
time": B and T (0.40 of the total weight) are not replayable from the
present-state log alone once the vault has moved on (a dependent gets
written, a tension resolves), so a *frozen observation* stamped at the moment
of decision is the only way to make that condition evaluable without
approximation. This is a snapshot of a fact ("what the score computed to,
right then"), not a stored authority ("what the score currently is") — the
same distinction `ratified_at` / `ratified_by` already draw for every other
decision field.

The score is a weighted sum of six deterministic terms, no LLM anywhere:

$$R(a) = \mathrm{clamp}_{[0,1]}\big(w_K K + w_D D + w_B B + w_T T + w_C C + w_W W\big)$$

- **K — action-kind weight.** An exported table, provisional like
  `WAGER_STAKES` in src/witness/track-record.ts: `supersede` 1.0, `merge`
  1.0, `deprecate` 0.8, `write` 0.6, `promote` 0.5, `confidence-up` 0.2. A
  supersession rewires the current-source chain every reader follows; a
  confidence bump is one field.
- **D — proposed-diff size.** `min(1, log10(1 + bytes)/4)` over the
  serialized `proposed_diff` — log-scaled so a 10 KB payload saturates and a
  one-field delta stays near zero. Large diffs are the literature's first
  routing trigger, and the size is already sitting in the record.
  **Amendment (2026-07-27 final plan, C3):** the queue item's displayed
  `small`/`medium`/`large` diff-size bucket is defined over **raw serialized
  bytes** (`< 256` / `< 4096` / `≥ 4096`), decoupled from D's own formula
  above. D<0.25 is unreachable in fewer than 9 bytes — no valid payload is
  that small — so a bucket boundary drawn on D itself made `small`
  mathematically unreachable and every lifecycle action read "medium." D's
  formula is unchanged; only the display bucket moved to raw bytes.
- **B — blast radius of the target.** Reuses the vault_tension_blast
  machinery (src/curation/tension-blast.ts): `min(1, primary/10 +
  advisory/40)` over the target's **direct (distance-1)** inbound `sources`
  and link edges — the reverse-source and reverse-link maps are already
  built on demand from loaded docs; scoring N pending actions builds them
  once and probes N targets with no traversal (`computeBlast`'s BFS is not
  called) — no new graph state.
- **T — open tension.** 1 when the target sits in an unresolved tension
  (the `contestedDocs` set the witness already computes), else 0. Ruling on
  a contested doc is exactly the verdict that deserves a human's full
  attention. **Amendment (2026-07-27 final plan, C5):** tension endpoints
  (`sourceA`/`sourceB`) are free-form caller strings, while a staged
  action's target is always a canonicalized relPath — raw string equality
  between them silently understates T on aliased spellings. Endpoints are
  canonicalized via the same link-resolution the codebase already uses for
  aliased vault links before the comparison runs, with raw-string fallback
  for an endpoint that resolves to nothing (it cannot match a live target
  anyway).
- **C — conflict / retry markers.** 1 when the proposal carries a non-empty
  `conflicts_with` (the #235 inter-proposal check in
  `stageActionWithConflictCheck`), or when the log holds a prior *rejected*
  proposal of the same kind against the same target **with no later
  *ratified* proposal for that same pair**. Else 0. **Amendment (2026-07-27
  final plan, C1):** `expired` was removed from this clause. Decision 3's own
  W-term rationale (below) already states "an expiry is reviewer capacity,
  not a human declining" — counting it here too both contradicted that
  rationale and double-counted the same record (C's flat +0.10 on top of W's
  `expired/2`), and after one TTL-cycle backlog flush, `expired` would have
  become a near-constant hit on exactly the vaults that most need triage. A
  later ratified proposal on the same `(actionType, targetPath)` pair clears
  the mark — the human approving a subsequent proposal on that target is not
  the "retrying something already declined" signal this term exists to flag.
- **W — proposer track record.** The witness's per-principal proposal
  tallies (src/witness/track-record.ts), Laplace-smoothed so a new principal
  defaults to the middle instead of the extremes:
  `(rejected + edited + expired/2 + 1) / (ratified + rejected + edited +
  expired/2 + 2)`, where `ratified` here means *plain* approvals
  (`ratified − edited`, so an edit-then-approve is not double-counted).
  Expiries count half — an expiry is reviewer capacity, not proposer fault,
  but a principal whose proposals *always* expire is flooding the queue and
  should pay some triage cost. `edited` is new; Decision 3 creates it.
  **Amendment (2026-07-27 final plan, C4):** tallies key on the
  **authenticated `staged_by_principal`** (the caller's `access.user` at
  stage time) when a proposal record has one, falling back to the
  unauthenticated, caller-claimed `proposed_by` string only for legacy
  records or proposals staged without an access context. Keying on
  `proposed_by` alone let a fresh claimed-agent string reset a principal's
  history to the Laplace midpoint (laundering) and let junk staged under a
  rival's claimed name count against the rival instead of the actual stager
  (poisoning) — the same authenticated-identity fix already applied to the
  decision side (`decided_by_principal`) but never to the proposal side
  until this spec.

The weights are exported constants, provisional, and to be calibrated
against the outcome data Decision 3 starts collecting — the same "the
constants are the thing being calibrated" stance the wager schedule takes.
The score is **ordinal**: it exists to sort, and nothing in this spec
attaches a threshold to it. Thresholds are where auto-approval sneaks in,
and auto-approval is out of scope.

## Decision 2 — surface by risk; batch ratify is an explicit list, never a threshold

`vault_lint`'s staged-actions section and any queue listing order pending
actions **risk descending, soonest-to-expire as the tiebreak** — inverting
today's expiry-first sort while keeping the expiry clock as the secondary
key, so among equally risky actions the one about to die still surfaces
first. Each item carries the literature's triple:

- *proposed action* — id, kind, target (already present);
- *key evidence* — the rationale's first sentence (already trimmed by
  `firstSentence`), the diff-size bucket, and the proposer with their
  smoothed track-record term;
- *likely consequence* — the visible blast counts, plus flags for open
  tension and inter-proposal conflict.

All of it is recomputed at read time from data the lint path already loads;
the item shape grows fields, the log grows nothing.

**Batch mode.** `vault_ratify` gains an `ids` array as an alternative to
`id`, for bulk decisions on low-risk actions. The design question is whether
batch approval is compatible with "a human ratifies deliberately," and the
honest answer is: only in one narrow form. The deliberate act the queue
exists to protect is a human *reading a proposal and choosing*. A batch of
explicitly enumerated ids preserves that — the human read the ranked queue,
judged each line, and is amortizing the tool round-trips, not the judgment.
What destroys it is any form where the *score* chooses: "approve everything
below 0.2" delegates the verdict to the scorer, which is the auto-approval
tier wearing the reviewer's name. So:

- Batch is an **explicit list of ids**. The tool accepts no threshold, no
  predicate, no "all pending" sentinel — not as an unimplemented option but
  as a contract: the parameter shape cannot express it.
- Each id is processed independently: RBAC, pending-status check, and the
  tier-0 gates run per action exactly as today; a gate block or dispatch
  failure leaves *that* action pending and the batch continues, with per-id
  outcomes in the result. No transactional all-or-nothing — a batch is N
  deliberate verdicts, not one compound one.
- Batch size is capped (exported constant, proposed 20). An explicit list of
  200 ids is enumeration-shaped rubber-stamping; if the queue needs 200
  approvals at once, the problem is upstream in the proposal rate, and the
  cap makes that visible instead of absorbing it.
- `amended_diff` (Decision 3) is single-id only. An amendment is per-action
  deliberation by definition; a batch cannot carry one.

## Decision 3 — every verdict is logged with a category and folds into the witness

Every ratification decision is appended to `.daftari/staged-actions.jsonl`
as today's decision record — append-only house pattern, proposal and
decision as separate records under one id — extended with two fields:

- `decision_kind`: `approve` | `edit-then-approve` | `reject`.
- `reason_category`: a closed enum — `wrong-conclusion`, `wrong-target`,
  `overbroad`, `stale-evidence`, `duplicate`, `formatting`, `policy`,
  `other`. Required on `reject` and `edit-then-approve`, optional on plain
  `approve`. The existing free-text `reason` stays as the human elaboration;
  the category is the machine-readable signal the free text never was.

`edit-then-approve` is new mechanics: `vault_ratify` accepts an optional
`amended_diff` on approve. The dispatch (and the tier-0 gates) run against
the amended payload instead of the staged one; the decision record stores
the amendment, so the log preserves both what was proposed and what actually
landed. Status-wise it collapses to `ratified` — `STAGED_ACTION_STATUSES` is
unchanged, and old readers that ignore the extra fields keep collapsing the
log correctly. Today the reviewer's only options are approve-as-is or
reject-and-someone-restages; the edit path captures the most informative
outcome in the literature — *the human accepted the intent but corrected the
content* — instead of losing it as either a false clean approve or a false
total reject.

The witness closes the loop. `buildWitness` already tallies
ratified/rejected/expired/pending per proposer; it gains an `edited` count
from `edit-then-approve` records and a per-category breakdown. Decision 1's
W term reads those tallies, so **a principal whose proposals are frequently
edited or rejected gets a higher default risk score** — their next proposals
sort toward the top of the queue, where they get more scrutiny, not less.

And the boundary, stated as flatly as the architecture doc states its
tensions rule: **the loop adjusts triage order, never verdicts.** Outcome
data raises or lowers where a proposal sits in the queue. It never
auto-approves, never auto-rejects, never expires anything early, never
throttles a principal's ability to stage. A track record that could close
the gate would make the witness an enforcement system, and the witness's own
header already forbids that ("no enforcement, nothing minted"). The human
remains the only verdict.

## Decision 4 — risk follows omission over redaction

The producer side is already sound: `vault_stage_action` gates on `canWrite`
for the target's collection *before* the not-found branch, so a read-only
role can neither queue proposals nor probe document existence. The consumer
side has a real gap this spec must close, because risk-ordering promotes the
queue listing into a primary surface: **`runLint` passes the staged-actions
list through unfiltered** — `pendingLintItems` is computed from the raw log
with no `pathVisible` applied (src/curation/lint.ts), unlike every lint
finding — so today `vault_lint` names target paths of pending actions in
collections the caller cannot read. That violates the house rule (doc lists
never name docs in unreadable collections; see the 2026-07-14
existence-disclosure spec) and it predates this design; risk triage is the
reason to fix it now rather than later.

- **The queue listing filters to the caller's vantage.** Items whose target
  the caller cannot read are omitted, and the remainder is reported
  coarsened through the existing `bucketHiddenDownstream` (none/some/many)
  — never an exact count, because a small cell attached to a readable
  neighborhood discloses linked existence with certainty.
- **Risk scores are computed per vantage.** The blast term B uses the
  caller-visible downstream set, bumped one coarse notch when the hidden
  remainder buckets to some/many — the same visible-set-plus-coarse-bucket
  shape the tier-0 ratify gates already use. An exact-graph score shown to a
  partial-vantage caller is a side channel: subtract the visible terms and
  the residue *is* the hidden inbound count. The operator (no access
  context) sees full-graph scores. Consequence, accepted: two reviewers may
  see different orderings — correct, since each ratifies from their own
  vantage and the verdict lands globally.
- **The witness term stays counts-only and pre-scoped.** `buildWitness`
  already filters actions and tensions to readable collections under an
  access context; the W term reads that output and carries no paths.
- **Vault-global aggregates stay unfiltered by design.** `reviewThroughputSummary`
  and `tensionHealth` remain whole-vault counts with no paths or principals,
  per the 2026-07-14 spec's decision C. Nothing here changes that.

## Out of scope

- **LLM-assessed risk.** Every term above is arithmetic over data the logs
  already hold. An LLM scorer would make triage non-deterministic,
  non-replayable, and contestable in exactly the way a queue ordering must
  not be.
- **Auto-approval tiers.** Attaching thresholds to the score — auto-apply
  below, auto-reject above — belongs to the shadow-mode graduation story
  (§11.5 and the Stage 4 coverage/equity ratchets), which has its own gates
  and its own spec when the calibration data earns it. This spec
  deliberately ships the score with nothing wired to it but a sort.
- **Throttling or gating proposers.** The witness feedback loop reorders; it
  never rate-limits a principal or blocks staging.
- **Reviewer assignment / routing to specific humans.** One queue, ranked;
  who reads it is a deployment question, not a vault one.

## Kill condition

Three, one per load-bearing bet, checkable in the system's own numbers:

- **The score must predict corrections.** After a real body of decisions
  (~100), partition decided actions by risk quartile at decision time. If
  the reject + edit-then-approve rate in the top quartile is
  indistinguishable from the bottom, the score is decorative — reviewers'
  judgment and the arithmetic disagree, and the arithmetic loses. Kill the
  score, keep the outcome logging (Decision 3 stands on its own).
  **Amendment (Mihir, 2026-07-27):** "risk quartile at decision time" is read
  from each decision record's `risk_at_decision` snapshot (the Decision 1
  carve-out above), not approximated from present-state B/T — this condition
  is now fully evaluable, not merely approximately so.
- **Batch must not become the rubber stamp with better lighting.** If batch
  approvals come to dominate decisions with a near-zero in-batch reject
  rate while the arrival rate keeps climbing, enumerated-list batching
  failed at its one job — preserving deliberateness — and it goes.
- **The instrument stays the judge.** This whole spec exists to defend the
  advisory wager, so its success metric is `reviewThroughputSummary`'s: expiries
  trending toward zero and `oldestPendingDays` bounded. If expiries keep
  climbing under risk triage, ordering was never the bottleneck — review
  capacity was — and the honest fix is upstream in the proposal budget, not
  another pass over this queue.
