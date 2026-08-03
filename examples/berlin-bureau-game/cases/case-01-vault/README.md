# Berlin Bureau — daftari demo vault

A fictitious Cold War intelligence bureau. All content is invented; no real persons, agencies,
or events are depicted. The opposing service is the un-named "Directorate."

This vault demonstrates three daftari differentiators through the lens of espionage:

1. **Contradictions held open as tensions** — not auto-resolved, never silently discarded.
2. **Source-reliability provenance** — Admiralty codes on every raw source and synthesis.
3. **Confidence tiers with a human gate** — `working` → `evergreen` requires corroboration and analyst sign-off.

---

## File map — behavior demonstrated

### `WIKI.md`
The machine-readable schema block (`# --- daftari-wiki-schema ---`) is the source of truth for the
linter and engine. Demonstrates the pattern-validated `source_reliability` field, the `curation`
enum, the per-folder required-field contract, and the `evergreen_requires_one_of` corroboration gate.

---

### `dossiers/`

| File | Demonstrates |
|---|---|
| `amber.md` | A `working` dossier — single-source, not yet corroborated. Cross-links to both sides of the open tension. |
| `nightingale.md` | An `evergreen` dossier — corroborated by a second analyst (`corroborated_by` + `corroborated_on`). Shows the second-source sign-off gate closed correctly. |
| `glass-curtain-crossing.md` | An `evergreen` dossier with two-source corroboration. Demonstrates that operational assets can be evergreen while a dependent assessment is still working. |
| `weathervane.md` | A `working` dossier on a suspected double — illustrates `triggered_by` for offline tasking provenance and an investigation without confirmed evidence. |

---

### `assets/`

| File | Demonstrates |
|---|---|
| `nightingale.md` | `entity_type: informant` — the asset entity file, `evergreen`, with required `corroborated_by`/`corroborated_on`. |
| `magpie.md` | `entity_type: courier` — `working` curation: MAGPIE's reliability is assessed but not independently corroborated at source level. |

---

### `operations/`

| File | Demonstrates |
|---|---|
| `glass-curtain.md` | `owner: case officer CARTOGRAPHER` — the required `owner` field; `evergreen` operation with corroboration. |
| `amber-signal.md` | `working` operation — authorized in principle but on hold. Demonstrates an operation that cannot proceed until a tension is resolved. |

---

### `directives/`

| File | Demonstrates |
|---|---|
| `amber-exfil-go.md` | `decided_by` + `decided_on` required fields — the go/no-go decision record with rationale. Authorizes planning only; execution requires a second call after tension resolution. |

---

### `field-reports/`

Raw source-graded cables — the ingest layer. Field reports never promote to `evergreen`; they are
graded, referenced from assessments, and held as primary evidence.

| File | Grade | Demonstrates |
|---|---|---|
| `fr-014-nightingale-amber-genuine.md` | B2 | NIGHTINGALE reports AMBER is genuine. Primary source, higher-grade. Side A of the showcase tension. |
| `fr-021-magpie-amber-dangle.md` | C3 | MAGPIE reports AMBER is a Directorate dangle. Lower-grade but operationally significant. Side B of the showcase tension. The `[!contradiction]` callout marks it explicitly. |
| `fr-009-nightingale-curtain-watch.md` | B3 | NIGHTINGALE observes Directorate surveillance at GLASS CURTAIN crossing points. Demonstrates partial-confidence observation (B3 vs B2). |
| `fr-018-internal-anomaly-weathervane.md` | D4 | Internal counter-intelligence observation — not a field source, lower reliability (D4). Demonstrates the full Admiralty code range and honest grading of internal analysis. |
| `fr-022-cartographer-amber-signal-route.md` | A2 | CARTOGRAPHER route assessment from a completely reliable (A) Bureau officer. Second source for the `glass-curtain-integrity` evergreen assessment. |
| `fr-027-station-chief-amber-hold.md` | A1 | Station Chief hold directive — A1 (completely reliable, confirmed). Demonstrates self-confirming first-person source grading. |

---

### `assessments/`

| File | Demonstrates |
|---|---|
| `amber-bona-fides.md` | `working` + `single_source: true` — honest single-source declaration. The risk is labeled, not hidden. Cannot promote to evergreen until `amber-genuine-vs-dangle` is resolved. |
| `glass-curtain-integrity.md` | `evergreen` — two independent sources (NIGHTINGALE + CARTOGRAPHER) corroborated by the Deputy Station Chief. Demonstrates the full `corroborated_by` + `corroborated_on` promotion path. |

---

### `tensions/`

| File | Demonstrates |
|---|---|
| `amber-genuine-vs-dangle.md` | `temperature: 4`, `stakes: DECISION`, `kind: factual` — the showcase tension. Both sides are cited with their source and grade. The tension stays open; the system does not auto-resolve. Required H2s: Tension / Bridge / Cross-References. |

---

## The showcase tension

`fr-014-nightingale-amber-genuine.md` (NIGHTINGALE, B2) says AMBER is genuine.
`fr-021-magpie-amber-dangle.md` (MAGPIE, C3) says AMBER is a Directorate plant.

Both reports are filed. The contradiction is held in `tensions/amber-genuine-vs-dangle.md` as
a `factual` tension — one side must be wrong. Operation `amber-signal` is on hold. The
`amber-bona-fides` assessment is `working/single_source`. The system is waiting for analyst
arbitration, not for a coin flip.

This is what daftari is for.

## Seeding the showcase tension

The markdown is static; to see the tension live in daftari's graph, run the seed
(requires `npm run build` at the repo root first so `dist/` exists):

```bash
node examples/berlin-bureau/seed.mjs            # seeds a throwaway temp copy
node examples/berlin-bureau/seed.mjs /my/vault  # seeds an existing vault
```

It reindexes the vault, then logs the AMBER `genuine vs dangle` tension
(`factual`, unresolved) naming both field reports as sources — write → index →
log, in that order. Then inspect `.daftari/tensions.md`, or query
`vault_tension_clusters` / `vault_lint` to see it held open for arbitration.
