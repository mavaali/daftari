# Distill: Claude Code session-log adapter + confidence-gated auto-ratify — Design

**Date:** 2026-08-14 · **Status:** design (pending spec review)
**One-liner:** Let `daftari distill` ingest Claude Code / bot session JSONL logs, and add a confidence gate so human-sourced or well-corroborated claims auto-ratify while assistant-inferred novel claims queue for human review.

## Motivation

The compile-on-ingest pipeline (`daftari distill`, PR #377) can extract vault claims from a source, but its only `SourceAdapter` is chat-transcript `.txt`. Mavaali's nightly "sleep" job hand-rolls memory consolidation — an LLM freehand-writing the vault — which is exactly the ungated auto-memory pattern we want to retire. This feature makes the sleep job pipe session logs through the staged, auditable distill pipeline instead, with a hybrid gate: the safe majority lands automatically; only the genuinely risky sliver (an assistant-invented claim with nothing backing it) waits for a human.

## Requirements

- **R1** A `claude-session` `SourceAdapter` parses session JSONL into `NormalizedMessage[]`, chronological, pure (no I/O), never throws (malformed line → skip), empty input → `[]`.
- **R2** The adapter keeps only `type:"user"` and `type:"assistant"` records; it drops bot/system event types (`progress`, `queue-operation`, `last-prompt`, `pr-link`, and any unknown `type`).
- **R3** Message text is extracted from `.message.content`: a string is used verbatim; an array concatenates its `text` blocks in order and **omits `tool_use`, `tool_result`, and `thinking` blocks** (thinking is model scratchpad, not human-facing prose — dropping it keeps assistant turns to the content the corroboration gate reasons over). Any block type without a `text` field is dropped. A record whose resulting text is empty (e.g. a tool-only or thinking-only assistant turn) is skipped.
- **R4** `sender` is `"user"` or `"assistant"` (from `.message.role`/`.type`); `ts` is `.timestamp` normalized to `YYYY-MM-DDTHH:MM:SS`. Session timestamps are UTC with millis (`2026-07-31T03:47:39.817Z`); v1 truncates to whole seconds and does not preserve the zone — records are already chronological in-file, so ordering is unaffected. `type` is `"text"`; `attachment` is `null` (image/file blocks are dropped in v1, R14).
- **R5** Adapter selection: a new `--source-type <chat-transcript|claude-session>` flag chooses the adapter; when absent, auto-detect by extension (`.jsonl` → `claude-session`, else `chat-transcript`). The adapter is registered in `ADAPTER_REGISTRY`.
- **R6** A `--sender <user|assistant>` flag filters normalized messages to that sender before chunking. Absent → all senders (unchanged behavior). This is the provenance mechanism: a single-sender pass yields claims of known provenance.
- **R7** The overlap-hinter's `OverlapSearchFn` (`propose.ts`, today `Promise<string[]>`, discards the score) is extended to also surface the **top neighbor's fused search score** (already min-normalized to `[0,1]` in `hybrid.ts`). The propose step stamps it onto the staged proposal as **`proposedDiff.corroboration: number`** in `[0,1]`, default `0` when no neighbor / search error. `proposedDiff` is the established carrier `--review` already reads back (via `parseDistillRef` on `proposedDiff.frontmatter.sources[0]`), so propose-side stamp and review-side read share one contract: the exact key is `proposedDiff.corroboration`.
- **R8** A `--auto-safe` modifier on `distill --review <run>` ratifies only staged claims whose stamped `proposedDiff.corroboration ≥ --corroboration-threshold <T>` (default from R12), leaving the rest queued. Without `--auto-safe`, `--review` behaves as today (`--yes` ratifies all; dry-run default).
- **R9** End-to-end sleep-job flow, per selected session: (1) `distill <s> --sender user --source-id <s>-user --propose`; (2) `distill <s> --sender assistant --source-id <s>-assistant --propose`; (3) `distill --review <user-run> --yes`; (4) `distill --review <asst-run> --auto-safe --corroboration-threshold T`; (5) DM Mihir the auto-ratified / queued counts + the review command for the remainder.
- **R10** Session selection for the nightly pass: today's interactive `*.jsonl` under the `-workspace` project dir, **excluding** scheduled-job sessions (sleep/judge/reflect/search-index) — those carry no new human knowledge.
- **R11** Idempotency is inherited: re-distilling a grown session re-stages only new chunks via `content_hash` + claim-key upsert (U5). The two source-ids (`-user` / `-assistant`) keep the passes independent.
- **R12** `--corroboration-threshold` defaults conservative (high bar → queue more, auto-ratify less); the exact value is tuned empirically after the first live runs. Configurable via flag and `distill:` config.

## Non-goals (deferred)

- **R13** No per-claim, multi-source provenance inside `extract.ts` (Approach 2 rejected — provenance comes from sender-partitioned passes, not claim schema surgery).
- **R14** No image/attachment ingestion (dropped in v1).
- **R15** No auto-clearing of the human review queue — the queued remainder is Mihir's to ratify.

## Architecture & reuse map

| Piece | New / reuse | Notes |
|---|---|---|
| `src/distill/adapters/claude-session.ts` | new | `ClaudeSessionAdapter implements SourceAdapter` |
| `ADAPTER_REGISTRY` + `--source-type` / auto-detect | extend `distill/cli.ts` | registry already exists (hardcoded to chat-transcript today) |
| `--sender` filter | extend `distill/cli.ts` | filter `NormalizedMessage[]` post-parse, pre-chunk |
| overlap-hinter score return | extend U8 `makeOverlapHinter` | already runs `vaultSearch`; expose top score |
| `corroboration` on staged action | extend `distill/propose.ts` | stamp metadata at emit |
| `--auto-safe` / `--corroboration-threshold` | extend `distill/cli.ts` review path | reads stamped `corroboration` |
| sleep-job wiring | `~/scripts/mavaali-sleep.sh` | replaces hand-rolled extraction (interim note already in place) |

## Data flow

```
session.jsonl
  ├─(--sender user)──→ parse → filter(user) → chunk → extract → propose  ──→ ratify --yes            → vault
  └─(--sender assistant)→ parse → filter(assistant) → chunk → extract → propose(+corroboration)
                                                              └→ review --auto-safe --threshold T
                                                                    ├ corroboration ≥ T → ratify      → vault
                                                                    └ corroboration < T → stays queued → Mihir
```

## Testing

- **Adapter units:** string content; array content with mixed `text`/`tool_use`/`tool_result`/`thinking` (only `text` survives); tool-only and thinking-only turns (skipped); bot-event types incl. `system` (skipped); malformed/truncated JSON line (skipped, no throw); empty file → `[]`; UTC-millis timestamp normalization to whole seconds; sender mapping.
- **Selection:** `--source-type` explicit; `.jsonl` auto-detect; `.txt` fallback.
- **`--sender` filter:** user-only, assistant-only, absent (all).
- **Corroboration + gate:** hinter returns a score; propose stamps it; `--auto-safe` ratifies ≥ T and queues < T; user-pass `--yes` ratifies all regardless of score.
- **End-to-end:** temp non-git vault (per U9 `makeTempVault`): a small fixture session → run the R9 five-step flow → assert user-pass claims all land, assistant corroborated lands, assistant novel stays queued, teardown clean.

## Open items for Mihir (post-first-run)

- Corroboration threshold `T` — start high, tune from observed precision.
- Whether the queued remainder review should be a Slack one-click batch (future ergonomics, out of scope here).
