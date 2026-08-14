// The `daftari view` HTTP server — a read-only browse portal over the vault.
// Uses node:http (the same choice `daftari serve` makes; no framework) and
// binds loopback only. Every request is checked against a Host allow-list to
// blunt DNS-rebinding: a loopback bind still answers a rebind request whose
// Host is the attacker's name, so the guard rejects anything but localhost.
//
// Read-only by construction: only GET is served, there are no mutation routes,
// and document bodies are rendered through the sanitizing pipeline.

import { createServer, type Server } from "node:http";
import { loadDocuments } from "../curation/vault-docs.js";
import { vaultSearch } from "../tools/search.js";
import { buildDocView, type DocView } from "./doc-view.js";
import {
  type DocBacklinkView,
  type DocBannerView,
  type DocTensionView,
  type IndexGroup,
  renderDocPage,
  renderIndexPage,
  renderSearchPage,
  type SearchHitView,
} from "./pages.js";
import { escHtml, renderMarkdown } from "./render.js";

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

// Collect the non-null epistemic banners the DTO carries into display banners.
// Every report follows the null-when-silent contract, so a fresh, healthy doc
// yields an empty array (R4: nothing renders).
function docBanners(dto: DocView): DocBannerView[] {
  const banners: DocBannerView[] = [];
  if (dto.decay?.banner) banners.push({ level: "warn", text: dto.decay.banner });
  if (dto.structural?.banner) banners.push({ level: "warn", text: dto.structural.banner });
  if (dto.upstream_staleness?.banner)
    banners.push({ level: "warn", text: dto.upstream_staleness.banner });
  if (dto.anchors?.banner) banners.push({ level: "warn", text: dto.anchors.banner });
  if (dto.validity?.banner) banners.push({ level: "warn", text: dto.validity.banner });
  return banners;
}

// A compact valid-time chip, when the document authors an interval.
function validityChip(dto: DocView): string | null {
  const v = dto.validity;
  if (!v || (v.from === null && v.until === null)) return null;
  return `${v.from ?? "…"} → ${v.until ?? "now"}`;
}

// Resolve, render, and route one request. Pure over the vault's current state
// (no server object needed) so it is directly unit-testable.
export async function handleView(
  vaultRoot: string,
  req: { method?: string; path: string; host?: string; query?: string },
): Promise<ViewResponse> {
  if (!isAllowedHost(req.host)) {
    return html(403, "<h1>403</h1><p>Host not allowed.</p>");
  }
  if ((req.method ?? "GET") !== "GET") {
    return html(405, "<h1>405</h1><p>The vault viewer is read-only.</p>");
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
      }),
    );
  }

  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) {
    return html(500, `<h1>500</h1><p>${escHtml(loaded.error.message)}</p>`);
  }
  const docs = loaded.value;

  if (req.path === "/" || req.path === "") {
    const byCollection = new Map<string, { path: string; title: string }[]>();
    for (const d of docs) {
      const col = d.frontmatter.collection || "(uncategorized)";
      const list = byCollection.get(col) ?? [];
      list.push({ path: d.path, title: d.frontmatter.title });
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
      host: request.headers.host,
    }).then((res) => {
      response.writeHead(res.status, { "Content-Type": res.contentType });
      response.end(res.body);
    });
  });
}
