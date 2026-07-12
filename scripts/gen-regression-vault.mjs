import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regenerates the Tier 1 retrieval fixture: a synthetic NATIVE-daftari-shape
// vault (one fact per file, single-topic, short single-chunk docs) plus its
// labeled query set. The committed output under test/regression/fixtures/ IS
// the fixture — this script exists so it can be regenerated and inspected,
// not because it runs in CI. Ported from
// integrations/recall-bench/gen-native-vault.mjs (paths de-hardcoded).
//
// Each doc carries three globally unique, field-ISOLATED tokens — one only in
// the title, one only in a tag, one only in the body — so a query for any
// token has exactly one correct doc. Tokens are zero-padded fixed width so no
// token is a prefix of another — the FTS MATCH builder appends `*` to every
// term (prefix match), and `tok7*` would otherwise also match `tok70`. With
// N=100 and 3-digit indices the index space is 000..099, so there are no
// 4-digit indices to collide with.
//
// Deterministic: everything derives from the doc index (no Math.random / Date).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "test/regression/fixtures/native-vault");
const VAULT = join(OUT, "vault");
const QFILE = join(OUT, "queries.jsonl");
const N = 100;

rmSync(OUT, { recursive: true, force: true });
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
writeFileSync(QFILE, `${queries.map((q) => JSON.stringify(q)).join("\n")}\n`);
console.log(`gen-regression-vault: ${N} docs -> ${VAULT}, ${queries.length} queries -> ${QFILE}`);
