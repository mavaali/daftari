// board-page.ts — U13: pure board-page renderer (instrument-panel table,
// 2026-08-18 redesign decided on the design canvas).
//
// renderBoardPage(boardState, filters?) → HTML string
//
// Design decisions:
//   - PURE function: board state (+ an injected `now` for the display-only
//     age column, defaulting to the wall clock) in, HTML string out. No I/O.
//     No calls to listBoard or any vault tool. The caller (U12 serve path)
//     calls listBoard and passes the result here.
//   - The five dispositions New, Accepted, Waiting, Resolved, Dismissed (R25)
//     render as a stat strip of counts (one cell per disposition, in order),
//     and per-row as an N/A/W/R/D state indicator. Waiting is a SINGLE bucket —
//     deferred/blocked/awaiting all count there. The stat cells keep the
//     `board-col col-<id>` / `board-col-header` / `col-count` class hooks the
//     R25 suite and the serve-route tests key on.
//   - The findings themselves are ONE dense table grouped by source (lint,
//     staleness, tension, staged, tier2), not five kanban columns: disposition
//     is a cell, not a place. Each Finding → one `board-card` row, rendered
//     independently (R27); no group-collapse by target document.
//   - A waiting row shows the rationale/expiry from the most recent human
//     ledger event inline under its target (same data as the old card).
//   - Filter form (GET, action="/board") with fields for all BoardFilters
//     fields; values reflect the currently-applied filters (R26).
//   - Back-links (R28):
//       lint/staleness → /doc/<path>
//       staged         → /doc/<evidence.targetPath>
//       tension        → /doc/<evidence.sourceA> and /doc/<evidence.sourceB>
//       tier2          → /doc/<target.artifact> and /doc/<target.unit>
//   - Disposition actions (U8): Accept/Defer/Dismiss/Resolve buttons per row,
//     wired by BOARD_CLIENT_JS to the authenticated POST endpoints. The N/A/W/
//     R/D segments are display-only state — actions are events, not states.
//   - All vault-derived text is escaped with escHtml before insertion (XSS).
//
// Re-exports BoardFilters from board.ts for convenience — tests and server.ts
// import it from here so callers need only one import.

import type { BoardFilters, BoardResult } from "../board/board.js";
import {
  FINDING_SOURCES,
  type Finding,
  type FindingSource,
  type FindingTarget,
  type LedgerEvent,
} from "../board/types.js";
import { layout, toneForLevel } from "./pages.js";
import { escHtml } from "./render.js";

export type { BoardFilters };

// ---------------------------------------------------------------------------
// CSS additions — board-specific styles, consistent with the existing CSS
// vocabulary in pages.ts (same variables, same design tokens).
// ---------------------------------------------------------------------------

const BOARD_CSS = `
.board-topbar { display:flex; align-items:center; justify-content:space-between; }
.board-topbar h1 { font-family:var(--mono); font-size:16px; font-weight:700;
  letter-spacing:.12em; text-transform:uppercase; color:var(--hi); }

/* disposition stat strip (R25 order; keeps board-col/col-count test hooks) */
.board-stats { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:0;
  border:1px solid var(--border); background:var(--surface); margin:0 0 14px; }
.board-col { border-right:1px solid var(--border); padding:10px 16px; min-width:0; }
.board-col:last-child { border-right:none; }
.board-col-header { font-family:var(--mono); font-size:10px; font-weight:700;
  text-transform:uppercase; letter-spacing:.12em; color:var(--muted);
  display:flex; align-items:baseline; gap:10px; }
.board-col-header .col-count { font-size:22px; font-weight:700; letter-spacing:-.01em;
  line-height:1; order:-1; }
.board-col.col-new      .board-col-header { color:var(--hi); }
.board-col.col-accepted .board-col-header { color:var(--good); }
.board-col.col-waiting  .board-col-header { color:var(--warn); }
.board-col.col-resolved .board-col-header,
.board-col.col-dismissed .board-col-header { color:var(--muted); }

/* filters */
.board-filters { background:var(--surface); border:1px solid var(--border);
  padding:12px 16px; margin:0 0 14px; }
.board-filters h2 { font-size:10px; font-family:var(--mono); text-transform:uppercase;
  letter-spacing:.1em; color:var(--muted); margin:0 0 10px; }
.board-filters form { display:flex; flex-wrap:wrap; gap:10px 16px; align-items:flex-end; }
.board-filters .ff { display:flex; flex-direction:column; gap:3px; }
.board-filters label { font-family:var(--mono); font-size:9px; text-transform:uppercase;
  letter-spacing:.08em; color:var(--muted); }
.board-filters input { font-family:var(--mono); font-size:11px; padding:5px 9px;
  border:1px solid var(--border-2); background:var(--bg); color:var(--text); width:132px; }
.board-filters button { font-family:var(--mono); font-size:10px; font-weight:700;
  text-transform:uppercase; letter-spacing:.08em; padding:6px 14px;
  border:1px solid var(--border-2); background:transparent; color:var(--muted);
  cursor:pointer; align-self:flex-end; }
.board-filters button:hover { color:var(--hi); border-color:var(--muted); }

/* the findings ledger — one dense table grouped by source */
.board-scroll { overflow-x:auto; }
.btable { border:1px solid var(--border); background:var(--surface); min-width:980px; }
.brow, .board-card { display:grid;
  grid-template-columns:14px 170px minmax(0,1fr) 90px 46px 138px 232px;
  gap:10px; align-items:center; padding:7px 14px;
  border-bottom:1px solid var(--border); font-size:12px; }
.btable > :last-child { border-bottom:none; }
.bhead { background:var(--surface-2); border-bottom:1px solid var(--border-2); }
.bhead span { font-family:var(--mono); font-size:9px; font-weight:700;
  text-transform:uppercase; letter-spacing:.1em; color:var(--muted); }
.bgroup { padding:5px 14px; background:var(--surface-2); border-bottom:1px solid var(--border);
  display:flex; gap:10px; align-items:baseline; }
.bgroup .gsrc { font-family:var(--mono); font-size:10px; font-weight:700;
  text-transform:uppercase; letter-spacing:.1em; }
.bgroup .gn { font-family:var(--mono); font-size:9px; color:var(--muted);
  text-transform:uppercase; letter-spacing:.06em; }
.gsrc.warn { color:var(--warn); } .gsrc.bad { color:var(--bad); } .gsrc.dim { color:var(--muted); }

/* row cells */
.bcheck { display:flex; flex-direction:column; gap:1px; min-width:0; }
.bcheck-name { font-family:var(--mono); font-size:10px; color:var(--muted);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bcert { font-family:var(--mono); font-size:9px; font-weight:700;
  text-transform:uppercase; letter-spacing:.06em; }
.bcert.good { color:var(--good); } .bcert.warn { color:var(--warn); }
.bcert.bad { color:var(--bad); }
.btarget { min-width:0; overflow-wrap:anywhere; line-height:1.45; }
.btarget a { font-size:12px; }
.card-action { color:var(--muted); font-size:11px; }
.card-meta { display:flex; flex-wrap:wrap; gap:4px 8px; margin-top:3px; }
.card-rationale { margin:3px 0 0; font-size:11px; color:var(--muted);
  border-left:2px solid var(--warn); padding-left:8px; }
.card-expiry { font-family:var(--mono); font-size:9px; color:var(--warn);
  text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
.bowner { font-family:var(--mono); font-size:10px; color:var(--muted);
  text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bage { font-family:var(--mono); font-size:10px; color:var(--muted); }

/* N/A/W/R/D state indicator — display-only; actions are events, not states */
.bstate { display:inline-flex; }
.dseg { font-family:var(--mono); font-size:10px; font-weight:700; width:26px;
  text-align:center; padding:2px 0; border:1px solid var(--border-2);
  color:var(--faint); margin-left:-1px; }
.dseg:first-child { margin-left:0; }
.dseg.on-new { background:var(--hi); color:var(--bg); border-color:var(--hi); }
.dseg.on-accepted { background:var(--good); color:var(--bg); border-color:var(--good); }
.dseg.on-waiting { background:var(--warn); color:var(--bg); border-color:var(--warn); }
.dseg.on-resolved,
.dseg.on-dismissed { background:var(--muted); color:var(--bg); border-color:var(--muted); }

/* disposition actions (U8) */
.card-actions { display:flex; flex-wrap:wrap; gap:5px; }
.ba { font-family:var(--mono); font-size:9px; font-weight:700; text-transform:uppercase;
  letter-spacing:.07em; padding:4px 8px; border:1px solid var(--border-2);
  background:transparent; color:var(--muted); cursor:pointer; }
.ba:hover { color:var(--hi); border-color:var(--muted); }
.ba:disabled { opacity:.5; cursor:default; }
.ba-resolve { border-color:var(--good); color:var(--good); }
.legendline { font-family:var(--mono); font-size:9px; color:var(--muted);
  text-transform:uppercase; letter-spacing:.08em; margin:10px 2px 0; }

/* narrow viewports: stack each row into a card; stats reflow */
@media (max-width:900px) {
  .board-stats { grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
  .board-col { border-bottom:1px solid var(--border); }
  .btable { min-width:0; }
  .brow.bhead { display:none; }
  .brow, .board-card { grid-template-columns:14px minmax(0,1fr); row-gap:6px; padding:10px 12px; }
  .board-card > .bcheck, .board-card > .btarget, .board-card > .bowner,
  .board-card > .bage, .board-card > .bstate, .board-card > .card-actions { grid-column:2; }
}
`;

// ---------------------------------------------------------------------------
// Board client script (U8, bead 7q9). Wires the disposition buttons and the
// sign-out control to the authenticated POST endpoints. Uses the double-submit
// CSRF token: read the non-HttpOnly daftari_csrf cookie and echo it in the
// X-CSRF-Token header. Vanilla JS, no external deps — same inline-<script>
// pattern as the graph page (pages.ts). Event-delegated so it costs one
// listener regardless of card count.
// ---------------------------------------------------------------------------

const BOARD_CLIENT_JS = `
(function(){
  function csrf(){var m=document.cookie.match(/(?:^|; )daftari_csrf=([^;]*)/);return m?m[1]:'';}
  function post(url,payload){
    return fetch(url,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify(payload)});
  }
  document.addEventListener('click',function(e){
    var btn=e.target.closest('[data-board-action]');
    if(!btn)return;
    var card=btn.closest('.board-card');
    var id=card&&card.getAttribute('data-id');
    if(!id)return;
    var action=btn.getAttribute('data-board-action');
    var url=action==='resolve'?'/api/board/resolve':'/api/board/dispose';
    var payload=action==='resolve'?{finding_id:id}:{finding_id:id,event:action};
    btn.disabled=true;
    post(url,payload).then(function(r){
      if(r.ok){location.reload();return;}
      return r.json().catch(function(){return{};}).then(function(b){
        btn.disabled=false;
        alert('Action failed ('+r.status+'): '+((b&&b.message)||'request rejected'));
      });
    }).catch(function(){btn.disabled=false;alert('Network error');});
  });
  var lo=document.getElementById('board-logout');
  if(lo){lo.addEventListener('click',function(){
    post('/board/logout',{}).then(function(){location.href='/board/login';})
      .catch(function(){location.href='/board/login';});
  });}
})();
`;

// ---------------------------------------------------------------------------
// Column metadata — order is specification (R25).
// ---------------------------------------------------------------------------

const COLUMN_ORDER = ["new", "accepted", "waiting", "resolved", "dismissed"] as const;
type ColId = (typeof COLUMN_ORDER)[number];

const COLUMN_LABELS: Record<ColId, string> = {
  new: "New",
  accepted: "Accepted",
  waiting: "Waiting",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

// ---------------------------------------------------------------------------
// Target back-link rendering (R28).
// ---------------------------------------------------------------------------

function renderTargetLinks(target: FindingTarget, evidence: Record<string, unknown>): string {
  switch (target.kind) {
    case "lint":
    case "staleness": {
      const p = target.path;
      return `<a href="/doc/${encodeURI(p)}">${escHtml(p)}</a>`;
    }
    case "staged": {
      // Staged findings carry the target document in evidence.targetPath.
      const tp = (evidence as { targetPath?: string }).targetPath;
      if (typeof tp === "string") {
        return (
          `<a href="/doc/${encodeURI(tp)}">${escHtml(tp)}</a>` +
          ` <span class="tag">staged:${escHtml(target.stagedActionId)}</span>`
        );
      }
      return `<span class="tag">staged:${escHtml(target.stagedActionId)}</span>`;
    }
    case "tension": {
      // Tension findings carry both sides in evidence.sourceA / sourceB.
      const ev = evidence as { sourceA?: string; sourceB?: string };
      const parts: string[] = [];
      if (typeof ev.sourceA === "string") {
        parts.push(`<a href="/doc/${encodeURI(ev.sourceA)}">${escHtml(ev.sourceA)}</a>`);
      }
      if (typeof ev.sourceB === "string") {
        parts.push(`<a href="/doc/${encodeURI(ev.sourceB)}">${escHtml(ev.sourceB)}</a>`);
      }
      if (parts.length === 0) {
        return `<span class="tag">tension:${escHtml(target.tensionId)}</span>`;
      }
      return (
        parts.join(' <span class="tag">⚔</span> ') +
        ` <span class="tag">tension:${escHtml(target.tensionId)}</span>`
      );
    }
    case "tier2": {
      return (
        `<a href="/doc/${encodeURI(target.artifact)}">${escHtml(target.artifact)}</a>` +
        ` <span class="tag">↑</span> ` +
        `<a href="/doc/${encodeURI(target.unit)}">${escHtml(target.unit)}</a>` +
        ` <span class="tag">${escHtml(target.edgeClass)}</span>`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Waiting column rationale: pull the most recent human defer/accept event.
// ---------------------------------------------------------------------------

function waitingRationale(history: LedgerEvent[]): { rationale?: string; expiry?: string } | null {
  // Walk backwards to find the most recent event with a rationale.
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e.rationale !== undefined || e.expiry !== undefined) {
      return { rationale: e.rationale, expiry: e.expiry };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source grouping — the table groups findings by detection surface, in the
// canonical FINDING_SOURCES order (imported, never hand-copied: a new adapter
// must appear here or the compiler complains, so the table can never silently
// drop a source the stat strip counts). Tone matches the old source-chip
// mapping.
// ---------------------------------------------------------------------------

const SOURCE_TONE: Record<FindingSource, "warn" | "bad" | "dim"> = {
  lint: "warn",
  staleness: "warn",
  tension: "bad",
  staged: "dim",
  tier2: "dim",
};

// ---------------------------------------------------------------------------
// Age — days since first_seen, against the caller-supplied clock. Display-
// only; not part of any filter logic.
// ---------------------------------------------------------------------------

function ageLabel(firstSeen: string, now: number): string {
  const t = Date.parse(firstSeen);
  if (Number.isNaN(t)) return "—";
  const days = Math.max(0, Math.floor((now - t) / 86_400_000));
  return `${days}d`;
}

// ---------------------------------------------------------------------------
// N/A/W/R/D state indicator — display-only. Disposition changes go through
// the action buttons (events), never by clicking a state. The five variants
// are precomputed from COLUMN_ORDER/COLUMN_LABELS (compile-time constants,
// so no per-row escaping): one property read per row.
// ---------------------------------------------------------------------------

const STATE_SEGMENTS: Record<ColId, string> = Object.fromEntries(
  COLUMN_ORDER.map((d) => [
    d,
    `<span class="bstate" title="disposition: ${d}">` +
      COLUMN_ORDER.map(
        (c) =>
          `<span class="dseg${c === d ? ` on-${c}` : ""}" title="${COLUMN_LABELS[c]}">${COLUMN_LABELS[c].charAt(0)}</span>`,
      ).join("") +
      `</span>`,
  ]),
) as Record<ColId, string>;

// ---------------------------------------------------------------------------
// Evidence summary — render up to 3 string-valued evidence fields, escaped.
// Non-string fields (arrays, objects, numbers) are skipped. This surfaces
// enough detail for a reviewer without a schema requirement, and critically
// ensures every evidence string goes through escHtml (XSS requirement).
// ---------------------------------------------------------------------------

function renderEvidenceSummary(evidence: Record<string, unknown>): string {
  const entries = Object.entries(evidence)
    .filter(([, v]) => typeof v === "string")
    .slice(0, 3);
  if (entries.length === 0) return "";
  const rows = entries
    .map(
      ([k, v]) =>
        `<span class="chip dim" style="font-size:10px;">${escHtml(k)}: ${escHtml(String(v))}</span>`,
    )
    .join("");
  return `<div class="card-meta" style="margin-top:4px;">${rows}</div>`;
}

// ---------------------------------------------------------------------------
// Render one finding row.
// ---------------------------------------------------------------------------

function renderRow(f: Finding, now: number): string {
  const wr = f.disposition === "waiting" ? waitingRationale(f.history) : null;
  const rationale =
    wr?.rationale !== undefined
      ? `<div class="card-rationale">${escHtml(wr.rationale)}` +
        (wr.expiry !== undefined
          ? `<div class="card-expiry">until ${escHtml(wr.expiry.slice(0, 10))}</div>`
          : "") +
        `</div>`
      : "";
  const tone = toneForLevel(f.certainty);

  return (
    `<div class="board-card" data-id="${escHtml(f.identity_key)}">` +
    `<span class="dot ${tone}" title="certainty: ${escHtml(f.certainty)}"></span>` +
    `<span class="bcheck"><span class="bcheck-name" title="${escHtml(f.check)}">${escHtml(f.check)}</span>` +
    `<span class="bcert ${tone}">${escHtml(f.certainty)}</span></span>` +
    `<div class="btarget">${renderTargetLinks(f.target, f.evidence)}` +
    `<div class="card-action">${escHtml(f.suggested_action)}</div>` +
    renderEvidenceSummary(f.evidence) +
    rationale +
    `</div>` +
    `<span class="bowner" title="${escHtml(f.owner)}">${escHtml(f.owner)}</span>` +
    `<span class="bage">${ageLabel(f.first_seen, now)}</span>` +
    STATE_SEGMENTS[f.disposition] +
    // Disposition controls (U8, bead 7q9). The board client script (injected
    // once in renderBoardPage) reads the finding id from the row's data-id
    // and POSTs to /api/board/{dispose,resolve} with the CSRF token. No id is
    // echoed onto the buttons themselves — the handler walks up to .board-card.
    `<div class="card-actions">` +
    `<button type="button" class="ba" data-board-action="accept">Accept</button>` +
    `<button type="button" class="ba" data-board-action="defer">Defer</button>` +
    `<button type="button" class="ba" data-board-action="dismiss">Dismiss</button>` +
    `<button type="button" class="ba ba-resolve" data-board-action="resolve">Resolve</button>` +
    `</div>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Stat strip — one cell per disposition, R25 order. The heading text must
// appear directly after `class="board-col-header">` (no wrapping child) and
// the serve-route suite keys on the `board-col col-<id>` class pair.
// ---------------------------------------------------------------------------

function renderStats(board: BoardResult): string {
  const cells = COLUMN_ORDER.map(
    (id) =>
      `<div class="board-col col-${escHtml(id)}">` +
      `<div class="board-col-header">${escHtml(COLUMN_LABELS[id])}<span class="col-count">${board.columns[id].length}</span></div>` +
      `</div>`,
  ).join("");
  return `<div class="board-stats">${cells}</div>`;
}

// ---------------------------------------------------------------------------
// The findings ledger — one table, grouped by source, rows sorted by
// disposition order within each group.
// ---------------------------------------------------------------------------

// R25 disposition rank, derived from the order spec — never restated by hand.
const DISP_RANK = Object.fromEntries(COLUMN_ORDER.map((c, i) => [c, i])) as Record<ColId, number>;

function renderTable(all: Finding[], now: number): string {
  if (all.length === 0) return "";
  const head =
    `<div class="brow bhead"><span></span><span>Check</span><span>Target</span>` +
    `<span>Owner</span><span>Age</span><span>State</span><span>Actions</span></div>`;
  const groups = FINDING_SOURCES.map((src) => {
    const findings = all
      .filter((f) => f.source === src)
      .sort((a, b) => DISP_RANK[a.disposition] - DISP_RANK[b.disposition]);
    if (findings.length === 0) return "";
    const tone = SOURCE_TONE[src];
    return (
      `<div class="bgroup"><span class="gsrc ${tone}">${escHtml(src)}</span>` +
      `<span class="gn">${findings.length} finding${findings.length === 1 ? "" : "s"}</span></div>` +
      findings.map((f) => renderRow(f, now)).join("")
    );
  }).join("");
  return (
    `<div class="board-scroll"><div class="btable">${head}${groups}</div></div>` +
    `<p class="legendline">N new · A accepted · W waiting · R resolved · D dismissed — ` +
    `state moves via the actions; resolve verifies the finding is gone</p>`
  );
}

// ---------------------------------------------------------------------------
// Filter form (R26) — GET to /board; reflects currently-applied filters.
// ---------------------------------------------------------------------------

function filterField(name: string, label: string, value: string | number | undefined): string {
  const v = value !== undefined ? String(value) : "";
  return (
    `<div class="ff">` +
    `<label for="ff-${escHtml(name)}">${escHtml(label)}</label>` +
    `<input id="ff-${escHtml(name)}" name="${escHtml(name)}" type="text"` +
    ` value="${escHtml(v)}" placeholder="${escHtml(label)}" autocomplete="off">` +
    `</div>`
  );
}

function renderFilterForm(filters?: BoardFilters): string {
  const f = filters ?? {};
  return (
    `<div class="board-filters">` +
    `<h2>Filters</h2>` +
    `<form action="/board" method="get">` +
    filterField("collection", "Collection", f.collection) +
    filterField("check", "Check", f.check) +
    filterField("certainty", "Certainty", f.certainty) +
    filterField("owner", "Owner", f.owner) +
    filterField("minAgeDays", "Min age (days)", f.minAgeDays) +
    filterField("document", "Document", f.document) +
    `<button type="submit">Apply</button>` +
    (Object.values(f).some((v) => v !== undefined)
      ? ` <a href="/board" style="font-size:12px;color:var(--muted);align-self:flex-end;">Clear</a>`
      : "") +
    `</form>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// renderBoardPage — the public export.
// ---------------------------------------------------------------------------

export function renderBoardPage(
  boardState: BoardResult,
  filters?: BoardFilters,
  now: number = Date.now(),
): string {
  const total = boardState.all.length;
  const countLabel = total > 0 ? `${total} finding${total === 1 ? "" : "s"}` : "No findings";

  const body =
    `<div class="board-topbar">` +
    `<h1>Vault Board</h1>` +
    `<button type="button" id="board-logout" class="ba">Sign out</button>` +
    `</div>` +
    `<p style="font-size:12px;color:var(--muted);margin:0 0 12px;font-family:var(--mono);">${countLabel}</p>` +
    renderStats(boardState) +
    renderFilterForm(filters) +
    renderTable(boardState.all, now);

  // Inline the board CSS as a scoped <style> block appended to the layout's
  // <head>. layout() wraps in a full HTML page with the shared CSS; we inject
  // the board additions via a <style> tag in the body (pre-content).
  const bodyWithCss = `<style>${BOARD_CSS}</style>${body}<script>${BOARD_CLIENT_JS}</script>`;

  return layout("Vault Board", bodyWithCss, "", { wide: true });
}
