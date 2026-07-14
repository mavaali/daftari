#!/usr/bin/env node
// Render the tension graph as Mermaid, nodes grouped by session provenance
// (the `session:*` tag each imported note carries). Demo artifact only — the
// vault's own render surface is the tensions.md ledger.
//
//   node render-graph.mjs [vaultRoot] > tension-graph.mmd

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { listTensions } from "../../dist/curation/tension.js";

const vaultRoot = resolve(process.argv[2] ?? "./vault");

const tensions = await listTensions(vaultRoot);
if (!tensions.ok) {
  console.error(tensions.error.message);
  process.exit(1);
}
const entries = tensions.value.filter((t) => !t.resolved);

// Node metadata from each note's frontmatter: session tag + title.
async function meta(rel) {
  try {
    const raw = await readFile(resolve(vaultRoot, rel), "utf-8");
    const session = raw.match(/session:(\w+)/)?.[1] ?? "unknown";
    let title = raw.match(/^title: (.+)$/m)?.[1]?.replace(/["']/g, "") ?? rel;
    // js-yaml folds long titles into block scalars ("title: >-\n  ...")
    if (title === ">-" || title === "|-") {
      title = raw.match(/^title: [>|]-\n\s+(.+)$/m)?.[1] ?? rel;
    }
    return { session, title: title.length > 46 ? `${title.slice(0, 44)}…` : title };
  } catch {
    return { session: "unknown", title: rel };
  }
}

const nodes = new Map(); // rel -> {id, session, title}
let n = 0;
async function nodeFor(rel) {
  if (!nodes.has(rel)) nodes.set(rel, { id: `n${n++}`, rel, ...(await meta(rel)) });
  return nodes.get(rel);
}

const edges = [];
for (const t of entries) {
  const a = await nodeFor(t.sourceA);
  const b = await nodeFor(t.sourceB);
  edges.push({ a: a.id, b: b.id, kind: t.kind });
}

const SESSION_ORDER = ["pricing", "ops", "support", "docs", "unknown"];
const bySession = new Map();
for (const node of nodes.values()) {
  if (!bySession.has(node.session)) bySession.set(node.session, []);
  bySession.get(node.session).push(node);
}

const lines = ["flowchart LR"];
for (const session of SESSION_ORDER) {
  const members = bySession.get(session);
  if (!members?.length) continue;
  lines.push(`  subgraph ${session}["session: ${session}"]`);
  for (const m of members) lines.push(`    ${m.id}["${m.title}"]`);
  lines.push("  end");
}
const STYLE = { factual: "===", temporal: "-.-", interpretive: "---" };
for (const e of edges) {
  const arrow = STYLE[e.kind] ?? "---";
  lines.push(`  ${e.a} ${arrow}|${e.kind}| ${e.b}`);
}
lines.push("");
lines.push("  %% factual ═══   temporal ┈┈┈   interpretive ───");
console.log(lines.join("\n"));
