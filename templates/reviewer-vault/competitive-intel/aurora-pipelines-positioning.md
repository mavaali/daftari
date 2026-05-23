---
title: "Aurora Pipelines — Positioning Overview"
domain: accumulation
collection: competitive-intel
status: canonical
confidence: high
created: 2026-02-12
updated: 2026-04-20
updated_by: agent:claude-code
provenance: synthesized
sources:
  - aurora-product-page-2026-q1
  - internal-aurora-positioning-deck
superseded_by: null
ttl_days: 120
tags: [aurora, ingestion, pipelines, competitive]
questions_answered:
  - "How does Aurora frame the ingestion-vs-transformation boundary?"
  - "What is Aurora's stance on managed connectors?"
questions_raised:
  - "How does Helios Connect frame the ingestion boundary?"
---

# Aurora Pipelines — Positioning Overview

Aurora Pipelines treats ingestion as an authored artifact: every source-to-sink
flow is a versioned, reviewed pipeline that lives alongside the rest of the
transformation graph. The pitch is that pipelines are code, not configuration,
and the same review discipline applied to transformation logic should apply
to data movement.

This sits in deliberate contrast to [Helios Connect](helios-connect-overview.md),
which bundles managed connectors into the control plane.

## Questions Answered
- How does Aurora frame the ingestion-vs-transformation boundary?
- What is Aurora's stance on managed connectors?

## Questions Raised
- How does Helios Connect frame the ingestion boundary?
