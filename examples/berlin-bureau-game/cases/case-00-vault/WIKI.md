# Daftari — Berlin Bureau (Tutorial: The Dead Drop)

> Tutorial case vault. Same schema as the full Berlin Bureau; a smaller world to teach the loop:
> grade a source → notice a contradiction → hold it as a tension → find an independent
> corroborator → clear the verification gate → deduce. There is NO disinformation trap here — every
> report is filed honestly, one is just weak and mistaken.
> The machine-readable schema block below is the source of truth for the linter and engine.

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

## The tutorial in one screen

A walk-in source will service one of three dead-drop sites tonight — **site-4**, **site-7**, or
**site-9**. The Bureau needs the right one. Three reports are on file:

- **SPARROW** (B2) says **site-7**.
- **WREN** (D4) says **site-4** — an honest report, but from a single glimpse in poor light.
- An **independent signals intercept** (A2), tied to neither courier, also says **site-7**.

Grade the sources. Notice SPARROW and WREN disagree — that is a contradiction, so file it as a
tension rather than picking a side. Then look for a source independent of both: the A2 intercept
corroborates SPARROW. Two independent sources on site-7 clears the verification gate
(`working → evergreen`); WREN's site-4 stays an open, low-grade tension, not a credited answer;
site-9 was never asserted by anyone. The drop is **site-7** — and you can show your work.
