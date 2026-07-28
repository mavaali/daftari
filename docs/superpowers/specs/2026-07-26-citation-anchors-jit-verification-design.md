# Citation anchors and just-in-time verification — design

2026-07-26. Status: **implemented (2026-07-28)**, after Jugalbandi dialectical
review. The final plan resolved ten challenges and escalated one — C4, "no new
disclosure surface" — to Mihir (see `.jugalbandi/citation-anchors-jit/final-
plan.md`). Mihir's 2026-07-27 decision: gate the `anchors` annotation per
role/collection from day one, not as a future step (see the amended Decision
2 disclosure paragraph and the new "role gate" note below). The amendments in
this text (the read-path batching in Decision 2, the symlink-confinement and
CRLF/trivial-content hardening in Decision 2's classifier steps, the
disclosure-posture correction below, and the kill-condition amendment) are
the disposition of that review, applied in place because the spec was still
pre-implementation when the review landed — not a silent deviation from what
shipped. `daftari audit --pin`/`--pin --apply`, `vault_lint`'s malformedPins
check and Decision-4 softening, and the `code_repo_visibility` role grant
described below are all implemented.
Predecessor specs: 2026-05-30 (coherence audit — the surface this extends),
2026-06-09 (backfill — the plan/apply precedent Decision 5 reuses),
2026-07-20 (self-hosted server mode — the config posture).

## Why

`describes` already exists: a frontmatter string array of doc-to-code
bindings, each `repo:path` or `repo:path::symbol`
(src/frontmatter/types.ts, parsed in src/audit/describes.ts). And `daftari
audit` already checks it — `--code-repo` joins code repos as path-indexed
reference targets, missing targets trip `fail_on.broken_describes`, the
opt-in `--semantic` pass asks an LLM whether the doc still describes the
code, and `--auto-tension` logs drift as tensions.

But all of that is a **batch sweep the operator has to run**. Between
audits, the binding is inert. An agent that `vault_read`s a doc mid-task —
the exact moment the doc's claims are about to steer an action — gets every
advisory surface the read path has grown (decay, upstream_staleness,
structural, contested) *except* the one pointing at code. The doc says the
retry loop lives at `api:src/retry.ts` lines 40–58; the code was rewritten
three weeks ago; nothing in the read result says so.

The evidence that retrieval-time re-checking is the right defense is now
public. GitHub Copilot's agentic memory (public preview, 2026-01-15) stores
a code-location citation with every memorized fact and **re-validates the
citation against the current codebase at retrieval time** before the agent
acts on it — measured PR merge rate 90% with memories versus 83% without:
the best-evidenced staleness defense in production, and its mechanism is
exactly a pin plus a just-in-time check, not a smarter batch audit. Atlan's
2026 "context freshness" work makes the same move from the metadata side:
lineage gaps and ownership freshness are first-class drift signals, checked
when context is served, not on a curation calendar.

Daftari has all the parts: a binding grammar, git plumbing
(src/utils/git.ts), and a read path whose whole idiom is cheap advisory
annotation that collapses to silence. This spec connects them: pins on
`describes`, verified at read time, advisory always.

## Decision 1 — grammar: an optional pin suffix on `describes` bindings

A binding may carry a **pin**: a line range plus a git blob id recording
what the author looked at when the binding was written.

```
<entry>   := <binding> [<pin>]
<binding> := [<repo> ":"] <path> ["::" <symbol>]      (v1 grammar, unchanged)
<pin>     := ["#L" <start> ["-" <end>]] "@" <sha>
<start>, <end> := positive integers, <end> >= <start>; a bare "#L40"
                  means the single line 40
<sha>     := 7–40 lowercase hex chars — a git BLOB id prefix
```

Examples, all valid:

```yaml
describes:
  - api:src/retry.ts                          # bare binding — unchanged
  - api:src/retry.ts@9f3c2ab                  # whole-file pin
  - api:src/retry.ts#L40-58@9f3c2ab           # range pin
  - api:src/retry.ts::withRetry#L40-58@9f3c2ab
```

**Parsing** strips the pin first — the anchored pattern
`(?:#L\d+(?:-\d+)?)?@[0-9a-f]{7,40}$` at end-of-entry — then hands the
remainder to the existing parser untouched (`::` split first, then the
single `:` marking the repo prefix). This is backward compatible by
construction: bare and `::symbol` forms parse byte-identically to today,
and an entry that doesn't match the pin pattern *is* a bare binding. A path
that legitimately contains `@` or `#` mid-string is unaffected (the pattern
is end-anchored and sha-strict); a path that itself *ends* in text matching
the pin pattern is pathological and accepted as a known ambiguity — the pin
wins.

**What the sha means:** the git blob id of the target file as the author
saw it (`git hash-object <file>`, or the blob listed by
`git ls-tree HEAD <path>`). It SHOULD be a committed blob — `daftari audit
--pin` (Decision 5) always pins HEAD's blob — because a committed blob
stays retrievable from the object database, which is what makes the `moved`
classification precise. A pin over dirty uncommitted content still works,
just degraded (Decision 2, step 4).

**Schema stays untouched.** `describes` remains `optionalStringArray`
(src/frontmatter/schema.ts) — no new field, no write-time grammar
validation, matching today's posture where even the base `repo:path`
grammar is checked by the audit, not the write path. A malformed pin suffix degrades to a bare
binding and surfaces as an advisory `malformed_pin` lint finding — never a
rejected write.

## Decision 2 — the read path checks pins: git plumbing only, silence on failure

When `vault_read` returns a doc that has pinned bindings, AND the binding's
repo prefix resolves to a locally present code repo, daftari compares each
pin against the current working tree and attaches a structured `anchors`
annotation to the read result.

**Read only, not search.** Search was considered and rejected: a search
returns many hits, each potentially carrying several pins, so the cost
multiplies at the most latency-sensitive moment — for candidates the agent
will mostly discard. `vault_read` is where an agent commits to acting on a
doc's content; that is the retrieval moment the Copilot evidence is about,
and annotating snippets would invite acting on docs never actually read.
Revisit only if agents demonstrably act on snippets alone.

**Repo resolution.** The audit declares repos per invocation (`--code-repo`
flags or audit.yaml `repos:` with `type: code`); the read path needs a
declaration that travels with the vault, so `.daftari/config.yaml` gains:

```yaml
code_repos:
  api: ../code/api        # name → path; ~ expanded, relative to vault root
jit_anchors: true         # default true; false disables the check entirely
```

Names resolve the `repo:` prefix with the audit's exact-name semantics.
Only prefixed bindings are JIT-checked — a bare binding resolves to "the
doc's own repo" in the audit, which on the read path is the vault itself,
not a code repo. Shape is validated fail-loud at config load like every
block; path *existence* is deliberately NOT checked at load — a departure
from the audit's `validateRepoPath`. An audit invocation names a repo
explicitly and should fail loud when it's absent, but config.yaml travels
with a synced vault onto machines where the code repo simply isn't checked
out (the stdio single-user reality). There, the check **silently degrades
to absent** — `anchors: null`, indistinguishable from a doc with no pins.
This is advisory read-path enrichment, not a permission system; the
fail-loud rule guards the latter.

**Classification** — per pinned binding, all git plumbing via the
src/utils/git.ts execFile pattern (`git -C <repo>`, no shell), no LLM, no
network:

1. Target path absent from the working tree → **`missing`**.
2. `git -C <repo> hash-object -- <path>` → current blob id. Pin sha is a
   prefix of it → **`intact`** (blob unchanged; every line unchanged).
3. Blob differs and the pin has a range: `git cat-file blob <pin-sha>`
   retrieves the pinned content (present in the odb for any once-committed
   blob), slice lines `<start>..<end>`, and search the current file for
   that exact text — the guarded read posture from src/audit/readtext.ts
   (size cap, binary sniff, strict UTF-8). Found → **`intact`**, annotated
   with the relocated line numbers. Not found → **`moved`**.
4. Otherwise (whole-file pin with a differing blob, or a pinned blob git
   no longer has) → **`moved`**.

**Cheap by construction — amended (2026-07-27 plan resolution, C1).** The
original claim — "at most two git invocations per pin" — blows its own 50ms
kill threshold on the hot path: 24 sequential `execFile` spawns land at or
over budget at even ~3-5ms each, and the CI tripwire (originally 500ms) was
10x too loose to catch it. The implemented design batches instead: existence
(step 1) is a realpath/stat check, no subprocess; step 2 (current blob hash)
is ONE `git hash-object` invocation per REPO REFERENCED, not per pin, via
`hashObjects` in `src/utils/git.ts` — so the all-intact case, the common
one, costs one subprocess per referenced repo per read. Only pins whose blob
differs AND carry a range proceed to step 3 (`git cat-file -s` + a bounded
`cat-file blob`), run with a small bounded concurrency (4) so several
drifted range pins on one doc don't serialize behind each other. The
"at most two invocations per pin" claim now holds on the hot (intact) path
and is knowingly exceeded by one `cat-file -s` size gate on the cold
(drift) path. Pins per read are still capped at a fixed constant (24
— `MAX_PINS_PER_READ`), the remainder reported as skipped with a count. Any
classifier failure (a repo's whole batch call erroring) degrades that
repo's pending entries to `errored` (C8) rather than silently vanishing,
and the read never fails on the check (the recordRead best-effort
contract). The CI tripwire tightened to 24 intact pins across 2 repos
classifying under 150ms; the live 50ms p95 measurement on a real vault
remains the authoritative post-ship check. The operator still holds a
kill-switch: `jit_anchors: false` removes the entire code path.

**Annotation shape**, following the read path's null-when-silent contract
(`decay`, `upstream_staleness`, `structural`):

```ts
anchors: {
  entries: Array<{
    raw: string;                        // the describes entry as written
    repo: string; path: string; symbol: string | null;
    pin: { start: number | null; end: number | null; sha: string };
    state: "intact" | "moved" | "missing";
    relocated?: { start: number; end: number };  // intact via step 3
  }>;
  checked: number;
  skipped: number;                      // over-cap remainder
  errored: number;                      // classifier failures, dropped from
                                         // entries (2026-07-27 resolution, C8:
                                         // keeps the Decision 4 softening from
                                         // quantifying over a censored sample)
  banner: string | null;                // the decay-banner idiom
} | null    // no pinned bindings, no resolvable repo, jit_anchors: false, OR
            // (2026-07-27 resolution) the caller's role lacks
            // code_repo_visibility — see the disclosure-posture note below
```

**Disclosure posture — corrected.** The original text here claimed "no new
disclosure surface": the annotation names no other vault document, so the
2026-07-14 omission/existence-disclosure rules gain no new edge. That claim
is true as far as it goes but incomplete, and the Jugalbandi Challenger
(C4) caught it: the annotation is a per-read oracle over a repo that RBAC's
collection model has no vocabulary for at all. Any principal who can read a
pinned doc can, via writer-controlled pins, learn path existence in a
configured `code_repos` tree, whether a specific blob still matches the
current file, and (via step 3) where matching content now lives — facts
about a *filesystem outside the vault*, not about another vault document.
The 2026-07-14 rules were written for vault-internal edges; they say
nothing about this because this oracle didn't exist yet.

Mihir's 2026-07-27 decision: gate it, from day one, not as a follow-up.
`.daftari/config.yaml` gains a per-role `code_repo_visibility` grant
(default **off** for every non-operator role). The `anchors` field on
`vault_read`'s result is null unless BOTH hold: the caller's role can
already read the pinned doc (the existing collection-scoped `read` grant),
AND the role carries `code_repo_visibility`. The underlying git
classification still runs regardless of the gate — kill-condition (b)
instrumentation (`anchors_moved`/`anchors_missing`/`anchors_errored` on the
read log) is local operator telemetry, unfiltered by role, the same posture
`broken_upstream` already takes — but the RETURNED annotation, and the
Decision 4 decay-banner softening derived from it, are both gated. A caller
with no `AccessContext` at all (stdio without `--role`, or any direct
in-process call) is unaffected by the gate, matching every other RBAC check
in this codebase. Configuring `code_repos` at all is therefore an explicit
operator choice with a stated cost: it makes blob-level facts about that
repo visible to every reader the operator has granted `code_repo_visibility`
— see `docs/architecture.md`'s "Citation anchors" section for the
operator-facing statement of this posture. In serve mode the annotation is
identical across sessions for the same role by construction (deterministic
git state at query time), so no session-to-session leak exists beyond the
role gate itself.

## Decision 3 — advisory consequences only; the batch audit gains the same classifier

A `moved` or `missing` pin **never** auto-invalidates, demotes, filters, or
rewrites the doc. The agent sees the flag and decides — the curation house
rule (`vault_lint` reports, it does not fix) applied to code drift. What
the flag is *for*: an agent told `moved` should re-read the code before
trusting the doc's account of it, exactly as Copilot's agents re-verify
citations before acting.

`daftari audit` remains the batch path and gains the identical pin
classifier: per-binding pin state in the report, `pins_intact` /
`pins_moved` / `pins_missing` totals. No new `fail_on` gate — a `missing`
pin's path is already a `broken_describes` finding, and `moved` is a
prompt, not a breakage. The classifier instead sharpens the expensive
pass: under the `--max-semantic` cap, **moved-pin bindings are ordered
first** — the bindings where drift is mechanically possible get the LLM
budget before bindings whose code hasn't changed since the author looked.

Tensions follow the existing `--auto-tension` precedent, narrowly: a
semantic `drifted`/`contradicted` verdict flows into `--auto-tension`
exactly as today, and a `missing` pin target may additionally be logged
without an LLM (disappearance is not a judgment call). A bare `moved` never
auto-logs a tension — "the code changed" is not yet "the doc disagrees with
the code", and tensions record established disagreement, not suspicion.

## Decision 4 — an intact pin is evidence of freshness; annotate, never extend

The inverse signal is as useful as the drift signal: a doc past its
`ttl_days` whose pins are **all intact** is stale by the clock but
verifiably current about the code it describes. Lint and the read path's
decay banner soften their copy for that case — appended, not replaced:
"past TTL, but its N code pins are intact — the code it describes has not
changed since the pins were written."

Should intact pins *extend* decay — refresh `updated`, stretch the TTL,
move the doc back to `fresh` in the vault_status distribution? Argued and
rejected; pins are **annotate-only**:

- The curation engine is advisory (house rule). A pin that silently reset
  a decay clock would be the first curation signal that mutates state.
- A pin covers only the described code. The doc's other claims — prices,
  decisions, the surrounding context — age on their own schedule, and one
  untouched source file must not launder whole-doc rot into freshness.
- The Copilot evidence is about *re-checking at retrieval*; the value was
  the signal at the point of use, not clock manipulation in storage.

Decay scores, buckets, and `vault_status`'s distribution are byte-identical
with and without pins. If the softened copy proves insufficient — operators
demonstrably ignoring stale flags on all-intact docs, or the reverse — an
explicit opt-in is the future shape, not a changed default.

## Decision 5 — writing pins: normal frontmatter writes, plus `daftari audit --pin`

Agents and humans write pins the way they write any frontmatter: a
`vault_write` whose `describes` entries carry the suffix. No new tool, no
write-path validation (Decision 1), lock/commit/provenance unchanged.

For adoption over an existing vault, `daftari audit --pin` backfills:
for every resolvable binding that lacks a pin, it proposes appending
`@<sha>` — the target's blob id at the code repo's HEAD. **Whole-file pins
only**: a line range is an author's claim about *which* lines matter, and
a batch tool never invents that judgment. The flow is the backfill
precedent exactly — plan by default (print proposed frontmatter edits,
write nothing), `--pin --apply` to edit and commit as
`agent:daftari-audit`, requiring exactly one docs repo like
`--auto-tension` does. This knowingly crosses the 2026-05-30 spec's "not a
fixer" line the same way `--auto-tension` already did: opt-in twice,
writing only mechanically derivable metadata, never touching a doc body.

## Out of scope

- **Cross-repo network fetches.** Pins verify against local working trees
  only — no cloning, no forge APIs. A repo that isn't on disk is absent,
  not fetched.
- **LLM semantic drift on the read path.** The read-time check is git
  plumbing by design; doc-vs-code judgment stays in batch `--semantic`.
- **Symbol resolution.** `::symbol` remains carried-but-unresolved
  (audit v1 posture); a pin's range is the precision instrument.
- **Pin auto-repair.** No pass that rewrites `moved` pins to the current
  blob — that would overwrite the record of what the author verified with
  a claim nobody verified. Refreshing a pin is an authoring act.
- **Annotating search hits or vault_index entries** (argued in
  Decision 2; revisit on evidence).

## Kill condition

[HYPOTHESIS] Pins earn their grammar only if they get written and their
flags get acted on. This design is falsified and the read-path check
reverts to batch-only if, after a quarter of availability on a live vault
with `code_repos` configured: (a) fewer than ~10% of `describes` entries
carry pins despite `--pin` being available — the authoring moment doesn't
exist; or (b) joining the read log with subsequent writes (the #233/#234
instrumentation) shows `moved`/`missing` annotations are never followed —
within the same run — by a code re-read, a doc update, a pin refresh, or a
tension: signal without consequence, cost without product. The grammar
itself may stay in either case (inert suffixes are harmless and the batch
audit still uses them). Independently and faster: the "cheap by
construction" claim dies if the check adds more than ~50ms p95 to
`vault_read` on a real vault even under the pin cap — then the default
flips to `jit_anchors: false` pending a redesign, because an advisory
annotation that taxes every read has inverted its own justification. And
Decision 4's softened copy dies on its own if reviewers judge
all-pins-intact docs stale anyway in practice — copy that teaches agents
to discount TTL would be exactly the freshness-laundering the annotate-only
rule exists to prevent.

**Amendment (2026-07-27 plan resolution, C9): condition (b) cannot be fully
measured by the instrumentation this design builds.** A code re-read
happens in the agent's own tool-use loop, outside Daftari entirely — the
read log has no join key into it, and never will without instrumenting the
agent harness. The observable subset is real and worth measuring: a doc
update, a pin refresh, or a tension logged *within the same run* following
a `moved`/`missing` annotation, joined from the read log
(`anchors_moved`/`anchors_missing`, per-run via `run_id`) against
subsequent writes and `daftari audit --auto-tension` output. But absence of
those signals in that joined data is, on its own, **insufficient** to kill
the read-path check — it is equally consistent with "agents re-read the
code and said nothing else about it" (the intended, cheapest-possible
consequence: an agent that re-reads before acting has already done the
thing pins exist to prompt) and with "agents ignore the flag entirely."
Before reverting on (b), the evaluation must ALSO include a spot check of
agent transcripts, or an operator interview, specifically probing for the
invisible consequence — code re-reads that never produced a Daftari-visible
side effect. The read-log fields are documented, here and in code, as
measuring exactly what they measure (the observable subset) and nothing
more; a dashboard or report built on them must carry that caveat forward
rather than presenting the joined count as the full picture.
