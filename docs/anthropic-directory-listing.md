# Anthropic Connectors Directory — listing copy

This file holds the canonical copy for daftari's listing in the Anthropic
Connectors Directory (desktop extensions / MCPB category). Edit here first
when polishing the listing; submit at
<https://clau.de/desktop-extention-submission>.

`docs/` is excluded from the `.mcpb` bundle via `.mcpbignore`, so this file
ships only in the source repo — not to end users.

## Tagline

> A persistent cortex Claude reads, writes, and curates over time.

64 characters. Verb-led; "over time" carries the compounding implication
without forcing the word "compounds". "Cortex" echoes the README's signature
framing ("a cortex, not a clipboard") so the card view and the detail page
speak with one voice.

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

## Form fields — status

| Field | Value / source | Status |
|---|---|---|
| Name | Daftari | ready |
| Tagline | (above) | ready |
| Description (short) | `manifest.json` `description` | ready |
| Long description | `manifest.json` `long_description` | ready |
| Use cases | (above) | ready |
| Documentation URL | <https://github.com/mavaali/daftari#readme> | ready |
| Privacy policy URL | <https://github.com/mavaali/daftari/blob/main/PRIVACY.md> | ready |
| Support URL | <https://github.com/mavaali/daftari/issues> | ready |
| License | MIT | ready |
| Test setup steps | Scaffold a vault with `npx daftari --init <path>`, install the `.mcpb` in Claude Desktop, configure with `vault_path = <path>`, `user = me`, `role = admin`. No account, no auth. | ready |
| Authentication type | None (local-only stdio) | ready |
| Transport | stdio | ready |
| Tools list | 14 tools, names per `src/tools/*.ts`; descriptions per CHANGELOG `## [1.12.0]` MCP tool annotations entry | ready |
| Read/write capabilities | Mixed — 8 read tools, 6 write tools (see annotations table) | ready |
| Health data access | None | ready |
| Third-party connections | None by default. Optional: OpenAI `text-embedding-3-small` if user explicitly enables it in `.daftari/config.yaml` | ready |
| Logo / icon | `icon.png` (370KB) — **verify dimensions against form spec** | needs check |
| Screenshots | 2–4 of Claude Desktop using daftari (e.g. `vault_search` result, `vault_write` round-trip) | **TODO** |
| Category | Pick from form's list when it appears (likely Productivity / Knowledge / Developer Tools) | **TODO** |
| GA date | Pick a date | **TODO** |

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

## Pre-submission checklist (from Anthropic docs)

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
- [ ] Exercise every tool via MCP Inspector against the v1.12.5 `.mcpb` install
- [ ] Capture screenshots
- [ ] Fill the form

## Artifact for upload

`daftari-1.12.5.mcpb` from
<https://github.com/mavaali/daftari/releases/tag/v1.12.5> (sha256
`bed6abd10b290be5838562f8d0fec1a239524f3c`).
