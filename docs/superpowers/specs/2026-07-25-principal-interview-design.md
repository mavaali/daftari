# Principal interview — design

2026-07-25. Status: draft, pending review.

## Why

The design steal is the companion interview on Terence Tao's "living summary"
page (teorth.github.io/tao-web/ai-views.html, July 2026): an assistant compiled
a corpus of the author's public positions, and instead of guessing where the
corpus was ambiguous, it *asked him* — targeted questions aimed exactly at the
unclear spots, with the answers reproduced verbatim and folded back into the
summary as first-class source material.

A Daftari vault is that corpus, and Daftari already computes "unclear" — it
just never asks. Three existing signals are, precisely, the interviewer's
question list:

- **Open tensions.** Two documents disagree and neither superseded the other.
  The court can brief the dispute and retrieve precedent, but when the vault
  belongs to a principal whose position simply isn't recorded, the shortest
  path to resolution-by-discovery is to ask them.
- **Expired canon.** A canonical accumulation doc past its `ttl_days` made a
  freshness promise and broke it. "Is this still true?" is an interview
  question before it is a re-verification task.
- **Unanswered `questions_raised`.** The epistemic-surface fields already
  record what each doc wishes it knew. A raised question that no doc's
  `questions_answered` covers is an open question the whole vault is carrying.

`daftari interview` assembles those signals into a question sheet, conducts
the interview at the terminal, and records the verbatim answers as a new vault
document. The vault interrogates its principal, instead of the principal
interrogating the vault.

## Decisions

1. **Deterministic and LLM-free.** The sheet is assembled entirely from
   existing signals (tension log, staleness scan, frontmatter walk). No flag
   on this surface can spend — the circadian precedent from `daftari sleep`.
   LLM-sharpened question phrasing is future work behind an explicit opt-in.
2. **Operator-only, like the court.** The interview reads the full tension
   log and every collection with no access context; its module never takes
   one. Exposing any interview surface over MCP requires revisiting the
   2026-07-14 edge-graph existence-disclosure spec first.
3. **Answers are testimony, not resolution.** Recording an answer never
   resolves a tension, never edits a disputed document, never bumps a TTL.
   A tension may never masquerade as a supersession — and an interview answer
   is *evidence for* a ruling, not a ruling. The CLI prints the follow-up
   acts (`daftari court rule <id> --references <transcript>`, re-verify and
   rewrite the stale doc) and performs none of them.
4. **The transcript is a first-class vault doc** — that is the fold-back.
   It lands in a collection (default `interviews/`) with:
   - `tier: source` — verbatim human words are raw source material; the body
     is immutable to every writer thereafter (#141).
   - `provenance: direct`, `confidence: high` — it is the principal's own
     statement, not a synthesis.
   - `ttl_days: null` — a record of what was said on a date does not expire.
   - `sources` — the tension ids and doc paths each question came from, so
     the testimony is traceable back to the signals that prompted it.
   - `questions_answered` — the question texts, so a later sheet never
     re-asks what a transcript already answered, and vault_search can find
     testimony by the question it settled.
5. **Disclosure posture: quoting is scoped by RBAC on the transcript's
   collection.** The sheet quotes tension claims across collections — exactly
   the cross-ACL quote laundering the 2026-07-12 tension-RBAC spec forbids on
   the MCP surface. The transcript is safe by default: a new `interviews`
   collection is readable only by roles with `read: ["*"]`, and a wildcard
   reader sees every collection already, so the transcript leaks nothing it
   couldn't read at the source. Granting a narrower role read on the
   transcript collection is a deliberate operator act; the help text warns
   that doing so exposes quotes from every collection the interview touched.

## Shape

New module `src/interview/` (no access context, court convention):

- `questions.ts` — `gatherQuestions(vaultRoot, {now, limit})` builds the
  priority-ordered sheet. Kinds and order:
  1. `tension` — unresolved entries, stale aging tier first, then oldest.
     Skips `unspecified` (legacy, unresolvable through the tools) and
     `inter-proposal` (contested staged actions close through `vault_ratify`,
     not testimony).
  2. `stale` — canonical accumulation docs at/past TTL, largest overshoot
     first. Generative docs never appear (sleep's domain split: their decay
     is expected, not a question).
  3. `open_question` — `questions_raised` entries (from non-deprecated,
     non-superseded, non-archived docs) that no doc's `questions_answered`
     matches after whitespace/case normalization. Duplicate raisings merge
     into one question with all raising docs as refs.
- `transcript.ts` — renders the transcript markdown (frontmatter per
  Decision 4, one `## q-NNN` block per answered question, answers verbatim),
  allocates a collision-free `interviews/YYYY-MM-DD-interview.md` path, and
  writes + auto-commits honoring `auto_commit` and `git_dir` from config.
- `index.ts` — `daftari interview` prints the sheet (read-only default,
  court convention); `daftari interview ask` runs the terminal loop. Empty
  answer skips a question; `q` or EOF ends the session; only answered
  questions are recorded. Exit codes follow the audit convention (0/2/3).
  The ask loop takes an injectable io so tests script it.

## Non-goals (v1)

- No LLM anywhere on the surface.
- No auto-resolution, auto-supersession, or TTL refresh from answers.
- No MCP tool (Decision 2).
- No scheduling — like sleep, cadence belongs to the operating system.
