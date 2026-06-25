import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Adapter: SQuAD v1.1 -> an article-level daftari vault for the Q1 generalization
// test. Each SQuAD article (~40 paragraphs) becomes ONE long multi-topic document
// so whole-doc BM25 dilutes and chunk-BM25 can recover — the exact mechanism the
// chunk-BM25 win rests on, here on an independent corpus with HUMAN queries.
//
// NEUTRAL frontmatter title ("Article NNNN") so neither retrieval arm gets a
// title shortcut: the comparison is purely body-chunk vs body-whole-doc. The real
// article's entity tokens live in the body (content_body / chunks), which the
// human questions match on — fair to both arms.
//
// Deterministic: stride sample of the questions, no randomness.

const SQUAD_URL = "https://rajpurkar.github.io/SQuAD-explorer/dataset/train-v1.1.json";
const CACHE = "/tmp/squad/train-v1.1.json";
const VAULT = "/tmp/squad/vault";
const QFILE = "/tmp/squad/queries.jsonl";
const TARGET_QUERIES = 1500;

mkdirSync("/tmp/squad", { recursive: true });

if (!existsSync(CACHE)) {
  const res = await fetch(SQUAD_URL);
  if (!res.ok) {
    console.error(`SQuAD download failed: ${res.status}`);
    process.exit(1);
  }
  writeFileSync(CACHE, await res.text());
}
const squad = JSON.parse(readFileSync(CACHE, "utf8"));
const articles = squad.data;
if (!Array.isArray(articles) || articles.length === 0) {
  console.error("SQuAD parse empty");
  process.exit(1);
}

rmSync(VAULT, { recursive: true, force: true });
mkdirSync(VAULT, { recursive: true });

const allQuestions = [];
articles.forEach((art, i) => {
  const ix = String(i).padStart(4, "0");
  const path = `squad-${ix}.md`;
  const body = art.paragraphs.map((p) => p.context).join("\n\n");
  const doc = `---
title: "Article ${ix}"
domain: accumulation
collection: squad
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-01-01
updated_by: "agent:squad-gen"
provenance: direct
sources: []
superseded_by: null
tags: [squad]
---

${body}
`;
  writeFileSync(join(VAULT, path), doc);
  for (const p of art.paragraphs) {
    for (const qa of p.qas) allQuestions.push({ id: qa.id, query: qa.question, relevantPath: path });
  }
});

const stride = Math.max(1, Math.floor(allQuestions.length / TARGET_QUERIES));
const sample = [];
for (let i = 0; i < allQuestions.length && sample.length < TARGET_QUERIES; i += stride) {
  sample.push(allQuestions[i]);
}

writeFileSync(QFILE, sample.map((q) => JSON.stringify(q)).join("\n") + "\n");
console.log(
  `gen-squad-vault: ${articles.length} articles -> ${VAULT}, ${sample.length} queries -> ${QFILE} (of ${allQuestions.length} total)`,
);
