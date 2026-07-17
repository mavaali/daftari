---
title: "Schema Invalid"
domain: accumulation
collection: lint
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-05-01
updated_by: human:mihir
provenance: direct
sources: []
superseded_by: null
ttl_days: soon
tags: [lint, tier0]
---

# Schema Invalid

`ttl_days` is a string, not a number — the parse still succeeds (defaults to
null, so no staleness side effect) but the validation report flags it, which
is exactly what the tier-0 schemaInvalid check surfaces.
