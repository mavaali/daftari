# 6mf.4 — Reader provenance as append-only lineage

## Verification pass (all at origin/main 9176ea5; local tree differs only in `src/tools/search.ts`)

| Claim | Verdict | Evidence |
|---|---|---|
| Update-in-place clobbers the reader | **CONFIRMED, with a mechanism correction** | `proposeAllClaims` never reads the doc at `targetPath` — it builds frontmatter fresh with `readers: [newReader]` (propose.ts:390-437). But the landing write is NOT a wholesale replace: vault_ratify dispatches into vaultWrite, whose #113 update merge inherits omitted keys and lets **explicit payload keys win** (write.ts:1096-1114, staged-actions.ts:490-506). The clobber happens because propose *explicitly supplies* `readers`/`reader_*`, which overwrite v1 at merge time. The merge chokepoint already exists — that's the fix seam. |
| Revision panel's model never reaches the belief | **CONFIRMED** | `revisionPanel` writes only `edge_observe`/`edge_contest` + the trace row; `model` lands in `RevisionTraceRow` (revision.ts:359) and nowhere in doc frontmatter. Edge state lives in `.daftari/edges.jsonl` + index.db (edges.ts:10-29) — the panel **never performs a doc write**, so there is no existing seam to piggyback; one must be added. |
| `recordLandedClaim` deletes the old claim_key | Confirmed (state.ts:117-131) — orthogonal to provenance, leave alone. |
| 6mf.1 merge union | Confirmed: dedupe union A-then-B, scalars dropped when >1 (write.ts:2140-2186). |
| 6mf.3 canon projection | Confirmed: `reader_model`+`readers` off `LoadedDoc.raw`, defensively typed (canon/index.ts:50-67, canon/types.ts:18-23). |
| supersede is predecessor-only | Confirmed (write.ts:1955-1981) — successor never touched. |
| The "house pattern" for jsonl | **Half-true, and it flips the storage decision.** `.daftari` jsonl journals are **gitignored** (vault-gitignore.ts:25-26; curation-log is "local audit state, not vault content", provenance.ts:1-6). They survive only via the *optional* `daftari sync` backend (sync.ts:16-19); they do **not** travel with `git clone` — the sovereignty channel. |

## 1. Storage model: **C (hybrid), with a specific division of labor — and no new jsonl file**

**Durable ordered lineage lives ON THE DOC**: `reader_lineage: string[]` in raw frontmatter. Entry format reuses the existing element encoding:

```
"<ISO-8601 ts>|<op>|<encodeReader string>"     op ∈ { ingest, update, revision }
```

(parse = split on the first two pipes; `encodeReader` output already contains pipes and stays opaque, per reader-fingerprint.ts:64-72's "single shared source of truth").

- **`readers[]` is kept, redefined as the materialized SET-projection of the lineage.** Invariant: `readers` = dedupe(reader-part of `reader_lineage`), lint-checkable. The redundancy is justified: `readers[]` is the shipped 6mf.1/6mf.3 contract surface and the cheap "who authored" query; ripping it out re-keys two merged beads for no gain.
- **No `provenance-log.jsonl`.** The jsonl layer already exists (revision-trace = vote-level, curation-log = write events) and stays as the *event-frequency* forensic tier. The moat claim — "which readers shaped this canon belief" — must survive `git clone`; a gitignored journal only survives through an optional backup backend. Daftari's thesis is that the markdown+git tree is canonical; a provenance claim that dies on clone is not owned memory.
- **Why not pure A**: it's A *plus* keeping `readers[]` — dropping the set breaks shipped contracts and makes the hot query a scan.
- **Why not pure B**: clone-loss (above), orphan rows on doc delete, join-required canon, and "the doc no longer tells its own story" — which is exactly Finding 5's complaint.
- **Growth bound (the A-cost answer)**: lineage entries are **unique on (op, reader-string)** — a duplicate append is declined (declining ≠ mutating; append-only holds). Bound = |ops| × |distinct readers|, structurally small. Event *frequency* (nightly panels, repeated re-distills) belongs to the jsonl journals, which already record it.

Null-safety: we never write `null`; an explicit `reader_lineage: null` from a caller deletes the field (the standing escape hatch, evaluated before the union — see op 2).

## 2. Per-op append spec

| Op | Appended | Code seam | Preserves prior? |
|---|---|---|---|
| **Ingest** | `reader_lineage: ["<now>\|ingest\|<encodeReader(run_meta)>"]` alongside existing `readers:[r]` | `buildReaderFrontmatter` + `ReaderFrontmatter` (propose.ts:205-245) | n/a (create) |
| **Update-in-place** (blind spot 1) | new entry `"<now>\|update\|<r2>"`; prior entries + prior `readers` survive | **The #113 merge chokepoint, write.ts:1106-1114** — make it field-aware for exactly `readers` (dedupe union old∪payload) and `reader_lineage` (old entries, then payload entries not already present), then apply the 6mf.1 rule: union >1 ⇒ delete scalar `reader_*` from the merged raw. propose.ts changes only the entry's op: thread `kind:"update"` (it already has `pathOverrides`) so the staged entry says `update` not `ingest`. | **YES — this is the fix.** Union at *land* time, not stage time: the staged payload is frozen and the doc can change between stage and ratify (e.g. a merge lands in between); land-time union operates on the doc as it is. It also fixes every writer path (any agent's `vault_write` to a reader-stamped doc), not just distill, at one chokepoint — answering "every writer must read-append" without any writer reading anything. Idempotent re-land = no-op. Explicit-null delete is evaluated first (write.ts:1109), so the escape hatch survives. |
| **Revision panel** (blind spot 2) | ONE entry on the **from-doc**: `"<now>\|revision\|<opts.model>@na\|prompt=<hash8(SYSTEM_BASE+templates)>\|retry=false"` (new `encodeRevisionReader` helper next to `encodeReader`) | New injected dep `appendReaderLineage(path, entry)` on `RevisionDeps` (revision.ts:33-45), called once per panel **iff a write was actually applied** (`observedCount>0 \|\| contestedCount>0`) — never on `gated`/`tie`/`no-vote`, and the shadow-mode CLI wiring (consolidate/index.ts:98) injects a no-op, since shadow diverts edge writes. The panel stays pure; the CLI wires the real appender (a raw-frontmatter append via the standard write path). A failed append lands in `writeErrors`, never fails the panel. | YES — pure append; the doc body/other frontmatter untouched. `readers[]` also unions in the panel model (the set stays a true projection); scalars drop if that makes >1, per 6mf.1. Trace row unchanged — it remains the vote-level record. |
| **vault_merge** | target lineage = A's entries, then B's entries not already present (exact-string dedupe). **No re-sort by timestamp** (append-only means never reorder a history; entries carry ts, consumers may sort) and **no synthetic "merge" entry** (lineage records readers; the merge event already lives in git + curation-log). Legacy-both-sides ⇒ no key at all (mirror write.ts:2177-2179). | Extend the 6mf.1 fusion block, write.ts:2140-2186 | YES — concatenation of both histories |
| **supersede** | **Nothing.** Successor keeps its own lineage (its own ingest); predecessor's lineage is untouched; the pointer is the existing `superseded_by`. | none — vaultSupersede already writes predecessor-only | YES. Rationale is the keystone: supersession *preserves* the predecessor. Copying its lineage forward would claim the successor was shaped by readers that never touched its text — a false parentage of exactly the kind #427 forbids. Chain queries follow `superseded_by`. |

## 3. Query surface

- **Doc-level, today, zero change**: `vault_read` already returns `raw` (read.ts:128, 543) — `reader_lineage` is immediately visible.
- **Canon (6mf.3 extension)**: add optional `readerLineage?: string[]` to `CanonDoc` (canon/types.ts) and project it in `toCanonDoc` with the same defensive filtering as `readers` (non-string / non-3-part entries dropped, never an error). Answer shape: `readers` = *which* (set), `readerLineage` = *which, when, via what op* (ordered). `readerModel` stays as-is for single-parent docs.
- **Per-vote forensics**: revision-trace.jsonl + `vault_provenance`/curation-log remain the deep tier; not part of the durable claim.

## 4. Constraints audit

- **Append-only** ✓ — ops append or decline duplicates; the only removal is the caller-explicit null escape hatch.
- **Raw-only / no typed-Frontmatter change** ✓ — `reader_lineage` never enters `Frontmatter`; `CanonDoc` is not `Frontmatter` (6mf.3 precedent). **No change to typed `Frontmatter` is forced.**
- **null=delete** ✓ — never written; delete semantics preserved and ordered before the union.
- **Malformed never bricks** ✓ — non-array `reader_lineage` / non-string entries are filtered-as-absent at the chokepoints (same guard style as write.ts:2158-2163); a garbage field on disk yields a fresh lineage, not a failed write.
- **Bounded growth** ✓ — (op, reader) uniqueness; frequency lives in jsonl.
- **Server no-model purity** ✓ — the only model-aware append is wired in the CLI consolidate loop; every server-side change is string-mechanical.
- **Flagged core-seam change (the one to scrutinize in review)**: the #113 merge becomes field-aware for exactly two keys. It's a narrow, deliberate semantic change to a load-bearing generic path — it needs its own tests including the null escape hatch and non-distill writers.

## 5. Migration (pre-lineage #427 docs)

Lazy, at the first lineage-touching chokepoint (update merge / merge fusion / revision appender) — no batch pass:

- `readers[]` present, no `reader_lineage` ⇒ backfill one `"<doc.created>|ingest|<r>"` per `readers` entry, in set order, **then** append the current op. `readers[]` already holds the exact encoded strings, so no reconstruction from scalars; ts = `created` is honest (it is when the belief was born) and documented as day-granular.
- No `readers[]` (legacy/human-authored) ⇒ no fabricated history; lineage starts at the current op.

## 6. Acceptance tests (bead criterion in bold)

1. Ingest ⇒ `reader_lineage=[ingest r1]`, `readers=[r1]`.
2. **Re-distill with edited statement, reader v2≠v1, through stage→ratify ⇒ lineage `[ingest r1, update r2]`, `readers={r1,r2}`, scalars dropped — not just the latest writer.**
3. Same-reader re-update ⇒ dedupe: no duplicate (update, r) entry; idempotent re-land.
4. **Panel `survives` with observes applied ⇒ from-doc gains one `revision` entry with the panel model; `gated`/`tie`/`no-vote`/shadow ⇒ doc unchanged.**
5. Merge A+B ⇒ concatenated deduped lineage, readers union, 6mf.1 scalar rule; legacy-both-sides ⇒ no key.
6. Supersede ⇒ both docs' lineages unchanged.
7. Migration: readers-only doc hit by an update ⇒ backfilled ingest entries precede the update entry; no-readers doc ⇒ lineage starts at update.
8. Malformed `reader_lineage: "garbage"` on disk ⇒ write succeeds, fresh lineage.
9. Canon projects `readerLineage`; absent ⇒ undefined.
10. Non-distill `vault_write` update supplying `readers` ⇒ union (not clobber); explicit `readers: null`/`reader_lineage: null` ⇒ delete.

**Verdict: BUILD-WITH-CHANGES** — ready to plan once two amendments to the bead's implied shape are accepted: the union lands at vaultWrite's #113 merge chokepoint (not in propose), and the panel appends via an injected `RevisionDeps` fn gated on applied-writes-only.
