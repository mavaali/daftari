// Pure HTML page builders for `daftari view`. No IO, no server state — each
// takes plain data and returns an HTML string, so the pages are unit-testable
// without a running server. Every interpolated value is escaped (escHtml) or
// pre-sanitized (renderMarkdown for the doc body).
//
// The visual system is epistemic-first: a document's STANDING (status,
// confidence, tier, decay, contested) is the loudest thing on the page — a
// colored instrument strip, not grey metadata — because that standing is what
// the vault knows and a plain reader cannot show. Semantic colors: green =
// strong (high / canonical / fresh), amber = caution (medium / aging), red =
// weak/hazard (low / warn / deprecated), maroon accent = contested.

import type { GraphOptions } from "./graph.js";
import { escHtml, type TocEntry } from "./render.js";
import type { StatusView } from "./status-view.js";

const CSS = `
:root { color-scheme: light dark;
  --bg:#f6f3ee; --surface:#fff; --surface-2:#faf8f4; --border:#e2ddd4; --border-2:#d0cabd;
  --text:#20211f; --muted:#6b6b6b; --accent:#b11f4b; --accent-soft:rgba(177,31,75,.08);
  --link:#0a66c2; --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  --good:#15803d; --good-bg:rgba(21,128,61,.10);
  --warn:#b45309; --warn-bg:rgba(180,83,9,.10);
  --bad:#c2410c; --bad-bg:rgba(194,65,12,.10);
  --dim:#8a8a8a; --dim-bg:rgba(138,138,138,.12); }
@media (prefers-color-scheme: dark) { :root {
  --bg:#232322; --surface:#2c2c2b; --surface-2:#313130; --border:#42423f; --border-2:#565652;
  --text:#e6e3dc; --muted:#9a988f; --accent:#fd8ea1; --accent-soft:rgba(253,142,161,.12);
  --link:#69b3ff;
  --good:#4ade80; --good-bg:rgba(74,222,128,.14);
  --warn:#fbbf24; --warn-bg:rgba(251,191,36,.14);
  --bad:#fb923c; --bad-bg:rgba(251,146,60,.14);
  --dim:#8f8d86; --dim-bg:rgba(143,141,134,.16); } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text);
  font-family:-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.55; }
.wrap { max-width:920px; margin:0 auto; padding:20px 22px 90px; }
a { color:var(--link); text-decoration:none; } a:hover { text-decoration:underline; }
h1 { line-height:1.2; font-size:26px; margin:10px 0 14px; letter-spacing:-.01em; }
h2 { line-height:1.25; }

/* top bar */
.topbar { display:flex; align-items:center; gap:16px; margin:0 0 20px;
  padding-bottom:12px; border-bottom:1px solid var(--border); }
.brand { font-weight:800; color:var(--accent); font-size:14px; letter-spacing:.02em;
  font-family:var(--mono); }
.topbar form { margin-left:auto; }
.topbar input { font-size:13px; padding:6px 11px; border:1px solid var(--border-2);
  border-radius:8px; background:var(--surface); color:var(--text); width:240px; }

/* standing strip — the epistemic hero */
.standing { display:flex; flex-wrap:wrap; align-items:center; gap:10px 12px;
  background:var(--surface); border:1px solid var(--border); border-radius:12px;
  padding:12px 16px; margin:0 0 16px; }
.badge { font-family:var(--mono); font-size:11px; font-weight:700; letter-spacing:.03em;
  text-transform:uppercase; padding:3px 9px; border-radius:6px; border:1px solid transparent; }
.badge.solid-good { background:var(--good-bg); color:var(--good); border-color:var(--good); }
.badge.out-dim { color:var(--dim); border-color:var(--border-2); }
.badge.solid-bad { background:var(--bad-bg); color:var(--bad); border-color:var(--bad); }
.meter { display:inline-flex; align-items:center; gap:7px; }
.meter .label { font-family:var(--mono); font-size:10px; text-transform:uppercase;
  letter-spacing:.05em; color:var(--muted); }
.meter .bars { display:inline-flex; gap:3px; }
.meter .seg { width:16px; height:7px; border-radius:2px; background:var(--dim-bg); }
.meter .seg.on-good { background:var(--good); } .meter .seg.on-warn { background:var(--warn); }
.meter .seg.on-bad { background:var(--bad); }
.chip { font-family:var(--mono); font-size:11px; padding:3px 9px; border-radius:6px;
  display:inline-flex; align-items:center; gap:5px; }
.chip.good { background:var(--good-bg); color:var(--good); }
.chip.warn { background:var(--warn-bg); color:var(--warn); }
.chip.bad  { background:var(--bad-bg);  color:var(--bad); }
.chip.dim  { background:var(--dim-bg);  color:var(--muted); }
.chip.contested { background:var(--accent-soft); color:var(--accent); font-weight:700; }
.dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:0 0 auto; }
.dot.good{background:var(--good);} .dot.warn{background:var(--warn);}
.dot.bad{background:var(--bad);} .dot.dim{background:var(--dim);}
.spacer { flex:1 1 auto; }
.tier { font-family:var(--mono); font-size:11px; color:var(--muted); }
.graphlink { margin:0 0 14px; font-size:13px; }
.toc { background:var(--surface-2); border:1px solid var(--border); border-radius:10px;
  padding:10px 16px; margin:0 0 16px; }
.toc h2 { font-size:11px; font-family:var(--mono); text-transform:uppercase; letter-spacing:.04em;
  color:var(--muted); margin:0 0 6px; }
.toc ul { list-style:none; margin:0; padding:0; }
.toc li { padding:2px 0; font-size:13px; }
.toc li.d2 { padding-left:14px; } .toc li.d3 { padding-left:28px; font-size:12px; }
.body :is(h1,h2,h3) { scroll-margin-top:12px; }
.tags { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 16px; }
.tag { font-family:var(--mono); font-size:11px; color:var(--muted);
  border:1px solid var(--border); border-radius:20px; padding:1px 9px; }

/* epistemic banners — differentiated by kind */
.banner { display:flex; gap:10px; align-items:flex-start; border-radius:10px;
  padding:10px 14px; margin:0 0 10px; font-size:13px; border:1px solid var(--border);
  border-left-width:4px; background:var(--surface-2); }
.banner .bk { font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:.05em;
  text-transform:uppercase; padding-top:2px; flex:0 0 auto; }
.banner.bad  { border-left-color:var(--bad); } .banner.bad .bk { color:var(--bad); }
.banner.warn { border-left-color:var(--warn);} .banner.warn .bk { color:var(--warn); }

/* contested panel */
.tensions { border:1px solid var(--accent); border-left-width:4px; border-radius:10px;
  padding:12px 16px; margin:0 0 16px; background:var(--accent-soft); }
.tensions h2 { font-size:13px; color:var(--accent); margin:0 0 8px; font-family:var(--mono);
  text-transform:uppercase; letter-spacing:.04em; }
.tensions ul { list-style:none; margin:0; padding:0; }
.tensions li { padding:8px 0; border-top:1px solid var(--border); font-size:13px; }
.tensions li:first-child { border-top:none; }
.tensions .claim { color:var(--muted); margin-top:3px; }
.tensions .k { font-family:var(--mono); font-size:11px; }

/* body */
.body { background:var(--surface); border:1px solid var(--border); border-radius:12px;
  padding:22px 26px; overflow-wrap:anywhere; }
.body h1,.body h2,.body h3 { margin-top:1.4em; }
.body pre { background:#1c1c1c; color:#e2e2e2; padding:12px 14px; border-radius:8px; overflow:auto; }
.body code { background:var(--dim-bg); padding:1px 5px; border-radius:4px; font-size:.92em; }
.body pre code { background:none; padding:0; }
.body blockquote { border-left:3px solid var(--border-2); margin:0; padding-left:14px; color:var(--muted); }

/* backlinks */
.backlinks { margin-top:22px; }
.backlinks h2 { font-size:12px; color:var(--muted); font-family:var(--mono);
  text-transform:uppercase; letter-spacing:.04em; }
.backlinks ul { list-style:none; margin:0; padding:0; }
.backlinks li { padding:5px 0; font-size:13px; display:flex; gap:8px; align-items:center; }

/* index — a knowledge map, not a link wall */
.collection { margin:26px 0 4px; font-size:11px; letter-spacing:.06em; font-family:var(--mono);
  text-transform:uppercase; color:var(--muted); }
ul.docs { list-style:none; margin:0; padding:0; }
ul.docs li { display:flex; align-items:center; gap:10px; padding:7px 4px;
  border-bottom:1px solid var(--border); }
ul.docs .std { display:inline-flex; align-items:center; gap:5px; flex:0 0 auto; width:74px; }
ul.docs .title { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
ul.docs .cf { font-family:var(--mono); font-size:10px; color:var(--muted); flex:0 0 auto; }

/* search results */
.results { list-style:none; margin:0; padding:0; }
.results li { padding:12px 0; border-bottom:1px solid var(--border); }
.results .snippet { color:var(--muted); font-size:13px; margin-top:3px; }
.results .meta { font-family:var(--mono); font-size:10px; color:var(--muted);
  text-transform:uppercase; letter-spacing:.04em; }
.empty { color:var(--muted); font-size:13px; }

/* graph */
.gtools { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin:0 0 8px; font-size:13px; }
.gtools label { font-family:var(--mono); font-size:11px; color:var(--muted); }
.gtools select { font-size:13px; padding:4px 8px; border:1px solid var(--border-2);
  border-radius:7px; background:var(--surface); color:var(--text); }
.ginfo { font-size:12px; color:var(--muted); margin:0 0 8px; min-height:15px; }
#cy { width:100%; height:72vh; background:var(--surface); border:1px solid var(--border);
  border-radius:12px; }
.legend { display:flex; gap:16px; flex-wrap:wrap; font-family:var(--mono); font-size:11px;
  color:var(--muted); margin:10px 0 0; }
.legend .sw { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px;
  vertical-align:middle; }
.legend .ln { display:inline-block; width:16px; height:0; border-top:3px solid; margin-right:5px;
  vertical-align:middle; }

/* topbar nav */
.nav { display:flex; gap:14px; margin-left:18px; }
.nav a { font-family:var(--mono); font-size:12px; color:var(--muted); }
.nav a:hover { color:var(--link); }

/* dashboard */
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:0 0 20px; }
.tile { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px 16px; }
.tile .num { font-size:28px; font-weight:700; letter-spacing:-.02em; }
.tile .lbl { font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.04em;
  color:var(--muted); margin-top:2px; }
.tile a { display:block; }
.tile.alert .num { color:var(--accent); }
.panel { background:var(--surface); border:1px solid var(--border); border-radius:12px;
  padding:14px 18px; margin:0 0 16px; }
.panel h2 { font-size:12px; font-family:var(--mono); text-transform:uppercase; letter-spacing:.04em;
  color:var(--muted); margin:0 0 10px; }
.sbar { display:flex; height:14px; border-radius:7px; overflow:hidden; background:var(--dim-bg); }
.sbar span { display:block; }
.sbar .fresh { background:var(--good); } .sbar .aging { background:var(--warn); }
.sbar .stale { background:var(--bad); }
.sbar-key { display:flex; gap:16px; margin-top:8px; font-family:var(--mono); font-size:11px; color:var(--muted); }
.sbar-key .sw { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; vertical-align:middle; }
.runs { list-style:none; margin:0; padding:0; }
.runs li { display:flex; gap:10px; align-items:baseline; padding:5px 0; border-top:1px solid var(--border); font-size:13px; }
.runs li:first-child { border-top:none; }
.runs .kind { font-family:var(--mono); font-size:11px; color:var(--muted); min-width:96px; }
.runs .when { color:var(--muted); font-size:12px; }
`;

function searchBox(query = ""): string {
  return `<form class="search" action="/search" method="get">
<input type="search" name="q" placeholder="Search the vault…" value="${escHtml(query)}" autocomplete="off"></form>`;
}

export function layout(title: string, bodyHtml: string, query = ""): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title><style>${CSS}</style></head>
<body><div class="wrap"><div class="topbar"><a class="brand" href="/">daftari · vault</a>` +
    `<nav class="nav"><a href="/docs">documents</a><a href="/graph">graph</a></nav>` +
    `${searchBox(query)}</div>${bodyHtml}</div></body></html>`
  );
}

// --- epistemic visual vocabulary ---------------------------------------------

// Confidence → a 3-segment meter (low=1 red, medium=2 amber, high=3 green).
function confidenceMeter(conf: string): string {
  const rank = conf === "high" ? 3 : conf === "medium" ? 2 : 1;
  const tone = conf === "high" ? "good" : conf === "medium" ? "warn" : "bad";
  const segs = [1, 2, 3]
    .map((i) => `<span class="seg${i <= rank ? ` on-${tone}` : ""}"></span>`)
    .join("");
  return `<span class="meter" title="confidence: ${escHtml(conf)}"><span class="label">conf</span><span class="bars">${segs}</span></span>`;
}

// Status → a badge: canonical is solid-strong, draft is an outline, a retired
// state (deprecated/superseded/archived) is solid-bad.
function statusBadge(status: string): string {
  const cls = status === "canonical" ? "solid-good" : status === "draft" ? "out-dim" : "solid-bad";
  return `<span class="badge ${cls}">${escHtml(status)}</span>`;
}

function tierTag(tier: string | null): string {
  return `<span class="tier">tier: ${escHtml(tier ?? "—")}</span>`;
}

// Decay level → a colored chip. Null = fresh, rendered as a quiet good chip so
// the healthy state is legible too (not merely the absence of a warning).
function decayChip(level: string | null): string {
  if (level === null) return `<span class="chip good"><span class="dot good"></span>fresh</span>`;
  const tone = level === "aging" ? "warn" : "bad";
  return `<span class="chip ${tone}"><span class="dot ${tone}"></span>${escHtml(level)}</span>`;
}

// --- doc page ----------------------------------------------------------------

export interface DocFrontmatterView {
  title: string;
  collection: string;
  status: string;
  confidence: string;
  provenance: string;
  tier: string | null;
  tags: string[];
}

export interface DocBacklinkView {
  doc: string;
  label: string; // e.g. "source" | "link" | describes raw
}

export interface DocTensionView {
  counterpart: string;
  kind: string;
  claimSelf: string;
  claimOther: string;
  loggedAt: string;
}

export type DocBannerKind = "decay" | "structural" | "upstream" | "anchor" | "validity";

export interface DocBannerView {
  kind: DocBannerKind;
  text: string;
}

const BANNER_META: Record<DocBannerKind, { label: string; tone: "bad" | "warn" }> = {
  decay: { label: "decay", tone: "bad" },
  structural: { label: "structure", tone: "warn" },
  upstream: { label: "upstream", tone: "warn" },
  anchor: { label: "pins", tone: "bad" },
  validity: { label: "validity", tone: "bad" },
};

export function renderDocPage(args: {
  path: string;
  frontmatter: DocFrontmatterView;
  bodyHtml: string;
  backlinks: DocBacklinkView[];
  tensions?: DocTensionView[];
  banners?: DocBannerView[];
  validity?: string | null;
  decayLevel?: string | null; // DecayState.level, or null when fresh
  contestedCount?: number;
  toc?: TocEntry[];
}): string {
  const fm = args.frontmatter;
  const contested = args.contestedCount ?? args.tensions?.length ?? 0;
  const standing =
    `<div class="standing">` +
    statusBadge(fm.status) +
    confidenceMeter(fm.confidence) +
    decayChip(args.decayLevel ?? null) +
    (contested > 0 ? `<span class="chip contested">⚔ contested×${contested}</span>` : "") +
    (args.validity ? `<span class="chip dim">valid ${escHtml(args.validity)}</span>` : "") +
    `<span class="spacer"></span>` +
    `<span class="chip dim">${escHtml(fm.provenance)}</span>` +
    tierTag(fm.tier) +
    `</div>`;
  const tags =
    fm.tags.length > 0
      ? `<div class="tags">${fm.tags.map((t) => `<span class="tag">${escHtml(t)}</span>`).join("")}</div>`
      : "";
  const banners = (args.banners ?? [])
    .map((b) => {
      const m = BANNER_META[b.kind];
      return `<div class="banner ${m.tone}"><span class="bk">${escHtml(m.label)}</span><span>${escHtml(b.text)}</span></div>`;
    })
    .join("");
  const tensions = args.tensions ?? [];
  const tensionsPanel =
    tensions.length === 0
      ? ""
      : `<div class="tensions"><h2>⚔ Contested</h2><ul>${tensions
          .map(
            (t) =>
              `<li><span class="chip contested">${escHtml(t.kind)}</span> vs ` +
              `<a href="/doc/${encodeURI(t.counterpart)}">${escHtml(t.counterpart)}</a>` +
              `<div class="claim"><span class="k">this</span> — ${escHtml(t.claimSelf)}</div>` +
              `<div class="claim"><span class="k">other</span> — ${escHtml(t.claimOther)}</div></li>`,
          )
          .join("")}</ul></div>`;
  const backlinks =
    args.backlinks.length === 0
      ? `<p class="empty">No documents reference this one.</p>`
      : `<ul>${args.backlinks
          .map(
            (b) =>
              `<li><a href="/doc/${encodeURI(b.doc)}">${escHtml(b.doc)}</a> <span class="tag">${escHtml(b.label)}</span></li>`,
          )
          .join("")}</ul>`;
  // R7: walk this document's neighborhood in the knowledge graph.
  const graphLink =
    `<div class="graphlink"><a href="/graph?scope=ego&root=${encodeURI(args.path)}&depth=2">` +
    `◧ neighborhood graph →</a></div>`;
  // R11: a table of contents, shown only when the body has enough structure to
  // warrant one. Headings carry matching ids (added by renderDocBody).
  const toc = args.toc ?? [];
  const tocPanel =
    toc.length >= 3
      ? `<nav class="toc"><h2>On this page</h2><ul>${toc
          .map(
            (t) =>
              `<li class="d${t.depth}"><a href="#${encodeURI(t.id)}">${escHtml(t.text)}</a></li>`,
          )
          .join("")}</ul></nav>`
      : "";
  const body =
    `<h1>${escHtml(fm.title || args.path)}</h1>` +
    standing +
    graphLink +
    tags +
    banners +
    tensionsPanel +
    tocPanel +
    `<div class="body">${args.bodyHtml}</div>` +
    `<div class="backlinks"><h2>Backlinks</h2>${backlinks}</div>`;
  return layout(fm.title || args.path, body);
}

// --- index -------------------------------------------------------------------

export interface IndexEntry {
  path: string;
  title: string;
  status?: string;
  confidence?: string;
  tier?: string | null;
}
export interface IndexGroup {
  collection: string;
  docs: IndexEntry[];
}

// A per-row standing glance: a status dot + a confidence dot, so a reader
// scans standing down the column instead of reading a wall of identical links.
function statusDot(status?: string): string {
  const tone =
    status === "canonical" ? "good" : status === "draft" ? "dim" : status ? "bad" : "dim";
  return `<span class="dot ${tone}" title="status: ${escHtml(status ?? "—")}"></span>`;
}
function confidenceDot(conf?: string): string {
  const tone = conf === "high" ? "good" : conf === "medium" ? "warn" : conf ? "bad" : "dim";
  return `<span class="dot ${tone}" title="confidence: ${escHtml(conf ?? "—")}"></span>`;
}

export function renderIndexPage(groups: IndexGroup[]): string {
  if (groups.length === 0) {
    return layout("Vault", `<h1>Vault</h1><p class="empty">No documents found.</p>`);
  }
  const sections = groups
    .map((g) => {
      const items = g.docs
        .map(
          (d) =>
            `<li><span class="std">${statusDot(d.status)}${confidenceDot(d.confidence)}</span>` +
            `<span class="title"><a href="/doc/${encodeURI(d.path)}">${escHtml(d.title || d.path)}</a></span>` +
            `<span class="cf">${escHtml(d.status ?? "")}</span></li>`,
        )
        .join("");
      return `<div class="collection">${escHtml(g.collection)}</div><ul class="docs">${items}</ul>`;
    })
    .join("");
  return layout("Vault", `<h1>Vault</h1>${sections}`);
}

// --- search ------------------------------------------------------------------

export interface SearchHitView {
  path: string;
  title: string;
  collection: string;
  snippet: string;
}

export function renderSearchPage(query: string, hits: SearchHitView[]): string {
  const q = query.trim();
  if (q.length === 0) {
    return layout("Search", `<h1>Search</h1><p class="empty">Type a query above.</p>`);
  }
  const body =
    hits.length === 0
      ? `<h1>Search</h1><p class="empty">No results for “${escHtml(q)}”.</p>`
      : `<h1>Search</h1><ul class="results">${hits
          .map(
            (h) =>
              `<li><a href="/doc/${encodeURI(h.path)}">${escHtml(h.title || h.path)}</a>` +
              `<div class="meta">${escHtml(h.collection)}</div>` +
              `<div class="snippet">${escHtml(h.snippet)}</div></li>`,
          )
          .join("")}</ul>`;
  return layout("Search", body, q);
}

// --- graph -------------------------------------------------------------------

// The graph client is fully static (no server data is interpolated): it reads
// the current query string and fetches /api/graph, so the same script serves
// whole-vault and ego views. Kept as vanilla JS — the one lazy-loaded library
// (cytoscape) is the only client dependency, and only on this route.
const GRAPH_CLIENT_JS = `
(function () {
  var COL = { canonical:'#15803d', draft:'#8a8a8a', retired:'#c2410c',
    contested:'#b11f4b', decayed:'#b45309', derives:'#0a66c2', edge:'#c9c1b4' };
  var info = document.getElementById('ginfo');
  fetch('/api/graph' + (location.search || '')).then(function (r) { return r.json(); }).then(function (g) {
    if (!g.nodes || g.nodes.length === 0) { info.textContent = 'No documents to graph.'; return; }
    if (g.truncated) {
      info.textContent = 'Showing ' + g.shown + ' of ' + g.total + ' documents (most-connected shown).';
    } else {
      info.textContent = g.shown + ' documents, ' + g.edges.length + ' links.';
    }
    var els = [];
    var statuses = {}, collections = {};
    for (var i = 0; i < g.nodes.length; i++) {
      var n = g.nodes[i];
      statuses[n.status] = 1; collections[n.collection] = 1;
      els.push({ data: { id: n.path, label: n.title || n.path, status: n.status,
        decayed: !!n.decayed, contested: !!n.contested, collection: n.collection } });
    }
    for (var j = 0; j < g.edges.length; j++) {
      var e = g.edges[j];
      els.push({ data: { source: e.from, target: e.to, kind: e.kind } });
    }
    var cy = cytoscape({
      container: document.getElementById('cy'),
      elements: els,
      style: [
        { selector: 'node', style: { 'label': 'data(label)', 'font-size': 7, 'width': 16, 'height': 16,
          'background-color': COL.draft, 'color': '#6b6b6b', 'text-wrap': 'ellipsis', 'text-max-width': 90,
          'text-valign': 'bottom', 'text-margin-y': 2, 'border-width': 0, 'min-zoomed-font-size': 6 } },
        { selector: 'node[status="canonical"]', style: { 'background-color': COL.canonical } },
        { selector: 'node[status="draft"]', style: { 'background-color': COL.draft } },
        { selector: 'node[status="deprecated"]', style: { 'background-color': COL.retired } },
        { selector: 'node[status="superseded"]', style: { 'background-color': COL.retired } },
        { selector: 'node[status="archived"]', style: { 'background-color': COL.retired } },
        { selector: 'node[?decayed]', style: { 'border-width': 3, 'border-color': COL.decayed, 'border-style': 'dashed' } },
        { selector: 'node[?contested]', style: { 'border-width': 4, 'border-color': COL.contested, 'border-style': 'solid' } },
        { selector: 'edge', style: { 'width': 1.2, 'line-color': COL.edge, 'curve-style': 'bezier',
          'target-arrow-color': COL.edge, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7 } },
        { selector: 'edge[kind="derives_from"]', style: { 'line-color': COL.derives, 'target-arrow-color': COL.derives } },
        { selector: 'edge[kind="contested"]', style: { 'line-color': COL.contested, 'line-style': 'dashed', 'target-arrow-shape': 'none' } },
        { selector: '.hidden', style: { 'display': 'none' } }
      ],
      layout: { name: 'cose', animate: false, padding: 24, nodeRepulsion: 7000, idealEdgeLength: 70 }
    });
    cy.on('tap', 'node', function (evt) { window.location.href = '/doc/' + encodeURI(evt.target.id()); });

    function opts(sel, keys) {
      var s = document.getElementById(sel);
      Object.keys(keys).sort().forEach(function (k) {
        var o = document.createElement('option'); o.value = k; o.textContent = k; s.appendChild(o);
      });
    }
    opts('fstatus', statuses); opts('fcollection', collections);
    function apply() {
      var st = document.getElementById('fstatus').value;
      var co = document.getElementById('fcollection').value;
      cy.batch(function () {
        cy.nodes().forEach(function (n) {
          var hide = (st !== 'all' && n.data('status') !== st) || (co !== 'all' && n.data('collection') !== co);
          if (hide) n.addClass('hidden'); else n.removeClass('hidden');
        });
        cy.edges().forEach(function (e) {
          if (e.source().hasClass('hidden') || e.target().hasClass('hidden')) e.addClass('hidden');
          else e.removeClass('hidden');
        });
      });
    }
    document.getElementById('fstatus').addEventListener('change', apply);
    document.getElementById('fcollection').addEventListener('change', apply);
  }).catch(function (err) { info.textContent = 'Failed to load graph: ' + err; });
})();
`;

export function renderGraphPage(opts: GraphOptions): string {
  const scopeLabel =
    opts.scope === "ego" && opts.root
      ? `Neighborhood of <a href="/doc/${encodeURI(opts.root)}">${escHtml(opts.root)}</a>`
      : "Whole vault";
  const body =
    `<h1>Knowledge graph</h1>` +
    `<div class="ginfo" id="ginfo">${scopeLabel} — loading…</div>` +
    `<div class="gtools">` +
    `<label for="fstatus">status</label><select id="fstatus"><option value="all">all</option></select>` +
    `<label for="fcollection">collection</label><select id="fcollection"><option value="all">all</option></select>` +
    (opts.scope === "ego" ? `<a href="/graph">↔ whole vault</a>` : "") +
    `</div>` +
    `<div id="cy"></div>` +
    `<div class="legend">` +
    `<span><span class="sw" style="background:#15803d"></span>canonical</span>` +
    `<span><span class="sw" style="background:#8a8a8a"></span>draft</span>` +
    `<span><span class="sw" style="background:#c2410c"></span>retired</span>` +
    `<span><span class="sw" style="background:#fff;border:3px dashed #b45309"></span>decayed</span>` +
    `<span><span class="sw" style="background:#fff;border:4px solid #b11f4b"></span>contested</span>` +
    `<span><span class="ln" style="border-color:#0a66c2"></span>derives_from</span>` +
    `<span><span class="ln" style="border-color:#b11f4b"></span>contested</span>` +
    `</div>` +
    `<script src="/assets/cytoscape.min.js"></script>` +
    `<script>${GRAPH_CLIENT_JS}</script>`;
  return layout("Knowledge graph", body);
}

// --- dashboard (home) --------------------------------------------------------

function tile(
  num: number | string,
  label: string,
  opts: { href?: string; alert?: boolean } = {},
): string {
  const inner = `<div class="num">${escHtml(String(num))}</div><div class="lbl">${escHtml(label)}</div>`;
  const cls = `tile${opts.alert ? " alert" : ""}`;
  return opts.href
    ? `<div class="${cls}"><a href="${opts.href}">${inner}</a></div>`
    : `<div class="${cls}">${inner}</div>`;
}

export function renderDashboardPage(s: StatusView): string {
  const tiles =
    `<div class="tiles">` +
    tile(s.fileCount, "documents", { href: "/docs" }) +
    tile(s.collections.length, "collections") +
    tile(s.unresolvedTensions, "open tensions", { alert: s.unresolvedTensions > 0 }) +
    tile(s.ratificationQueue, "ratification queue", { alert: s.ratificationQueue > 0 }) +
    `</div>`;

  // Staleness distribution as one proportional bar (fresh/aging/stale).
  const st = s.staleness;
  const pct = (n: number) => (st.total > 0 ? (n / st.total) * 100 : 0);
  const stalenessPanel =
    `<div class="panel"><h2>Freshness</h2>` +
    `<div class="sbar">` +
    `<span class="fresh" style="width:${pct(st.fresh)}%"></span>` +
    `<span class="aging" style="width:${pct(st.aging)}%"></span>` +
    `<span class="stale" style="width:${pct(st.stale)}%"></span>` +
    `</div>` +
    `<div class="sbar-key">` +
    `<span><span class="sw" style="background:var(--good)"></span>fresh ${st.fresh}</span>` +
    `<span><span class="sw" style="background:var(--warn)"></span>aging ${st.aging}</span>` +
    `<span><span class="sw" style="background:var(--bad)"></span>stale ${st.stale}</span>` +
    `<span>valid-time ${s.validity.authored}/${s.validity.total}</span>` +
    (s.invalidCount > 0 ? `<span>⚠ ${s.invalidCount} invalid</span>` : "") +
    `</div></div>`;

  const runsPanel =
    s.recentRuns.length === 0
      ? `<div class="panel"><h2>Recent sleep runs</h2><p class="empty">No runs recorded yet.</p></div>`
      : `<div class="panel"><h2>Recent sleep runs</h2><ul class="runs">${s.recentRuns
          .map(
            (r) =>
              `<li><span class="kind">${escHtml(r.kind)}</span>` +
              `<span class="when">${escHtml(r.ts.slice(0, 16).replace("T", " "))}</span></li>`,
          )
          .join("")}</ul></div>`;

  const body =
    `<h1>Vault dashboard</h1>` +
    tiles +
    stalenessPanel +
    runsPanel +
    `<div class="graphlink"><a href="/graph">◧ open the knowledge graph →</a></div>`;
  return layout("Vault dashboard", body);
}
