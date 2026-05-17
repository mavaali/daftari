---
title: "Databricks Lakeflow vs Data Factory"
domain: accumulation
collection: competitive-intel
status: canonical
confidence: high
created: 2026-03-12
updated: 2026-05-14
updated_by: agent:claude-code
provenance: synthesized
sources:
  - databricks-blog-2026-03-lakeflow-connect
  - internal-fabric-comparison-doc
superseded_by: null
ttl_days: 90
tags: [databricks, lakeflow, data-factory, etl, competitive]
---

# Databricks Lakeflow vs Data Factory

Lakeflow Connect bundles managed ingestion connectors directly into the
Databricks control plane. Data Factory keeps ingestion as a separate authored
pipeline artifact.

## Questions Answered
- Where does each product draw the boundary between ingestion and transformation?
- Which product treats connectors as first-class managed objects?

## Questions Raised
- How does Lakeflow pricing compare once ingestion volume scales past 10 TB/day?
