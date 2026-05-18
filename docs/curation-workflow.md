# The curation loop — acting on advisory output

Daftari's curation engine is **advisory by design**. `vault_lint` reports
problems; `vault_tension_log` records contradictions. Neither auto-fixes
anything. This is the right call — no automated process should silently rewrite
or delete knowledge — but it has a consequence:

> A linter without a loop is a smoke detector with no fire department.

The value of the curation layer is only realized when something *acts* on its
output. Without a loop, the likely outcome is: `vault_lint` produces a report,
nobody reads it, the vault accumulates stale documents and unresolved tensions,
and the curation layer cheerfully tells you the vault is rotting without doing
anything about it. That is the Obsidian-inbox problem at vault scale.

This document is a **reference workflow**: a recommended agent loop that closes
the gap between "the linter found a problem" and "the problem is fixed." v1
does not ship an automated curation agent — but with this workflow you can run
one yourself today, and it doubles as the spec for a future background agent.

It is not a code change. It is the missing half of an advisory system.

---

## The loop at a glance

```
   on a cadence
        │
        ▼
   vault_lint  ──▶  triage each finding  ──▶  act (re-verify · deprecate ·
        │                                     promote · link · answer)
        │
   vault_status ─▶  resolve tensions     ──▶  fix the documents, then mark
                                              the tension resolved by hand
```

Run it after every *N* writes, or on a fixed cadence (weekly is a reasonable
default for an actively-used vault). The loop has one job: drive `vault_lint`'s
`totalFindings` and `vault_status`'s unresolved-tension count toward zero —
*deliberately*, one finding at a time.

---

## 1. Trigger

The loop begins with two read-only calls:

```jsonc
// vault_lint  — the actionable findings
{}

// vault_status — the dashboard: staleness distribution, unresolved tensions
{}
```

`vault_lint` returns findings grouped under six checks. `vault_status` adds the
staleness distribution and the unresolved-tension count. Together they are the
loop's worklist. Pass `{ "filter": "<check>" }` to `vault_lint` to work one
check at a time.

A note on the agent's **role**: the loop needs `write` permission on every
collection it curates, and `promote: true` if it will promote drafts (step 2d).
Run the loop under a role that has them, or it will be denied mid-loop.

---

## 2. Triage the lint report

Each of the six checks has a recommended response. None of them is "ignore it."

### 2a. `staleFiles` — past TTL, overdue for review

For each finding, `vault_read` the document (the response carries a `decay`
assessment) and choose:

- **Still true?** Re-verify the content and `vault_write` it back. Every write
  re-stamps `updated`, so this alone resets the staleness clock. To push the
  next review further out, also raise `ttl_days`.
- **No longer true?** `vault_deprecate` it with a reason — and a `superseded_by`
  path if a newer document replaces it.
- **Can't decide?** Leave it untouched. See the gotcha below.

> **Gotcha — do not "flag and forget" by writing into the file.** It is
> tempting to append a `## Needs Review` section. Don't: `vault_append` (like
> every write tool) re-stamps `updated`, which resets the decay score and makes
> the document *drop off the next lint report* — the opposite of flagging it. A
> stale document the loop cannot resolve should be **left stale on purpose** so
> it keeps surfacing. The lint report itself is the review queue; escalate to a
> human through the loop's own output, not by mutating the document.

### 2b. `oldDrafts` — drafts unpromoted past 30 days

A draft that has sat for over 30 days is either ready to promote or ready to
abandon. `vault_read` it and decide — this feeds step 2d.

### 2c. `stagnantLowConfidence` — low confidence, untouched too long

A `confidence: low` document that has not improved in 30+ days. The loop should
either *improve* it — research and `vault_write` with a higher confidence — or,
if it is not worth the effort, `vault_deprecate` it. A document parked at low
confidence forever is noise.

### 2d. Promote mature drafts

For a draft (from 2b) that has **complete frontmatter** and **medium-or-higher
confidence**, call `vault_promote`:

```jsonc
// vault_promote
{ "path": "pricing/helios-spend-predictability.md", "agent": "agent:curator" }
```

Promotion **refuses** unless the document is currently a draft, its frontmatter
is complete, and a confidence level has been explicitly set — and unless the
loop's role has `promote: true`. A refusal is informative: it tells you exactly
what is missing. Fix that, then re-promote.

### 2e. `orphanFiles` — no inbound links

A document no other document links to is disconnected knowledge. For each
orphan:

- **Still relevant?** Link it in. Add a wikilink to it from a related hub
  document (`vault_append` a "See also" line, or weave the link into prose).
  `vault_search_related` against the orphan's path finds good homes for the
  link.
- **No longer relevant?** Retire it — `vault_deprecate` it, or `vault_write` it
  back with `status: archived` to keep it for the record without it counting as
  live knowledge.

> v1 does not track per-document read counts, so orphan triage is driven purely
> by the inbound-link graph. "Nobody links to it" is the available signal.

### 2f. `unansweredQuestions` — open questions nothing answers

A question in some document's `questions_raised` that no document lists under
`questions_answered`. For each:

- **Answerable now?** Write or extend the document that answers it, and add the
  question to that document's `questions_answered` (normalized text must match
  the raised phrasing for the check to clear it).
- **Genuinely open?** Leave it. An open question is not a defect — it is the
  vault honestly marking its own edges. This check is a *coverage map*, not a
  list of bugs.

---

## 3. Resolve tensions

Tensions are tracked separately from lint. `vault_status` reports the count of
unresolved tensions; the full log lives in `.daftari/tensions.md`, one `## `
block per tension, each carrying a `Status:` line.

For each `unresolved` tension:

1. `vault_read` **both** source documents named in the entry.
2. Determine which claim is correct — or flag genuine ambiguity for a human.
3. Act on the documents: `vault_write` the losing document to correct it, or
   `vault_deprecate` it (with `superseded_by` pointing at the winner).
4. **Mark the tension resolved.** This is the one step with no MCP tool behind
   it. `vault_tension_log` only *appends* new entries — by design, Daftari
   records tensions and never resolves them. Resolution is a deliberate
   curatorial act: edit `.daftari/tensions.md` directly and change that entry's
   `Status:` line from `unresolved` to `resolved`. A human, or an agent with
   filesystem access to the vault, does this by hand.

Fixing the documents without updating the `Status:` line leaves the tension
showing as unresolved forever; updating the line without fixing the documents
is a lie. Do both, in that order.

---

## Why advisory + a loop beats auto-fix

It is worth being explicit about why the curation engine does not just fix
these things itself. Auto-fix would mean an automated process silently
rewriting or deleting knowledge — promoting a draft no human vouched for,
deprecating a document that was merely unfamiliar. Every change in Daftari is a
deliberate, attributable act, recorded in git and the provenance log.

The loop preserves that. The linter surfaces; a deliberate agent (or human)
decides; every fix is a normal, attributed write. You get the coherence of an
actively-curated vault without ever handing an automated process a silent
delete key.

When v1's advisory engine grows a v2 background curation agent, *this workflow
is its specification* — the same triage, the same tools, on a schedule.

---

## Next

- [getting-started.md](getting-started.md) — the tool tour: lint, promote, deprecate.
- [worked-example.md](worked-example.md) — compilation over retrieval, shown across three writes.
- [architecture.md](architecture.md) — Layer 4 (Curation) and why it is advisory.
