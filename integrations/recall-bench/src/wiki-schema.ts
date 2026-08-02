// EA wiki schema (WIKI.md body) for the recall-bench autonomous authoring arm C.
//
// This is the WIKI.md content written into the vault at runtime and read by the
// authoring agent via vault_read before any write operation. It defines the page
// types, folder structure, frontmatter requirements, and conventions for an
// executive-assistant daily-log corpus.
//
// Modelled on the wiki-maintainer WIKI.md structure (Berlin Bureau sample) but
// with EA-appropriate page types: topics/, decisions/, entities/, tasks/, tensions/.

export const EA_WIKI_MD: string = `# EA Daily-Log Wiki

> This file configures the wiki-maintainer skill for the executive-assistant
> daily-log corpus. The machine-readable schema block below is the source of
> truth for folder structure, required frontmatter, and enum values.
> Human prose sections document each folder and its role.

---

## Machine-Readable Schema

\`\`\`yaml
# --- daftari-wiki-schema ---
enums:
  curation: [working, evergreen, deprecated]
  priority: [high, medium, low]
  status: [open, in-progress, done, blocked, cancelled]
enum_fields:
  curation: curation
folders:
  topics:     { type: topic,    required: [title, created, updated, curation], h2: [Summary, Key Points, Cross-References] }
  decisions:  { type: decision, required: [title, decided_by, decided_on, curation], h2: [Context, Decision, Rationale, Cross-References] }
  entities:   { type: entity,   required: [title, entity_type, created, updated, curation], h2: [Profile, Cross-References] }
  tasks:      { type: task,     required: [title, owner, status, created, updated, curation], checks: [{field: status, enum: status}], h2: [Description, Cross-References] }
  tensions:   { type: tension,  required: [title, temperature, stakes], h2: [Tension, Bridge, Cross-References] }
\`\`\`

---

## Purpose

This wiki compiles an executive assistant's daily logs into a structured,
cross-referenced knowledge base. Raw daily logs are the ingest input — they are
never modified after ingestion. The wiki synthesises them into navigable pages
across five typed folders.

The authoring agent ingests each day's log, extracts entities, tasks, decisions,
and recurring themes, and files them as typed wiki pages with [[wikilinks]] between
related entries. Contradictions between days are filed as tensions rather than
silently resolved.

---

## Folder Map

| Folder | Type | What it holds |
|---|---|---|
| \`topics/\` | topic | Recurring themes, projects, and subject areas that span multiple days |
| \`decisions/\` | decision | Explicit decisions logged — who decided, when, rationale |
| \`entities/\` | entity | People and organisations mentioned (person, org, vendor, stakeholder) |
| \`tasks/\` | task | Action items and follow-ups extracted from the logs |
| \`tensions/\` | tension | Conflicting claims or priorities across days — never auto-resolved |

---

## Folder Details

### topics/

Topics are recurring themes or project areas that surface across multiple log
entries. One page per subject. The agent creates a topic page the first time a
theme appears and appends cross-references as it recurs.

Required frontmatter: \`title\`, \`created\`, \`updated\`, \`curation\`.
Required sections: Summary, Key Points, Cross-References.

Examples: \`topics/q3-planning.md\`, \`topics/vendor-review.md\`.

### decisions/

Decisions are explicit choices logged in the daily record — go/no-go calls,
approvals, strategic pivots. Each decision page captures who decided, when, and
the rationale stated at the time.

Required frontmatter: \`title\`, \`decided_by\`, \`decided_on\`, \`curation\`.
Required sections: Context, Decision, Rationale, Cross-References.

Examples: \`decisions/2026-03-14-budget-freeze.md\`.

### entities/

Entities are people and organisations that appear in the logs. One page per
person or org. The \`entity_type\` field distinguishes: \`person\`, \`org\`,
\`vendor\`, \`stakeholder\`.

Required frontmatter: \`title\`, \`entity_type\`, \`created\`, \`updated\`, \`curation\`.
Required sections: Profile, Cross-References.

Examples: \`entities/sarah-chen.md\`, \`entities/acme-corp.md\`.

### tasks/

Tasks are action items extracted from daily logs. The \`status\` field tracks
lifecycle: \`open\`, \`in-progress\`, \`done\`, \`blocked\`, \`cancelled\`.

Required frontmatter: \`title\`, \`owner\`, \`status\`, \`created\`, \`updated\`, \`curation\`.
Required sections: Description, Cross-References.

Examples: \`tasks/follow-up-acme-contract.md\`.

### tensions/

Tensions capture conflicting claims or priorities across log entries. A tension
page names two sides, a temperature (1–5), and stakes (BET / DECISION / UNTAGGED).
Tensions are NEVER auto-resolved — they stay open until an analyst arbitrates.

Required frontmatter: \`title\`, \`temperature\`, \`stakes\`.
Required sections: Tension, Bridge, Cross-References.

Filing a tension also registers it in the daftari backend via \`vault_tension_log\`.
If the daftari MCP is unavailable, create the markdown file and log a warning.

Examples: \`tensions/2026-03-budget-vs-hiring.md\`.

---

## Curation Lifecycle

- \`curation: working\` — default for all new pages. LLM-drafted, not yet human-curated.
- \`curation: evergreen\` — promoted by a human after confirming the page is accurate,
  atomic, and linked from at least two other evergreen pages.
- \`curation: deprecated\` — superseded or retracted.

New pages ALWAYS start as \`working\`. The authoring agent never sets \`evergreen\` —
that gate belongs to the human curator.

---

## Page Naming Convention

- Lowercase, hyphenated: \`q3-planning.md\`, \`sarah-chen.md\`.
- Decisions are date-prefixed: \`decisions/YYYY-MM-DD-{slug}.md\`.
- Tensions are date-prefixed: \`tensions/YYYY-MM-DD-{side-a}-vs-{side-b}.md\`.
- One page per subject. Sections before new pages.

---

## Maintenance Cadence

- **On ingest (each daily log):** update \`index.md\`, append to \`log.md\`, create or
  update relevant topic/entity/task/decision pages, file tensions if contradictions arise.
- **On contradiction:** file the \`tensions/\` page AND call \`vault_tension_log\` before
  closing the ingest session. Never silently resolve.
- **On supersede:** call \`vault_supersede\` and set \`superseded_by\` in the old page's
  frontmatter. Do not delete the old page — provenance must be preserved.
`;
