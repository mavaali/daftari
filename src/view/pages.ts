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

import { escHtml } from "./render.js";

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
`;

function searchBox(query = ""): string {
  return `<form class="search" action="/search" method="get">
<input type="search" name="q" placeholder="Search the vault…" value="${escHtml(query)}" autocomplete="off"></form>`;
}

export function layout(title: string, bodyHtml: string, query = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title><style>${CSS}</style></head>
<body><div class="wrap"><div class="topbar"><a class="brand" href="/">daftari · vault</a>${searchBox(query)}</div>${bodyHtml}</div></body></html>`;
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
  const body =
    `<h1>${escHtml(fm.title || args.path)}</h1>` +
    standing +
    tags +
    banners +
    tensionsPanel +
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
