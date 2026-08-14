// The `daftari view` HTTP server — a read-only browse portal over the vault.
// Uses node:http (the same choice `daftari serve` makes; no framework) and
// binds loopback only. Every request is checked against a Host allow-list to
// blunt DNS-rebinding: a loopback bind still answers a rebind request whose
// Host is the attacker's name, so the guard rejects anything but localhost.
//
// Read-only by construction: only GET is served, there are no mutation routes,
// and document bodies are rendered through the sanitizing pipeline.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeDecay } from "../curation/decay.js";
import { listTensions } from "../curation/tension.js";
import { buildReverseLinkMap, buildReverseSourceMap } from "../curation/tension-blast.js";
import type { LoadedDoc } from "../curation/vault-docs.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { vaultEdges } from "../tools/edges.js";
import { vaultSearch } from "../tools/search.js";
import { buildDocView, type DocView } from "./doc-view.js";
import { buildGraph, type GraphInput, type GraphOptions } from "./graph.js";
import {
  type DocBacklinkView,
  type DocBannerView,
  type DocTensionView,
  type IndexGroup,
  renderDashboardPage,
  renderDocPage,
  renderGraphPage,
  renderIndexPage,
  renderSearchPage,
  type SearchHitView,
} from "./pages.js";
import { escHtml, renderMarkdown } from "./render.js";
import { buildStatusView } from "./status-view.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// The graph library is vendored (templates/view/cytoscape.min.js), served from
// the local install — never hot-linked — and lazy-loaded only on /graph. Read
// once and cache in memory; the same file backs every request.
let cytoscapeAsset: string | null = null;
function cytoscapeJs(): string {
  if (cytoscapeAsset === null) {
    cytoscapeAsset = readFileSync(
      resolve(HERE, "..", "..", "templates", "view", "cytoscape.min.js"),
      "utf-8",
    );
  }
  return cytoscapeAsset;
}

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Loopback Host allow-list. A legitimate request to a loopback bind always
// carries a localhost Host; a rebind attack carries the attacker's name.
export function isAllowedHost(hostHeader: string | undefined): boolean {
  const name = String(hostHeader ?? "").replace(/:\d+$/, "");
  return ALLOWED_HOSTS.has(name);
}

export interface ViewResponse {
  status: number;
  contentType: string;
  body: string;
}

function html(status: number, body: string): ViewResponse {
  return { status, contentType: "text/html; charset=utf-8", body };
}

function json(status: number, value: unknown): ViewResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) };
}

function js(status: number, body: string): ViewResponse {
  return { status, contentType: "application/javascript; charset=utf-8", body };
}

// Collect the non-null epistemic banners the DTO carries into display banners,
// each tagged by kind so the page colors them distinctly. Every report follows
// the null-when-silent contract, so a fresh, healthy doc yields an empty array.
function docBanners(dto: DocView): DocBannerView[] {
  const banners: DocBannerView[] = [];
  if (dto.decay?.banner) banners.push({ kind: "decay", text: dto.decay.banner });
  if (dto.structural?.banner) banners.push({ kind: "structural", text: dto.structural.banner });
  if (dto.upstream_staleness?.banner)
    banners.push({ kind: "upstream", text: dto.upstream_staleness.banner });
  if (dto.anchors?.banner) banners.push({ kind: "anchor", text: dto.anchors.banner });
  if (dto.validity?.banner) banners.push({ kind: "validity", text: dto.validity.banner });
  return banners;
}

// A compact valid-time chip, when the document authors an interval.
function validityChip(dto: DocView): string | null {
  const v = dto.validity;
  if (!v || (v.from === null && v.until === null)) return null;
  return `${v.from ?? "…"} → ${v.until ?? "now"}`;
}

// Assemble the graph inputs from the loaded doc set and the vault's edge/tension
// stores — the same primitives the rest of the viewer and vault_backlinks use,
// so the graph cannot drift from them. Per-doc decay is the cheap pure
// computeDecay (not a full vault_read per node); contested pairs are open
// tensions; derives_from edges are the live (non-revoked) ones.
async function collectGraphInput(vaultRoot: string, docs: LoadedDoc[]): Promise<GraphInput> {
  const decayed = new Set<string>();
  for (const d of docs) {
    const state = computeDecay({
      status: d.frontmatter.status,
      confidence: d.frontmatter.confidence,
      updated: d.frontmatter.updated,
      created: d.frontmatter.created,
      ttl_days: d.frontmatter.ttl_days ?? null,
      superseded_by: d.frontmatter.superseded_by ?? null,
    });
    if (state) decayed.add(d.path);
  }

  const edgesRes = await vaultEdges(vaultRoot, {});
  const derivesEdges = edgesRes.ok
    ? edgesRes.value.edges
        .filter((e) => e.status !== "revoked")
        .map((e) => ({ from: e.fromPath, to: e.toPath }))
    : [];

  const tensionsRes = await listTensions(vaultRoot);
  const contestedPairs = tensionsRes.ok
    ? tensionsRes.value.filter((t) => !t.resolved).map((t) => ({ a: t.sourceA, b: t.sourceB }))
    : [];

  return {
    docs: docs.map((d) => ({
      path: d.path,
      title: d.frontmatter.title,
      collection: d.frontmatter.collection,
      tier: d.frontmatter.tier ?? null,
      status: d.frontmatter.status,
    })),
    reverseSource: buildReverseSourceMap(docs),
    reverseLink: buildReverseLinkMap(docs),
    derivesEdges,
    contestedPairs,
    decayed,
  };
}

// scope=all|ego, root=<vault path>, depth=<n> from the query string.
function parseGraphOptions(params: URLSearchParams | undefined): GraphOptions {
  const scope = params?.get("scope") === "ego" ? "ego" : "all";
  const rootRaw = params?.get("root");
  const depthRaw = params?.get("depth");
  const depth = depthRaw != null ? Number.parseInt(depthRaw, 10) : undefined;
  return {
    scope,
    root: rootRaw ? decodeURIComponent(rootRaw) : undefined,
    depth: depth !== undefined && Number.isFinite(depth) ? depth : undefined,
  };
}

// Resolve, render, and route one request. Pure over the vault's current state
// (no server object needed) so it is directly unit-testable.
export async function handleView(
  vaultRoot: string,
  req: { method?: string; path: string; host?: string; query?: string; params?: URLSearchParams },
): Promise<ViewResponse> {
  if (!isAllowedHost(req.host)) {
    return html(403, "<h1>403</h1><p>Host not allowed.</p>");
  }
  if ((req.method ?? "GET") !== "GET") {
    return html(405, "<h1>405</h1><p>The vault viewer is read-only.</p>");
  }

  // Vendored graph library, lazy-loaded by the /graph shell. Static, no vault
  // access needed.
  if (req.path === "/assets/cytoscape.min.js") {
    return js(200, cytoscapeJs());
  }

  // The graph shell: an HTML page that lazy-loads the library and renders
  // /api/graph client-side. The shell itself needs no doc load — the data comes
  // from the JSON endpoint (the B-seam) — so a large vault never blocks it.
  if (req.path === "/graph") {
    const opts = parseGraphOptions(req.params);
    return html(200, renderGraphPage(opts));
  }

  // Search runs against the hybrid index (which it builds on demand), not the
  // loaded doc set — handle it before loadDocuments so an empty query is cheap.
  if (req.path === "/search") {
    const query = (req.query ?? "").trim();
    if (query.length === 0) {
      return html(200, renderSearchPage("", []));
    }
    const result = await vaultSearch(vaultRoot, { query });
    if (!result.ok) {
      return html(500, `<h1>500</h1><p>${escHtml(result.error.message)}</p>`);
    }
    const hits: SearchHitView[] = result.value.hits.map((h) => ({
      path: h.path,
      title: h.title,
      collection: h.collection,
      snippet: h.snippet,
    }));
    return html(200, renderSearchPage(query, hits));
  }

  // The JSON data contract behind a document page (the B-seam): the same DTO
  // the HTML page renders from, so a future client app consumes it unchanged.
  if (req.path.startsWith("/api/doc/")) {
    const target = decodeURIComponent(req.path.slice("/api/doc/".length));
    const view = await buildDocView(vaultRoot, target);
    if (!view.ok) return json(500, { error: view.error.message });
    if (view.value === null) return json(404, { error: `no document at ${target}` });
    return json(200, view.value);
  }

  // The knowledge-graph JSON contract (the B-seam): the /graph client renders
  // this, and a future client app would consume it unchanged.
  if (req.path === "/api/graph") {
    const loaded = await loadDocuments(vaultRoot);
    if (!loaded.ok) return json(500, { error: loaded.error.message });
    const input = await collectGraphInput(vaultRoot, loaded.value);
    return json(200, buildGraph(input, parseGraphOptions(req.params)));
  }

  // The dashboard JSON contract (the B-seam): vault metrics + staleness +
  // open tensions + ratification queue + the sleep run-ledger trend.
  if (req.path === "/api/status") {
    const view = await buildStatusView(vaultRoot);
    if (!view.ok) return json(500, { error: view.error.message });
    return json(200, view.value);
  }

  // Home is the dashboard (R10), rendered from /api/status; the collection
  // index moves to /docs below.
  if (req.path === "/" || req.path === "") {
    const view = await buildStatusView(vaultRoot);
    if (!view.ok) return html(500, `<h1>500</h1><p>${escHtml(view.error.message)}</p>`);
    return html(200, renderDashboardPage(view.value));
  }

  if (req.path.startsWith("/doc/")) {
    const target = decodeURIComponent(req.path.slice("/doc/".length));
    const view = await buildDocView(vaultRoot, target);
    if (!view.ok) return html(500, `<h1>500</h1><p>${escHtml(view.error.message)}</p>`);
    if (view.value === null) {
      return html(404, `<h1>404</h1><p>No document at ${escHtml(target)}.</p>`);
    }
    const dto = view.value;
    const backlinks: DocBacklinkView[] = dto.backlinks.map((b) => ({ doc: b.doc, label: b.via }));
    const tensions: DocTensionView[] = dto.contested.map((c) => ({
      counterpart: c.counterpart,
      kind: c.kind,
      claimSelf: c.claimSelf,
      claimOther: c.claimOther,
      loggedAt: c.loggedAt,
    }));
    return html(
      200,
      renderDocPage({
        path: dto.path,
        frontmatter: {
          title: dto.frontmatter.title,
          collection: dto.frontmatter.collection,
          status: dto.frontmatter.status,
          confidence: dto.frontmatter.confidence,
          provenance: dto.frontmatter.provenance,
          tier: dto.frontmatter.tier ?? null,
          tags: dto.frontmatter.tags ?? [],
        },
        bodyHtml: renderMarkdown(dto.content),
        backlinks,
        tensions,
        banners: docBanners(dto),
        validity: validityChip(dto),
        decayLevel: dto.decay?.level ?? null,
        contestedCount: dto.contested.length,
      }),
    );
  }

  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) {
    return html(500, `<h1>500</h1><p>${escHtml(loaded.error.message)}</p>`);
  }
  const docs = loaded.value;

  if (req.path === "/docs") {
    const byCollection = new Map<string, IndexGroup["docs"]>();
    for (const d of docs) {
      const col = d.frontmatter.collection || "(uncategorized)";
      const list = byCollection.get(col) ?? [];
      list.push({
        path: d.path,
        title: d.frontmatter.title,
        status: d.frontmatter.status,
        confidence: d.frontmatter.confidence,
        tier: d.frontmatter.tier ?? null,
      });
      byCollection.set(col, list);
    }
    const groups: IndexGroup[] = [...byCollection.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([collection, entries]) => ({
        collection,
        docs: entries.sort((a, b) => (a.title || a.path).localeCompare(b.title || b.path)),
      }));
    return html(200, renderIndexPage(groups));
  }

  return html(404, "<h1>404</h1><p>Not found.</p>");
}

// Wrap handleView in an http.Server bound to `bind`/`port`.
export function createViewServer(vaultRoot: string): Server {
  return createServer((request, response) => {
    const url = request.url ?? "/";
    const parsed = new URL(url, "http://localhost");
    void handleView(vaultRoot, {
      method: request.method,
      path: parsed.pathname,
      query: parsed.searchParams.get("q") ?? undefined,
      params: parsed.searchParams,
      host: request.headers.host,
    }).then((res) => {
      response.writeHead(res.status, { "Content-Type": res.contentType });
      response.end(res.body);
    });
  });
}
