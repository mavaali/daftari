---
title: "Aurora Pipelines — Competitive Analysis (Vault B)"
domain: accumulation
collection: competitive-intel
status: canonical
confidence: high
created: 2026-05-30
updated: 2026-05-30
updated_by: agent:daftari-init
provenance: direct
sources:
  - aurora-product-page
superseded_by: null
ttl_days: 120
tags: [aurora, competitive, vault-b-fixture]
questions_answered:
  - "How does Aurora handle schema drift in live pipelines?"
questions_raised:
  - "Is Aurora's schema-lock model viable at enterprise scale?"
---

# Aurora Pipelines — Competitive Analysis (Vault B)

Aurora Pipelines (vault-b fixture) — distinct content to verify fan-out search
returns results from both vaults with the correct vault prefix in hit paths.

Aurora's schema-lock approach forces explicit migration scripts for every schema
change, unlike zero-copy ingestion competitors.

## Questions Answered
- How does Aurora handle schema drift in live pipelines?

## Questions Raised
- Is Aurora's schema-lock model viable at enterprise scale?
