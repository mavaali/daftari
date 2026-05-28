# Anthropic Connectors Directory — listing copy

This file holds the canonical copy for daftari's listing in the Anthropic
Connectors Directory (desktop extensions / MCPB category). Edit here first
when polishing the listing; submit at
<https://clau.de/desktop-extention-submission>.

`docs/` is excluded from the `.mcpb` bundle via `.mcpbignore`, so this file
ships only in the source repo — not to end users.

---

## Status — submitted 2026-05-27

Submitted at <https://clau.de/desktop-extention-submission> with
`daftari-1.12.6.mcpb`. The form is a Google Form
(`docs.google.com/forms/d/e/1FAIpQLScHtjkiCNjpqnWtFLIQStChXlvVcvX8NPXkMfjtYPDPymgang`)
and the response receipt landed in `mihir.wagle@gmail.com`'s inbox.

**What's actually waiting:** Anthropic curates the directory and the form
itself says *"we can't guarantee we'll respond to all submissions or that
we'll be able to respond within a certain timeframe"* and *"will reach
out to selected developers if and when we're ready to begin the
evaluation process."* Silence is neither acceptance nor rejection.

**What may come if/when a reviewer engages:**
- Clarifying question or fix request → respond + possibly cut a patch
- Approval → reviewer hands you a listing-page editor where the
  screenshots / category / GA date / logo work would happen. That's
  where the "for the listing page later" rows below get used.

**npm and release surfaces are caught up:**
- npm: `daftari@1.12.6` (jumped from 1.11.0)
- GitHub release: <https://github.com/mavaali/daftari/releases/tag/v1.12.6>
- All v1.12.0–v1.12.6 changelog entries live in `CHANGELOG.md`

---

## Tagline

> A persistent cortex Claude reads, writes, and curates over time.

64 characters. Verb-led; "over time" carries the compounding implication
without forcing the word "compounds". "Cortex" echoes the README's signature
framing ("a cortex, not a clipboard") so the card view and the detail page
speak with one voice.

## Description (for the form — 50-word cap)

> An external cortex for AI agents: a persistent markdown vault that
> agents read, write, and curate over time. Plain text on disk,
> git-versioned, indexed for BM25 + vector search. Agents promote
> drafts to canonical knowledge, surface contradictions as tensions,
> and lint for staleness. Runs offline by default.

47 words. Form caps at 50.

Differs from `manifest.json`'s `long_description` (which still leads
with "an MCP server that exposes a curated markdown vault") in three
ways: leads with the cortex framing to harmonize with the tagline and
use cases; trims engineering trivia (the `OPENAI_API_KEY` env-var
name, the `embeddings.provider: openai-3-small` config path, RBAC
specifics) that belongs in the README; cuts redundancy ("hybrid"
modifying "BM25 + vector"; "read and search, write new documents"
when the lead already has the verbs).

**Discrepancy note:** `manifest.json`'s `long_description` is what
Claude Desktop's install UI shows when a user installs the `.mcpb`.
The directory-listing version above is what reviewers and browsers
see in the directory. Same facts, different framing. If we want them
to match exactly, that's a `manifest.json` edit + a v1.12.6 release.
For now, they diverge — directory leads with cortex, install UI uses
the existing MCP-server-and-vault opener.

## Use cases

1. **Compile knowledge that compounds.**
   Most agent setups re-derive answers each session, or stitch them from RAG
   chunks. Daftari takes the other path: the agent synthesizes once, writes
   the answer back as a durable document, and every later read starts from
   the compiled result. The vault gets better the more it's used.

2. **Give Claude an external cortex, not a clipboard.**
   A persistent, structured surface where drafts consolidate into canonical
   knowledge, contradictions surface as tensions, and stale facts decay on a
   schedule. The agent doesn't just read from the vault — it thinks with it.

3. **Keep every claim dated, attributed, and reviewable.**
   Each write records the author, timestamp, sources, and confidence. Lint
   surfaces stale facts, orphan documents, and questions raised but never
   answered — the cortex stays honest as it grows.

4. **Hold facts and brainstorms to different standards.**
   Two domains — `accumulation` (knowledge that compounds, must stay fresh)
   and `generative` (speculation allowed to go stale). The split keeps the
   system from nagging about every brainstorm or quietly trusting every stale
   fact.

5. **Surface contradictions instead of absorbing them.**
   When two documents disagree, daftari logs the tension explicitly. The
   vault doesn't silently merge incompatible claims; it flags them as part of
   the curation surface.

If the form caps at fewer than five, drop #5 first, then #4.

## What the intake form actually asks (verified from the 2026-05-27 receipt)

The Google Form at <https://clau.de/desktop-extention-submission> is
minimal — just enough for Anthropic to triage. The rich listing-page
content lives elsewhere (see next section).

| Form field | Answer used | Source |
|---|---|---|
| Is this an update to an existing extension? | No | — |
| Primary Contact Name | Mihir Wagle | — |
| Primary Contact Email | mihir.wagle@gmail.com | — |
| MCP Server Description (50 words max) | "An external cortex for AI agents: a persistent markdown vault that agents read, write, and curate over time. Plain text on disk, git-versioned, indexed for BM25 + vector search. Agents promote drafts to canonical knowledge, surface contradictions as tensions, and lint for staleness. Runs offline by default." | `manifest.json` `long_description` (also recorded in this doc) |
| Desktop Extension GitHub Link | <https://github.com/mavaali/daftari> | — |
| Primary Party Confirmation | Yes (defensible; see note) | — |
| .mcpb file | `daftari-1.12.6 - Mihir Wagle.mcpb` | renamed copy of the v1.12.6 release artifact |
| MCP Directory T&C | ✓ agreed | <https://support.anthropic.com/en/articles/11697081-anthropic-mcp-directory-terms-and-conditions> |
| Feedback (optional) | (blank) | — |

**Note on Primary Party Confirmation.** The question is *"I work for the
company that owns the application or service that this MCP server
connects to."* — most naturally a question for connector-to-third-party
submissions (Slack MCP from a Slack employee, etc.). For a
self-contained extension like daftari, it's ambiguous: Yes is honest
if "the service" means daftari itself; No would be honest if "the
application" means Claude Desktop. The form notes it's a priority
signal, not a gate. If a reviewer asks, the answer is "I am daftari's
sole maintainer; daftari is the service."

## For the listing page (if/when Anthropic engages)

These items aren't part of the intake form. They surface during
review correspondence and/or when the reviewer hands over the
listing-page editor. Keep ready so we're not scrambling.

| Listing-page field | Value / source |
|---|---|
| Tagline | "A persistent cortex Claude reads, writes, and curates over time." (also `manifest.json` `description`) |
| Long description | Same 47-word text used in the intake form |
| Use cases | The 5 bullets above (cortex / compounding / provenance / domain split / tensions) |
| Documentation URL | <https://github.com/mavaali/daftari#readme> |
| Privacy policy URL | <https://github.com/mavaali/daftari/blob/main/PRIVACY.md> |
| Support URL | <https://github.com/mavaali/daftari/issues> |
| License | MIT |
| Test setup steps | Scaffold a vault with `npx daftari --init <path>`, install the `.mcpb` in Claude Desktop, configure with `vault_path = <path>`, `user = me`, `role = admin`. No account, no auth. |
| Authentication type | None (local-only stdio) |
| Transport | stdio |
| Tools list | 14 tools, see annotations table below |
| Read/write capabilities | Mixed — 8 read tools, 6 write tools |
| Health data access | None |
| Third-party connections | None by default. Optional: OpenAI `text-embedding-3-small` if user explicitly enables it in `.daftari/config.yaml` |
| Logo / icon | `icon.png` (370KB) — dimensions check happens if the listing UI rejects |
| Screenshots | 2–4 of Claude Desktop using daftari (capture when needed) |
| Category | Likely Productivity / Knowledge / Developer Tools; pick from dropdown |
| GA date | Pick when prompted |

## Tool annotations table (reference for the form's tool list)

| Tool | Title | Hint |
|---|---|---|
| `vault_read` | Read a vault document | readOnly |
| `vault_index` | List vault documents | readOnly |
| `vault_status` | Vault health dashboard | readOnly |
| `vault_search` | Search the vault | readOnly |
| `vault_search_related` | Find related documents | readOnly |
| `vault_provenance` | View document write history | readOnly |
| `vault_lint` | Run curation checks | readOnly |
| `vault_themes` | Cluster vault themes | readOnly |
| `vault_reindex` | Rebuild search index | non-destructive, idempotent |
| `vault_write` | Create or update a document | destructive |
| `vault_append` | Append to a document | destructive |
| `vault_promote` | Promote draft to canonical | destructive |
| `vault_deprecate` | Deprecate a document | destructive |
| `vault_tension_log` | Log a contradiction | destructive |

## Pre-submission checklist (from Anthropic docs) — all complete

- [x] Tool annotations (`title` + `readOnlyHint` / `destructiveHint`) on every tool — shipped v1.12.0
- [x] Tool names ≤ 64 characters
- [x] No mixed-method (read+write) tools
- [x] Narrow, accurate tool descriptions (sweep in v1.12.5 PR #75)
- [x] No prompt-injection patterns in tool descriptions (sweep in v1.12.5 PR #75)
- [x] Privacy policy in `manifest.json` `privacy_policies` array
- [x] `PRIVACY.md` present with all five mandatory sections
- [x] Privacy section in `README.md` — added v1.12.5
- [x] Public GitHub repo, MIT license
- [x] Frontmatter input schema exposes enum constraints — closes #74 in v1.12.5
- [x] `manifest.json` `description`/`long_description` aligned with directory listing — v1.12.6 PR #80
- [x] Exercise every tool via MCP Inspector + Claude Desktop connector — done 2026-05-26
- [x] Fill and submit the form — done 2026-05-27 (receipt in inbox)

## Artifact submitted

`daftari-1.12.6.mcpb` (renamed locally to `daftari-1.12.6 - Mihir Wagle.mcpb`
for upload), built from <https://github.com/mavaali/daftari/releases/tag/v1.12.6>
(sha256 `1672e3512d0a2856562ce11dd8b33891afdc1ac2eff06df7602a4fb3a35c69c0`).
