// Pure HTML page builders for `daftari view`. No IO, no server state — each
// takes plain data and returns an HTML string, so the pages are unit-testable
// without a running server. Every interpolated value is escaped (escHtml) or
// pre-sanitized (renderMarkdown for the doc body).

import { escHtml } from "./render.js";

const CSS = `
:root { color-scheme: light dark; --bg:#f7f4ef; --surface:#fff; --border:#dedede;
  --text:#242424; --muted:#5c5c5c; --accent:#b11f4b; --link:#0078d4; }
@media (prefers-color-scheme: dark) { :root { --bg:#292929; --surface:#333;
  --border:#474747; --text:#dedede; --muted:#919191; --accent:#fd8ea1; --link:#4da6ff; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text);
  font-family:-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.5; }
.wrap { max-width:900px; margin:0 auto; padding:24px 20px 80px; }
a { color:var(--link); text-decoration:none; } a:hover { text-decoration:underline; }
.brand { font-weight:700; color:var(--accent); font-size:15px; text-decoration:none; }
h1,h2,h3 { line-height:1.25; }
.collection { margin:22px 0 6px; font-size:12px; letter-spacing:.05em;
  text-transform:uppercase; color:var(--muted); }
ul.docs { list-style:none; margin:0; padding:0; }
ul.docs li { padding:6px 0; border-bottom:1px solid var(--border); }
.fm { background:var(--surface); border:1px solid var(--border); border-radius:10px;
  padding:12px 16px; margin:0 0 20px; font-size:13px; display:flex; flex-wrap:wrap; gap:14px; }
.fm .k { color:var(--muted); } .fm .v { font-weight:600; }
.body { background:var(--surface); border:1px solid var(--border); border-radius:10px;
  padding:20px 24px; overflow-wrap:anywhere; }
.body pre { background:#1e1e1e; color:#d4d4d4; padding:12px; border-radius:8px; overflow:auto; }
.body code { background:rgba(127,127,127,.15); padding:1px 4px; border-radius:4px; }
.backlinks { margin-top:24px; }
.backlinks h2 { font-size:14px; color:var(--muted); }
.backlinks ul { list-style:none; margin:0; padding:0; }
.backlinks li { padding:4px 0; font-size:13px; }
.tag { font-size:11px; color:var(--muted); border:1px solid var(--border);
  border-radius:20px; padding:1px 8px; }
.tag-warn { color:var(--accent); border-color:var(--accent); }
.tensions { background:var(--surface); border:1px solid var(--accent);
  border-radius:10px; padding:12px 16px; margin:0 0 20px; }
.tensions h2 { font-size:14px; color:var(--accent); margin:0 0 8px; }
.tensions ul { list-style:none; margin:0; padding:0; }
.tensions li { padding:8px 0; border-top:1px solid var(--border); font-size:13px; }
.tensions li:first-child { border-top:none; }
.tensions .claim { color:var(--muted); margin-top:3px; }
.empty { color:var(--muted); font-size:13px; }
`;

export function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title><style>${CSS}</style></head>
<body><div class="wrap"><a class="brand" href="/">daftari · vault</a>${bodyHtml}</div></body></html>`;
}

export interface IndexEntry {
  path: string;
  title: string;
}
export interface IndexGroup {
  collection: string;
  docs: IndexEntry[];
}

export function renderIndexPage(groups: IndexGroup[]): string {
  if (groups.length === 0) {
    return layout("Vault", `<h1>Vault</h1><p class="empty">No documents found.</p>`);
  }
  const sections = groups
    .map((g) => {
      const items = g.docs
        .map(
          (d) => `<li><a href="/doc/${encodeURI(d.path)}">${escHtml(d.title || d.path)}</a></li>`,
        )
        .join("");
      return `<div class="collection">${escHtml(g.collection)}</div><ul class="docs">${items}</ul>`;
    })
    .join("");
  return layout("Vault", `<h1>Vault</h1>${sections}`);
}

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
  counterpart: string; // the other side's vault path
  kind: string; // factual | temporal | interpretive | ...
  claimSelf: string; // this doc's claim
  claimOther: string; // the counterpart's claim
  loggedAt: string;
}

export function renderDocPage(args: {
  path: string;
  frontmatter: DocFrontmatterView;
  bodyHtml: string; // already sanitized by renderMarkdown
  backlinks: DocBacklinkView[];
  tensions?: DocTensionView[];
}): string {
  const fm = args.frontmatter;
  const chips = [
    ["collection", fm.collection],
    ["status", fm.status],
    ["confidence", fm.confidence],
    ["provenance", fm.provenance],
    ["tier", fm.tier ?? "—"],
  ]
    .map(
      ([k, v]) =>
        `<span><span class="k">${escHtml(k)}:</span> <span class="v">${escHtml(v)}</span></span>`,
    )
    .join("");
  const tags =
    fm.tags.length > 0
      ? `<span>${fm.tags.map((t) => `<span class="tag">${escHtml(t)}</span>`).join(" ")}</span>`
      : "";
  const backlinks =
    args.backlinks.length === 0
      ? `<p class="empty">No documents reference this one.</p>`
      : `<ul>${args.backlinks
          .map(
            (b) =>
              `<li><a href="/doc/${encodeURI(b.doc)}">${escHtml(b.doc)}</a> <span class="tag">${escHtml(b.label)}</span></li>`,
          )
          .join("")}</ul>`;
  const tensions = args.tensions ?? [];
  const tensionsPanel =
    tensions.length === 0
      ? ""
      : `<div class="tensions"><h2>Contested</h2><ul>${tensions
          .map(
            (t) =>
              `<li><span class="tag tag-warn">${escHtml(t.kind)}</span> vs ` +
              `<a href="/doc/${encodeURI(t.counterpart)}">${escHtml(t.counterpart)}</a>` +
              `<div class="claim"><span class="k">this:</span> ${escHtml(t.claimSelf)}</div>` +
              `<div class="claim"><span class="k">other:</span> ${escHtml(t.claimOther)}</div></li>`,
          )
          .join("")}</ul></div>`;
  const body =
    `<h1>${escHtml(fm.title || args.path)}</h1>` +
    `<div class="fm">${chips}${tags}</div>` +
    tensionsPanel +
    `<div class="body">${args.bodyHtml}</div>` +
    `<div class="backlinks"><h2>Backlinks</h2>${backlinks}</div>`;
  return layout(fm.title || args.path, body);
}
