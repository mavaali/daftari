# Compile-on-Ingest + Retention Hygiene v1 — Requirements Spec

**Readiness: requirements-only**
Date: 2026-08-12 (rev. 2 — distill reframed to hybrid) · Epic: `mavaali-beads-a28`
Descends from (mavaali-vault): `projects/daftari-ingestion-layer-brainstorm.md`, `projects/daftari-retention-erasure-design.md`, `projects/daftari-distill-sync-vs-background-resolution.md`.

## Problem & outcome

Daftari compiles knowledge at write time but ships **no compiler front-end for external streams**. Users who arrive with real-life material as a raw stream (a chat transcript, meeting notes) must hand-build a parse+distill pipeline before their history is usable — a dead first hour that stalls adoption, and a tax the maintainer paid personally (the chat-archive episode). Yet "a compiler with no front-end is incomplete, not principled."

**Outcome:** Daftari owns a compile-on-ingest front door — raw stream in, **proposed graded claims** out (as staged actions awaiting ratification), raw discarded (provenance pointer only) — plus the retention hygiene that makes "distill-and-discard" honest and a minimal git-history scrub for the accidental-sensitive-commit case. Governing principle: **distill proposes, ratify disposes.** Subject-keyed GDPR erasure is fully designed but **deferred** behind a concrete trigger.

## Scope decisions (locked)

- **Posture A** — compile-on-ingest, distill-and-discard. The invariant "ingestion never mints trust" holds; "raw never becomes canon" is permanent.
- **Distill is a HYBRID, not a synchronous write tool:** a batch-shaped engine (`src/distill/`, in the sleep/consolidate family) whose only output is staged proposals, behind two front doors — a **CLI** (primary, real workloads) and a **bounded MCP trigger** (the "distill this now" chat flow). Distill never writes a document directly; it emits `vault_stage_action` payloads, and `vault_ratify` disposes.
- **Daftari runs the distill LLM itself** (sleep/consolidate-style: internal client, call-budget, cost estimate) — not agent-orchestrated. A fixed internal compiler is what makes quality measurable (eval-first), cost cappable, and idempotency deterministic. The agent-driven path (an agent synthesizes and calls `vault_stage_action` itself) already ships free — it is the escape valve, not the product.
- **Retention now = personal hygiene + a minimal scrub.** Full subject-keyed GDPR erasure is **deferred to the third-party-PII trigger** (real deployment today is a dozen-person internal-knowledge work wiki, git-pushed to GitHub/ADO).
- **Erasure primitive = git history rewrite**, not crypto-shredding (rejected structurally: can't pre-encrypt accidental/unplanned data — the dominant work-wiki erasure trigger — and it breaks `asof`/diffs).
- **Enterprise legal-hold / residency / fleet crypto-shred = the separate paid product, out of scope.**

## Requirements

### A. Distiller — compile-on-ingest front door
- **R1** The distiller is a batch engine `src/distill/` (source adapter → chunker → claim-extraction → proposal emitter), in the sleep/consolidate family, with two front doors over one engine: CLI `daftari distill <source> [--plan|--propose]` (primary) and a bounded, capped MCP trigger (`vault_distill { content|path, source_id?, max_claims? }`) for the "distill now" flow (oversize input errors → "use the CLI"). The engine never writes a document directly.
- **R2** Daftari runs the synthesis LLM internally, reusing the sleep/consolidate stack: `createAnthropicClient`/`createOpenRouterClient` via `resolveTransport`, `withCallBudget`, `estimateCostUSD`, config-defaulted model.
- **R3** Distill's only output is `vault_stage_action("write", …)` proposals at `status: draft` / `confidence: low` / `provenance: synthesized` (the langgraph-import landing convention), each stamped `proposed_by: "agent:distill"` + `run_id`. The human gate is the existing `vault_ratify` (TTL, tier-0 gate, conflict-check, run_id→provenance all reused). No new gate or review schema. Net-new: a **batch-ratify-by-`run_id`** convenience (approving N claims one-by-one is the real UX tax).
- **R4** Claim-level idempotency (prevent, don't detect): every distilled claim carries `sources: ["distill:<source-id>#<claim-key>"]` (`<claim-key>` = stable chunk-anchor + claim-slug, not an ordinal), backed by `.daftari/distill-state.json` (per source-id: content hash + claim-key→landed-path map, marked processed only after the proposal lands — the consolidate `birthProcessed` pattern). Re-distill: unchanged hash ⇒ free no-op; changed ⇒ join new claims on claim-key — match-unchanged skip, match-changed stage an update-in-place / supersede, no-match stage a new write. Re-distill never mints near-duplicate siblings.
- **R5** Distill does NOT run tension detection. Landed (ratified) claims are auto-picked-up by the next `sleep` tension-scan (never-scanned-first ordering). Distill attaches only a **free** overlap hint per proposal — a `vaultSearchRelated` neighbor lookup (no LLM) surfaced as "possible overlaps" in the proposal rationale for the ratifier.
- **R6** Cost governance: mandatory free `--plan` pre-flight (chunk count, est. LLM calls, est. cost — no spend) before any default spend path; `withCallBudget` hard caps (`--max-llm-calls`, `--max-claims`, MCP in-call input cap); a `distill:` block in `.daftari/config.yaml` (model, caps) is required — a vault whose config lacks it gets a refuse-to-run error (the shadow_mode posture). Record `provider` + zero-data-retention flag per run.
- **R7** First source adapter = **chat transcript** — productize an existing chat-export parser prototype (iOS/Android export format). The adapter interface is pluggable for later sources.

### B. Distill-and-discard hardening
- **R8** Raw never written under `vaultRoot`, even transiently — distill buffers raw in tmp outside the vault; a fence check refuses distill output under a `raw/` prefix or a `tier: source` landing (that adoption path stays reserved for `daftari import` of content the user already owns in git).
- **R9** Verbatim-quote budget: paraphrase by default; quotes capped (`distill.max_verbatim_chars`) and always attributed to a `sources[]` pointer. Advisory lint `verbatim_quote_overrun`.
- **R10** Honesty: `PRIVACY.md` states distill-and-discard bounds *Daftari's* retention, not the synthesis provider's (raw transits the provider); the distill receipt records `provider` + ZDR status. The provenance pointer (`distill:<source-id>#<claim-key>`) is an **audit breadcrumb, not a re-derivation source** — dangling is acceptable; re-derivation always means the user re-presenting the source to a fresh run.

### C. Minimal scrub — accidental sensitive commits
- **R11** `vault_erase` **minimal form (source/path-keyed only)**: scrub a path/blob from worktree + git history via `filter-repo` + `reflog expire` + `gc` (git_dir-aware, separate-git-dir safe). No subject tags, no cascade, no mention-scan. **`filter-repo` is a required dependency for the history operation** — if absent, `vault_erase` REFUSES the history scrub and returns `incomplete:["git-history: filter-repo not installed"]` rather than silently doing a worthless worktree-only pass. (Fixes the rev-1 "graceful degrade" contradiction: worktree-only is a no-op for the feature's purpose.)
- **R12** Erasure extends to a configured **git remote**: force-push rewritten refs. GitHub/ADO cannot self-serve `gc` of unreachable objects → name the remote in an `incomplete[]` receipt (append-only, gitignored, content-free `.daftari/erasures.jsonl`). Incomplete erasure is always loud, never silent.
- **R13** For secrets, guidance + receipt state that **rotation is the primary fix**; history purge is secondary. `vault_erase` is RBAC-gated (`erase` capability) and confirmation-gated (echo the path).
- **R14** Documented **coordinated multi-clone rewrite protocol** (docs, not code): force-push → all clones re-clone/reset → request remote purge → rotate any exposed secret.

### D. Future-proofing hook
- **R15** Reserve `subjects: string[]` as a **built-in, optional** frontmatter field (default `[]`, schema-validated). NOT populated by the distiller and NO cascade yet — reserved so future subject-keyed erasure is a feature-add, not a format migration.

### E. Eval gate (measure before ship)
- **R16** The distill compile path is wired into recall-bench's compiler-arm (`src/eval/tool-surface.ts` / `ingestDay`), so distiller quality is **measured on the benchmark before first-user exposure**. Because Daftari owns the compiler internally (R2), the compiler under test is fixed and reproducible. A bad distiller as first-touch is the one Posture-A failure that can't be walked back (eval-first).

## Recommended v1 cut (fork leans)

- **F1 — CLI + eval-arm first; defer the MCP trigger.** The bounded MCP `vault_distill` would be Daftari's first *spending* MCP tool (a precedent). v1 ships the CLI front door + the eval-arm wiring; add the MCP trigger once the compiler measures well. Cheap to defer, expensive to recall.
- **F2 — batch-ratify via CLI `daftari distill --review <run_id>` first**, rather than growing `vault_ratify` a `run_id` mode (keeps the MCP ratify tool single-action and auditable).
- **F3 — re-distill upsert = `write`-to-same-path for same-claim-key revisions; `supersede` only when the claim's meaning flips.** One-line policy in the engine.

## NOT in scope (deferred)

- **Full subject-keyed GDPR erasure subsystem** — distiller populates `subjects[]` → mention-scan cascade → redact/tombstone multi-subject docs → coordinated rewrite. **Trigger: the wiki begins holding third-party PII.** Design complete in `daftari-retention-erasure-design.md`; carry forward when triggered. *Rationale: internal-knowledge data holds no erasable third-party personal data; building the cascade now specs a subsystem that won't fire.*
- **Policy auto-accept of proposals** (vs human-ratifies-each) — a ratifier-side change, deferred cleanly; v1 is human-ratifies.
- **Enterprise legal-hold / data-residency / fleet crypto-shred** → the separate paid product. *Rationale: the OSS→paid line; these need per-tenant KMS + holds.*
- **Additional source adapters** (mailbox, meeting notes) → after the chat-transcript adapter proves out.
- **Quarantine `raw/` tier inside the vault** → rejected. *Rationale: multiplies every erasure surface; distill-and-discard chosen and hardened into the format.*

## What already exists (reuse map)

- **Human gate — wholesale:** `vault_stage_action` / `vault_ratify` (queue, TTL, tier-0 gate, `stageActionWithConflictCheck`, run_id→provenance, form elicitation) — `src/tools/staged-actions.ts`, `src/curation/staged-actions.ts`.
- **LLM stack:** `createAnthropicClient`/`createOpenRouterClient`, `resolveTransport`, `withCallBudget`, `estimateCostUSD`/`isModelPriced`, config model defaults — `src/sleep/`, `src/consolidate/`, `src/eval/llm.ts`.
- **Idempotency pattern:** consolidate `birthProcessed` content-hash state — `src/consolidate/birth.ts`.
- **Tension pickup (no distill code):** sleep tension-scan never-scanned-first — `src/sleep/`, `src/curation/tension.ts`.
- **Overlap hints (no LLM):** `vault_search_related`.
- **Preview convention:** langgraph-store `--plan`/`--apply` two-step + draft/low landing — `src/import/langgraph-store.ts`.
- **Fence check:** `src/fence/detect.ts` (R8).
- **Write path / git:** `performWrite`, `commit`/`ensureGitRepo`, `auto_commit:false` — `src/tools/write.ts`, `src/utils/git.ts`.
- **RBAC:** `resolveAccess` — extend with `erase` capability — `src/access/rbac.ts`.
- **Advisory lint sub-check pattern:** `positionIntegrity`/`malformed_pin` → `verbatim_quote_overrun` — `src/curation/lint.ts`.
- **Eval harness shape:** `src/eval/tool-surface.ts` (R16).
- **Chat parse+distill prototype:** an existing chat-export parser prototype, external to this repo (R7).
- **Net-new:** `src/distill/` engine (adapters, chunker, extraction prompts, proposal emitter); `distill:` config block; `.daftari/distill-state.json` + claim-key scheme; batch-ratify-by-run_id; `filter-repo` dependency (R11).

## Open questions (carry into planning)

- Cost-cap defaults + which ZDR-capable provider for synthesis (Anthropic vs OpenRouter transport default).
- `<claim-key>` construction: chunk-anchor + claim-slug — how stable across re-chunking when the source grows (append-only transcript vs edited doc)?
- Does R11's worktree part reuse `vault_deprecate` semantics, or is it a clean path-scrub only?
- Chunker strategy for the chat-transcript adapter (turn-window vs semantic).

## Sequencing

Ship A + B + C + D + E as one epic, in eval-first order: `src/distill/` engine + chat adapter + `distill:` config → wire into the recall-bench compiler-arm (R16) and measure → CLI `--plan`/`--propose` + staged-action output + idempotency state → batch-ratify `--review` → the retention items (B) and minimal scrub (C) → reserve `subjects[]` (D). The MCP trigger (F1) and the full erasure subsystem follow their respective gates.
