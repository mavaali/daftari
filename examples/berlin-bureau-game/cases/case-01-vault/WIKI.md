# Daftari — Berlin Bureau

> This file configures the wiki-maintainer skill for the Berlin Bureau knowledge base.
> The machine-readable schema block below is the source of truth for the linter and engine.
> Human prose sections document each folder and the multi-user primitives as spycraft.

---

## Machine-Readable Schema

```yaml
# --- daftari-wiki-schema ---
enums:                       # field-value must be one of a flat list
  curation: [working, evergreen, deprecated]
patterns:                   # field-value must match a regex (for compound codes)
  source_reliability: "^[A-F][1-6]$"   # Admiralty code: reliability A-F + credibility 1-6
enum_fields:                # field -> enum applied on EVERY folder that requires that field
  curation: curation
folders:
  operations:   { type: operation,  required: [title, owner, created, updated, curation], h2: [Summary, Cross-References] }
  assets:       { type: asset,       required: [title, entity_type, created, updated, curation], h2: [Cross-References] }
  dossiers:     { type: dossier,     required: [title, created, updated, curation], h2: [Key Points, Cross-References] }
  directives:   { type: directive,   required: [title, decided_by, decided_on], h2: [Context, Decision] }
  assessments:  { type: assessment,  required: [title, sources, source_reliability, created, updated, curation], checks: [{field: source_reliability, pattern: source_reliability}], h2: [Assessment, Cross-References] }
  field-reports: { type: field-report, required: [title, source_reliability, created], checks: [{field: source_reliability, pattern: source_reliability}] }
  tensions:     { type: tension,     required: [title, temperature, stakes], h2: [Tension, Bridge, Cross-References] }
evergreen_requires_one_of: [ [corroborated_by, corroborated_on], [single_source] ]
```

---

## Purpose

The Berlin Bureau is a fictitious Cold War intelligence station operating in divided Berlin.
Its knowledge base compiles raw intelligence cables into a structured, provenance-graded,
contradiction-preserving picture of the operational environment.

The Directorate — the opposing service — is un-named and fictional throughout. No real
intelligence agency is depicted.

The wiki-maintainer skill maintains this knowledge base. Analysts ingest raw field reports;
the skill compiles them into dossiers, assessments, and directives. Contradictions between
sources are never silently resolved — they are held open as tensions until an analyst
arbitrates. This is not a limitation of the system; it is the system.

---

## Folder Map — Spycraft Edition

| Folder | Engine type | What it holds | Spycraft analogy |
|---|---|---|---|
| `operations/` | initiative | Code-named operations, each with a case officer (owner) | An op file: GLASS CURTAIN, AMBER SIGNAL, HOLLOW KING |
| `assets/` | entity | Human sources, couriers, suspected doubles, front organizations | The agent stable: NIGHTINGALE, CARTOGRAPHER, MAGPIE, WEATHERVANE |
| `dossiers/` | topic | Subject files — persons, networks, locations, concepts | The subject file on defector AMBER |
| `directives/` | decision | Station-chief approvals, go/no-go calls, rationale + who/when | AMBER SIGNAL exfiltration: go |
| `assessments/` | synthesis | The compiled intelligence picture, source-graded and curation-tracked | AMBER bona fides: working → evergreen once corroborated |
| `field-reports/` | raw source | Dated cables and debriefs, source-graded before ingestion | FR-014 (NIGHTINGALE, B2): AMBER is genuine |
| `tensions/` | tension | Conflicting intelligence — daftari dual-layer, never auto-resolved | AMBER: genuine defector vs. Directorate dangle |

Raw field reports (`field-reports/`) are the ingest input — they never promote to evergreen.
They are graded, ingested into dossiers and assessments, and then referenced by path from
higher-level pages.

---

## Multi-User Primitives — As Spycraft

### Source Grading (Admiralty Code)

Every field report and assessment carries `source_reliability`: a two-character Admiralty code.

- First character (A–F): **source reliability** — A = completely reliable, F = reliability cannot be judged.
- Second character (1–6): **information credibility** — 1 = confirmed by other sources, 6 = truth cannot be judged.

Examples: `B2` = usually reliable source, probably true. `C3` = fairly reliable, possibly true. `D4` = not always reliable, doubtful.

### Verification Gate (working → evergreen)

- `curation: working` — uncorroborated or single-source raw intelligence. Default for new pages.
- `curation: evergreen` — corroborated by at least two independent sources, promoted by an analyst.
- `curation: deprecated` — superseded, burned, or retracted.

### Second-Source Sign-Off

Every page with `curation: evergreen` must declare exactly ONE of:

- `corroborated_by: <analyst or source>` AND `corroborated_on: YYYY-MM-DD`
- `single_source: true` — honest declaration that the intelligence rests on one source only.

### Contradictions Held Open — Tensions

When two field reports conflict, the contradiction is filed as a `tensions/` page with
`temperature` (1–5) and `stakes` (BET / DECISION / UNTAGGED), and a `vault_tension_log`
entry. The tension stays open until an analyst arbitrates. The wiki does not auto-resolve.
