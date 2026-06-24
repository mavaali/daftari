import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Generates a synthetic NATIVE-daftari-shape vault: one fact per file,
// single-topic, short (single-chunk) docs. Each doc carries three globally
// unique, field-ISOLATED tokens — one only in the title, one only in a tag,
// one only in the body — so a query for any token has exactly one correct doc.
// This lets the regression runner measure, per query type, whether chunk-level
// BM25 (which indexes body chunks only) can still match title/tag terms.
//
// Tokens are zero-padded fixed width so no token is a prefix of another — the
// FTS MATCH builder appends `*` to every term (prefix match), and `tok7*`
// would otherwise also match `tok70`. With N=100 and 3-digit indices the index
// space is 000..099, so there are no 4-digit indices to collide with.
//
// Deterministic: everything derives from the doc index (no Math.random / Date).

const VAULT = "/tmp/native-regression/vault";
const QFILE = "/tmp/native-regression/queries.jsonl";
const N = 100;

rmSync("/tmp/native-regression", { recursive: true, force: true });
mkdirSync(VAULT, { recursive: true });

const queries = [];
for (let i = 0; i < N; i++) {
  const ix = String(i).padStart(3, "0");
  const titleTok = `titletok${ix}`;
  const tagTok = `tagtok${ix}`;
  const bodyTok = `bodytok${ix}`;
  const path = `native-${ix}.md`;
  const doc = `---
title: "Entity ${titleTok} quarterly note"
domain: accumulation
collection: native-regression
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: "agent:native-regression-gen"
provenance: direct
sources: []
superseded_by: null
tags: [${tagTok}, native]
---

This note records a single fact about ${bodyTok}. It captures one decision and a
short rationale, the kind of one-fact-per-file entry a native daftari vault holds.
`;
  writeFileSync(join(VAULT, path), doc);
  queries.push({ id: `q-${ix}-title`, type: "title", query: titleTok, relevantPath: path });
  queries.push({ id: `q-${ix}-tag`, type: "tag", query: tagTok, relevantPath: path });
  queries.push({ id: `q-${ix}-body`, type: "body", query: bodyTok, relevantPath: path });
}
writeFileSync(QFILE, queries.map((q) => JSON.stringify(q)).join("\n") + "\n");
console.log(`gen-native-vault: ${N} docs -> ${VAULT}, ${queries.length} queries -> ${QFILE}`);
