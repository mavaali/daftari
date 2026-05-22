---
title: "Helios Connect — Managed-Connector Overview"
domain: accumulation
collection: competitive-intel
status: canonical
confidence: high
created: 2026-03-05
updated: 2026-05-08
updated_by: agent:claude-code
provenance: synthesized
sources:
  - helios-connect-launch-post-2026-03
  - helios-developer-docs
superseded_by: null
ttl_days: 120
tags: [helios, connect, ingestion, managed-connectors, competitive]
questions_answered:
  - "How does Helios Connect frame the ingestion boundary?"
  - "What is the pre-GA scope of Cirrus Realtime?"
questions_raised:
  - "Where does Helios Connect's pricing curve cross Aurora Pipelines once volume passes 10 TB/day?"
---

# Helios Connect — Managed-Connector Overview

Helios Connect is the managed-ingestion surface of Helios. Connectors are
declared as first-class control-plane objects: a YAML descriptor selects a
source, a sink, and a small set of typed parameters, and the platform owns
scheduling, retries, schema drift, and backpressure.

The framing is the inverse of [Aurora Pipelines](aurora-pipelines-positioning.md):
ingestion should *not* be an authored pipeline. It is a managed primitive that
teams compose, not author.

## Questions Answered
- How does Helios Connect frame the ingestion boundary?
- What is the pre-GA scope of Cirrus Realtime?

## Questions Raised
- Where does Helios Connect's pricing curve cross Aurora Pipelines once volume passes 10 TB/day?
