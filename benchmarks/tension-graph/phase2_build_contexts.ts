/**
 * Phase 2: build per-cell query contexts from REAL daftari retrieval.
 *
 * Stands up a THROWAWAY temp daftari vault (never the user's vault), writes the
 * corpus as daftari-native markdown (retrieval signal in the BODY, since daftari
 * indexes body+title not frontmatter triggers), indexes it with the real
 * reindexVault + hybridSearch, logs a tension per feud pair via addTension, and
 * emits contexts.jsonl. The Python panel replays those contexts unchanged, so the
 * agent/classifier/stats are identical to Phase 1 — only the substrate changed.
 *
 * Run from the daftari repo root:
 *   npx tsx benchmarks/tension-graph/phase2_build_contexts.ts \
 *     --src /tmp/tg_phase2_src --out benchmarks/tension-graph/results/phase2_contexts.jsonl
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import matter from "gray-matter";
import { reindexVault } from "../../src/search/reindex.js";
import { openIndexDb } from "../../src/storage/index-db.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { hybridSearch } from "../../src/search/hybrid.js";
import { addTension, listTensions } from "../../src/curation/tension.js";

const K = 6;

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}

function daftariFrontmatter(fields: Record<string, string>): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(fields.title)}`,
    "domain: accumulation",
    `collection: ${fields.collection}`,
    "status: canonical",
    "confidence: high",
    "created: 2026-07-04",
    "updated: 2026-07-04",
    "updated_by: agent:benchmark",
    "provenance: direct",
    "---",
    "",
  ];
  return lines.join("\n");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

async function main() {
  const srcDir = arg("src");
  const outPath = arg("out");
  const spec = JSON.parse(readFileSync(join(srcDir, "feuds.json"), "utf-8"));

  const vault = mkdtempSync(join(tmpdir(), "daftari-tg-phase2-"));
  console.error(`vault: ${vault}`);

  // 1. Base distractor bed -> daftari docs (title+body carried over from OKF).
  const baseDir = join(srcDir, "base");
  for (const f of walk(baseDir)) {
    const parsed = matter(readFileSync(f, "utf-8"));
    const title = String(parsed.data.title ?? parsed.data.id ?? relative(baseDir, f));
    const rel = relative(baseDir, f);
    const dest = join(vault, "base", rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, daftariFrontmatter({ title, collection: "base" }) + parsed.content.trim() + "\n");
  }

  // 2. Feud docs — retrieval signal in the BODY. A carries label + shared
  //    triggers (retrievable by the neutral label query); B carries only its
  //    divergent vocab (buried lexically; embeddings may still pull it up).
  const feudPaths: Record<string, { a: string; b: string; label: string }> = {};
  mkdirSync(join(vault, "feuds"), { recursive: true });
  for (const feud of spec.feuds) {
    const aRel = join("feuds", `${feud.a_id}.md`);
    const bRel = join("feuds", `${feud.b_id}.md`);
    const aBody =
      `# ${feud.label} — ${feud.side_a.slug}\n\n${feud.side_a.claim}\n\n` +
      `This standard governs ${feud.label}. Applies to: ${feud.shared_triggers.join(", ")}.\n`;
    const bBody =
      `# ${feud.side_b.slug} standard\n\n${feud.side_b.claim}\n\n` +
      `${feud.side_b.vocab.join(". ")}.\n`;
    writeFileSync(join(vault, aRel), daftariFrontmatter({ title: `${feud.label} (${feud.side_a.slug})`, collection: "feuds" }) + aBody);
    writeFileSync(join(vault, bRel), daftariFrontmatter({ title: `${feud.side_b.slug} standard`, collection: "feuds" }) + bBody);
    feudPaths[feud.topic] = { a: aRel, b: bRel, label: feud.label };
  }

  // 3. Index with real daftari.
  console.error("reindexing...");
  const reindexed = await reindexVault(vault);
  if (!reindexed.ok) throw reindexed.error;
  console.error(`indexed ${reindexed.value.documentCount} docs, ${reindexed.value.chunkCount} chunks, vector=${reindexed.value.vectorEnabled}`);

  // 4. Log a tension per feud pair.
  for (const feud of spec.feuds) {
    const fp = feudPaths[feud.topic];
    const r = await addTension(vault, {
      title: `${feud.label}: ${feud.side_a.slug} vs ${feud.side_b.slug}`,
      sourceA: fp.a, claimA: feud.side_a.claim,
      sourceB: fp.b, claimB: feud.side_b.claim,
      loggedBy: "agent:benchmark", kind: "interpretive",
    });
    if (!r.ok) throw r.error;
  }
  const tensionsRes = await listTensions(vault);
  if (!tensionsRes.ok) throw tensionsRes.error;
  const tensions = tensionsRes.value;

  // 5. Open index and build contexts per (topic, cell) from real hybridSearch.
  const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
  if (!opened.ok) throw opened.error;
  const db = opened.value;

  const records: unknown[] = [];
  let buriedCount = 0;
  for (const feud of spec.feuds) {
    const fp = feudPaths[feud.topic];
    const query = `What is the current governing rule for ${feud.label}?`;
    const res = await hybridSearch(db, query, { limit: K });
    if (!res.ok) throw res.error;
    const hits = res.value.hits;
    const paths = hits.map((h) => h.path);
    const docs = hits.map((h) => ({ id: h.path, title: h.title, snippet: h.snippet }));
    const buried = !paths.includes(fp.b);
    if (buried) buriedCount++;

    // Faithful tension lookup: any tension touching a RETRIEVED doc.
    const retrieved = new Set(paths);
    const touching = tensions.filter((t) => retrieved.has(t.sourceA) || retrieved.has(t.sourceB));
    const tensionRecords = touching.map((t) => ({
      doc_a: t.sourceA, claim_a: t.claimA, doc_b: t.sourceB, claim_b: t.claimB,
    }));
    const marker =
      tensionRecords.length > 0
        ? `[CONTESTED: ${tensionRecords[0].doc_a} says "${tensionRecords[0].claim_a}" vs ${tensionRecords[0].doc_b} says "${tensionRecords[0].claim_b}" — unresolved tension]`
        : null;

    for (const cell of ["daftari-no-tg", "daftari-tg-3a", "daftari-tg-3b"]) {
      records.push({
        cell, topic: feud.topic, query, buried,
        gold_a: fp.a, gold_b: fp.b,
        docs,
        inline_contested: cell === "daftari-tg-3b" ? marker : null,
        tension_records: cell === "daftari-tg-3a" ? tensionRecords : [],
        vector_used: res.value.vectorUsed,
      });
    }
  }
  db.close();

  writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.error(`wrote ${records.length} contexts (${spec.feuds.length} topics x 3 cells) to ${outPath}`);
  console.error(`daftari-substrate burial: ${buriedCount}/${spec.feuds.length} topics (B out of top-${K})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
