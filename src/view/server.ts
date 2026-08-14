// The `daftari view` HTTP server — a read-only browse portal over the vault.
// Uses node:http (the same choice `daftari serve` makes; no framework) and
// binds loopback only. Every request is checked against a Host allow-list to
// blunt DNS-rebinding: a loopback bind still answers a rebind request whose
// Host is the attacker's name, so the guard rejects anything but localhost.
//
// Read-only by construction: only GET is served, there are no mutation routes,
// and document bodies are rendered through the sanitizing pipeline.

import { createServer, type Server } from "node:http";
import { buildReverseLinkMap, buildReverseSourceMap } from "../curation/tension-blast.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { type DocBacklinkView, type IndexGroup, renderDocPage, renderIndexPage } from "./pages.js";
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

// Resolve, render, and route one request. Pure over the vault's current state
// (no server object needed) so it is directly unit-testable.
export async function handleView(
  vaultRoot: string,
  req: { method?: string; path: string; host?: string },
): Promise<ViewResponse> {
  if (!isAllowedHost(req.host)) {
    return html(403, "<h1>403</h1><p>Host not allowed.</p>");
  }
  if ((req.method ?? "GET") !== "GET") {
    return html(405, "<h1>405</h1><p>The vault viewer is read-only.</p>");
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

  if (req.path.startsWith("/doc/")) {
    const target = decodeURIComponent(req.path.slice("/doc/".length));
    const doc = docs.find((d) => d.path === target);
    if (!doc) {
      return html(404, `<h1>404</h1><p>No document at ${escHtml(target)}.</p>`);
    }
    // Doc-facet backlinks, inline from the same reverse maps vault_backlinks
    // uses (avoids re-loading the doc set for one lookup).
    const reverseSource = buildReverseSourceMap(docs);
    const reverseLink = buildReverseLinkMap(docs);
    const backlinks: DocBacklinkView[] = [];
    for (const b of reverseSource.get(doc.path) ?? []) backlinks.push({ doc: b, label: "source" });
    for (const b of reverseLink.get(doc.path) ?? []) backlinks.push({ doc: b, label: "link" });
    backlinks.sort((a, b) => a.doc.localeCompare(b.doc) || a.label.localeCompare(b.label));

    return html(
      200,
      renderDocPage({
        path: doc.path,
        frontmatter: {
          title: doc.frontmatter.title,
          collection: doc.frontmatter.collection,
          status: doc.frontmatter.status,
          confidence: doc.frontmatter.confidence,
          provenance: doc.frontmatter.provenance,
          tier: doc.frontmatter.tier ?? null,
          tags: doc.frontmatter.tags ?? [],
        },
        bodyHtml: renderMarkdown(doc.content),
        backlinks,
      }),
    );
  }

  return html(404, "<h1>404</h1><p>Not found.</p>");
}

// Wrap handleView in an http.Server bound to `bind`/`port`.
export function createViewServer(vaultRoot: string): Server {
  return createServer((request, response) => {
    const url = request.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    void handleView(vaultRoot, {
      method: request.method,
      path,
      host: request.headers.host,
    }).then((res) => {
      response.writeHead(res.status, { "Content-Type": res.contentType });
      response.end(res.body);
    });
  });
}
