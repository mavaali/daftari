// Deterministic subgraph sampling for the cortex quality metric.
//
// Given a vault and a seed string, derive a small connected subgraph rooted at
// one "seed doc". The seed→doc mapping is stratified by collection so a vault
// with one dense collection cannot dominate every sample. From the seed we hop
// along four edge kinds — frontmatter `sources`, in-body markdown links, logged
// tensions, and `superseded_by` revision links — collecting neighbours until a
// node cap is reached. In Daftari's data model `sources:` holds external
// citation slugs (not in-vault paths), so the real in-vault doc→doc revision
// edge lives in `superseded_by:`, walked bidirectionally below.
//
// Pure given (vault state + seed): the same inputs always yield the same
// subgraph. All randomness is replaced by SHA-256 indexing over sorted inputs.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { readTextFile } from "../audit/readtext.js";
import { listTensions } from "../curation/tension.js";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { openIndexForActiveProvider } from "../tools/search.js";
import type { CortexEvalError, SubgraphEdge } from "./types.js";

export interface SubgraphOptions {
  maxNodes?: number; // default 5
}

export interface SubgraphNode {
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface Subgraph {
  seed_doc: string;
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
  // Code files reached via `describes` edges (#121), loaded only when the
  // target resolves inside the vault and is readable text. Kept SEPARATE from
  // `nodes` so they never enter the generator's citable-source set — the
  // answerer retrieves vault docs, not code. Grader context only.
  code_nodes: SubgraphNode[];
}

// Default cap on code-file size loaded as a code node — mirrors the audit's
// read-safety budget so a large generated/vendored file can't bloat a sample.
const CODE_NODE_MAX_BYTES = 256 * 1024;

export async function sampleSubgraph(
  vaultRoot: string,
  seed: string,
  opts: SubgraphOptions = {},
): Promise<Result<Subgraph, CortexEvalError>> {
  const maxNodes = opts.maxNodes ?? 5;
  const indexRes = openIndexForActiveProvider(vaultRoot);
  if (!indexRes.ok) {
    return err({ kind: "runtime", message: `vault index unavailable: ${indexRes.error.message}` });
  }
  const db = indexRes.value;

  let docs: { path: string; superseded_by: string | null }[];
  try {
    docs = db.prepare("SELECT path, superseded_by FROM documents").all() as {
      path: string;
      superseded_by: string | null;
    }[];
  } finally {
    db.close();
  }
  if (docs.length === 0) {
    return err({ kind: "runtime", message: "vault has no indexed documents" });
  }

  const strata = stratifyByCollection(docs.map((d) => d.path));
  const stratumNames = [...strata.keys()].sort();
  const stratumIdx = hashToIndex(`${seed}:stratum`, stratumNames.length);
  const stratumName = stratumNames[stratumIdx];
  const stratumDocs = [...(strata.get(stratumName) ?? [])].sort();
  const seedIdx = hashToIndex(`${seed}:doc`, stratumDocs.length);
  const seedDoc = stratumDocs[seedIdx];

  const visited = new Map<string, SubgraphNode>();
  const edges: SubgraphEdge[] = [];
  // Keyed by resolved vault-relative path; populated only for in-vault targets.
  const codeNodes = new Map<string, SubgraphNode>();

  const tensionsByDoc = await loadTensionEdges(vaultRoot);

  // Bidirectional supersede map, built from the already-materialized SQL rows
  // (no extra file reads). Bidirectional so a seed landing on EITHER the old or
  // the new doc reaches its counterpart.
  const supersededByDoc = new Map<string, Array<{ other: string }>>();
  for (const d of docs) {
    if (typeof d.superseded_by === "string" && d.superseded_by.length > 0) {
      pushTo(supersededByDoc, d.path, { other: d.superseded_by });
      pushTo(supersededByDoc, d.superseded_by, { other: d.path });
    }
  }

  // Bound code-node memory: at most `maxNodes` code bodies are loaded (each
  // already ≤ CODE_NODE_MAX_BYTES). All describes EDGES are still recorded, so a
  // doc binding thousands of files shows up as edges without loading every body
  // — the gap (describes-edge count vs code_nodes.length) is observable.
  const codeNodeCap = maxNodes;

  await loadNode(vaultRoot, seedDoc, visited);
  await walkHop(
    vaultRoot,
    seedDoc,
    visited,
    edges,
    tensionsByDoc,
    supersededByDoc,
    codeNodes,
    codeNodeCap,
  );
  const firstHopNeighbors = [...visited.keys()].filter((p) => p !== seedDoc);
  for (const n of firstHopNeighbors) {
    if (visited.size >= maxNodes) break;
    await walkHop(
      vaultRoot,
      n,
      visited,
      edges,
      tensionsByDoc,
      supersededByDoc,
      codeNodes,
      codeNodeCap,
    );
  }

  const nodes = trimToCap(seedDoc, visited, edges, maxNodes);
  const nodePaths = new Set(nodes.map((n) => n.path));

  // Retain only code nodes reached from a surviving doc node.
  const keptCodePaths = new Set(
    edges
      .filter((e) => e.kind === "describes" && nodePaths.has(e.from))
      .map((e) => describesTargetPath(e.to)),
  );
  const code_nodes = [...codeNodes.values()].filter((n) => keptCodePaths.has(n.path));

  return ok({
    seed_doc: seedDoc,
    nodes,
    edges: edges.filter((e) => keepEdge(e, nodePaths)),
    code_nodes,
  });
}

// An edge is kept when its `from` survived the node cap, and:
//  - for `link`/`tension`/`superseded` edges, the `to` is also a retained
//    in-vault node — these reference other vault documents, so a dangling
//    target means the neighbour was trimmed or never existed and the edge is
//    meaningless.
//  - for `sources` edges, the `to` is a provenance citation that is, by the
//    vault's frontmatter convention, an external source slug rather than an
//    in-vault `.md` path. Such an edge records real provenance off the seed
//    doc and is retained even though the cited source is not itself a node.
function keepEdge(e: SubgraphEdge, nodePaths: Set<string>): boolean {
  if (!nodePaths.has(e.from)) return false;
  // `sources` cites external slugs; `describes` cites code paths (possibly in an
  // external repo). Neither requires an in-vault `to` node — the edge records a
  // real relationship off a retained doc.
  if (e.kind === "sources" || e.kind === "describes") return true;
  return nodePaths.has(e.to);
}

// A `describes` entry is `[repo:]path[::symbol]`. The vault-relative candidate
// path is the entry with any `repo:` prefix and `::symbol` suffix stripped.
// (File-level in v1; the symbol is not resolved — mirrors the audit.)
function describesTargetPath(entry: string): string {
  const symbolIdx = entry.indexOf("::");
  const head = symbolIdx === -1 ? entry : entry.slice(0, symbolIdx);
  const colonIdx = head.indexOf(":");
  return (colonIdx === -1 ? head : head.slice(colonIdx + 1)).trim();
}

// Loads a `describes` target as a code node IFF it resolves to a readable text
// file inside the vault. External-repo targets (the common case) are recorded
// as edges with no node — cross-repo content loading in eval is deferred
// (Hold scope, #121). The read is guarded by the audit's read-safety util.
async function loadCodeNode(
  vaultRoot: string,
  entry: string,
  codeNodes: Map<string, SubgraphNode>,
  cap: number,
): Promise<void> {
  const relPath = describesTargetPath(entry);
  if (relPath.length === 0) return;
  if (codeNodes.has(relPath)) return;
  if (codeNodes.size >= cap) return; // memory bound; edge is still recorded
  const abs = resolve(vaultRoot, relPath);
  // Containment check: reject paths that escape the vault root.
  const rel = relative(vaultRoot, abs);
  if (rel.startsWith("..") || rel.length === 0) return;
  const read = await readTextFile(abs, { maxBytes: CODE_NODE_MAX_BYTES });
  if (!read.ok) return; // missing / external / binary / too-large → no node
  codeNodes.set(relPath, { path: relPath, body: read.value.text, frontmatter: {} });
}

async function loadTensionEdges(vaultRoot: string): Promise<Map<string, Array<{ other: string }>>> {
  const tensionsByDoc = new Map<string, Array<{ other: string }>>();
  const tensionsRes = await listTensions(vaultRoot);
  if (!tensionsRes.ok) return tensionsByDoc;
  for (const t of tensionsRes.value) {
    pushTo(tensionsByDoc, t.sourceA, { other: t.sourceB });
    pushTo(tensionsByDoc, t.sourceB, { other: t.sourceA });
  }
  return tensionsByDoc;
}

function stratifyByCollection(paths: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of paths) {
    const collection = p.split("/")[0] || "_root";
    pushTo(m, collection, p);
  }
  return m;
}

// Appends `value` to the array at `key`, creating the array on first use.
// Replaces the `map.get(key)!.push(...)` non-null-assertion idiom that biome's
// lint/style/noNonNullAssertion rule forbids.
function pushTo<V>(m: Map<string, V[]>, key: string, value: V): void {
  const arr = m.get(key);
  if (arr) arr.push(value);
  else m.set(key, [value]);
}

function hashToIndex(input: string, mod: number): number {
  if (mod <= 0) throw new Error("mod must be positive");
  const h = createHash("sha256").update(input).digest();
  const n = h.readUInt32BE(0);
  return n % mod;
}

// Loads a document's frontmatter + body into `visited`. Uses the project's
// canonical parser; on malformed YAML it falls back to empty frontmatter so the
// walk continues. A missing file is silently skipped.
async function loadNode(
  vaultRoot: string,
  path: string,
  visited: Map<string, SubgraphNode>,
): Promise<void> {
  if (visited.has(path)) return;
  let raw: string;
  try {
    raw = await readFile(resolve(vaultRoot, path), "utf8");
  } catch {
    return; // Missing doc — silently skip.
  }
  const parsed = parseDocument(raw);
  if (parsed.ok) {
    visited.set(path, { path, body: parsed.value.content, frontmatter: parsed.value.raw });
  } else {
    visited.set(path, { path, body: raw, frontmatter: {} });
  }
}

async function walkHop(
  vaultRoot: string,
  from: string,
  visited: Map<string, SubgraphNode>,
  edges: SubgraphEdge[],
  tensionsByDoc: Map<string, Array<{ other: string }>>,
  supersededByDoc: Map<string, Array<{ other: string }>>,
  codeNodes: Map<string, SubgraphNode>,
  codeNodeCap: number,
): Promise<void> {
  const node = visited.get(from);
  if (!node) return;

  const sources = Array.isArray(node.frontmatter.sources)
    ? (node.frontmatter.sources as unknown[])
    : [];
  for (const s of sources) {
    if (typeof s !== "string") continue;
    edges.push({ from, to: s, kind: "sources" });
    await loadNode(vaultRoot, s, visited);
  }

  // describes edges: doc-to-code bindings. The edge is always recorded; the
  // target is loaded as a code node only when it resolves inside the vault.
  const describes = Array.isArray(node.frontmatter.describes)
    ? (node.frontmatter.describes as unknown[])
    : [];
  for (const d of describes) {
    if (typeof d !== "string") continue;
    edges.push({ from, to: d, kind: "describes" });
    await loadCodeNode(vaultRoot, d, codeNodes, codeNodeCap);
  }

  const links = extractInVaultLinks(node.body);
  for (const l of links) {
    edges.push({ from, to: l, kind: "link" });
    await loadNode(vaultRoot, l, visited);
  }

  const tensions = tensionsByDoc.get(from) ?? [];
  for (const t of tensions) {
    edges.push({ from, to: t.other, kind: "tension" });
    await loadNode(vaultRoot, t.other, visited);
  }

  const superseded = supersededByDoc.get(from) ?? [];
  for (const s of superseded) {
    edges.push({ from, to: s.other, kind: "superseded" });
    await loadNode(vaultRoot, s.other, visited);
  }
}

function trimToCap(
  seed: string,
  visited: Map<string, SubgraphNode>,
  edges: SubgraphEdge[],
  cap: number,
): SubgraphNode[] {
  if (visited.size <= cap) return [...visited.values()];
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const ranked = [...visited.entries()]
    .map(([path, node]) => ({ path, node, degree: degree.get(path) ?? 0 }))
    .sort((a, b) => {
      if (a.path === seed) return -1;
      if (b.path === seed) return 1;
      // Higher degree wins; path tiebreak keeps the cut deterministic
      // independent of engine sort stability.
      return b.degree - a.degree || a.path.localeCompare(b.path);
    });
  return ranked.slice(0, cap).map((r) => r.node);
}

// Deliberately matches only standard markdown links to in-vault `.md` files —
// `[text](path.md)` / `[text](path.md#anchor)`, skipping web/mailto and
// absolute-rooted hrefs. Wiki-style `[[links]]` are not a Daftari vault
// convention and are intentionally unsupported.
function extractInVaultLinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[[^\]]*\]\(([^)]+\.md)(?:#[^)]*)?\)/g;
  for (const m of body.matchAll(re)) {
    const href = m[1];
    if (/^https?:|^mailto:/i.test(href)) continue;
    if (href.startsWith("/")) continue;
    out.push(href);
  }
  return out;
}
