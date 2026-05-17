---
title: "Aurora Pipelines vs Helios Connect"
domain: accumulation
collection: competitive-intel
status: canonical
confidence: high
created: 2026-03-12
updated: 2026-05-14
updated_by: agent:claude-code
provenance: synthesized
sources:
  - helios-blog-2026-03-connect-launch
  - internal-aurora-comparison-doc
superseded_by: null
ttl_days: 90
tags: [aurora, helios, ingestion, etl, competitive]
---

# Aurora Pipelines vs Helios Connect

Helios Connect bundles managed ingestion connectors directly into the Helios
control plane. Aurora Pipelines keeps ingestion as a separate authored pipeline
artifact.

## Questions Answered
- Where does each product draw the boundary between ingestion and transformation?
- Which product treats connectors as first-class managed objects?

## Questions Raised
- How does Helios Connect pricing compare once ingestion volume scales past 10 TB/day?
