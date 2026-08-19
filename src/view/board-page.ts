// board-page.ts — U13: pure board-page renderer.
//
// renderBoardPage(boardState, filters?) → HTML string
//
// Design decisions:
//   - PURE function: board state in, HTML string out. No I/O. No calls to
//     listBoard or any vault tool. The caller (U12 serve path) calls listBoard
//     and passes the result here.
//   - Five columns in order: New, Accepted, Waiting, Resolved, Dismissed (R25).
//     Waiting is a SINGLE column — deferred/blocked/awaiting all appear there.
//     The rationale/expiry from the most recent human ledger event is shown on
//     the card, not as separate sub-columns.
//   - Each Finding → one card, rendered independently (R27). No group-collapse
//     by target document; siblings are always visible.
//   - Filter form (GET, action="/board") with fields for all BoardFilters
//     fields; values reflect the currently-applied filters (R26).
//   - Back-links (R28):
//       lint/staleness → /doc/<path>
//       staged         → /doc/<evidence.target_path>
//       tension        → /doc/<evidence.sourceA> and /doc/<evidence.sourceB>
//       tier2          → /doc/<target.artifact> and /doc/<target.unit>
//   - Disposition buttons: DEFERRED to U12. Cards are read-only — disposition
//     state is shown as a chip but no mutation forms are rendered here (R29).
//     U12 wires the POST endpoints and can add form buttons in its own layer.
//   - All vault-derived text is escaped with escHtml before insertion (XSS).
//
// Re-exports BoardFilters from board.ts for convenience — tests and server.ts
// import it from here so callers need only one import.

import type { BoardFilters, BoardResult } from "../board/board.js";
import type { Finding, FindingTarget, LedgerEvent } from "../board/types.js";
import { layout } from "./pages.js";
import { escHtml } from "./render.js";

export type { BoardFilters };

// ---------------------------------------------------------------------------
// CSS additions — board-specific styles, consistent with the existing CSS
// vocabulary in pages.ts (same variables, same design tokens).
// ---------------------------------------------------------------------------

const BOARD_CSS = `
/* board layout */
.board-filters { background:var(--surface); border:1px solid var(--border);
  border-radius:12px; padding:14px 18px; margin:0 0 16px; }
.board-filters h2 { font-size:11px; font-family:var(--mono); text-transform:uppercase;
  letter-spacing:.04em; color:var(--muted); margin:0 0 10px; }
.board-filters form { display:flex; flex-wrap:wrap; gap:10px 16px; align-items:flex-end; }
.board-filters .ff { display:flex; flex-direction:column; gap:3px; }
.board-filters label { font-family:var(--mono); font-size:10px; text-transform:uppercase;
  letter-spacing:.04em; color:var(--muted); }
.board-filters input { font-size:12px; padding:5px 9px; border:1px solid var(--border-2);
  border-radius:7px; background:var(--surface); color:var(--text); width:130px; }
.board-filters button { font-size:12px; padding:5px 14px; border-radius:7px;
  border:1px solid var(--border-2); background:var(--surface-2); color:var(--text);
  cursor:pointer; align-self:flex-end; }

/* board columns */
.board { display:grid; grid-template-columns:repeat(5,1fr); gap:14px;
  align-items:start; }
@media (max-width:900px) { .board { grid-template-columns:repeat(2,1fr); } }
@media (max-width:480px) { .board { grid-template-columns:1fr; } }
.board-col { background:var(--surface-2); border:1px solid var(--border);
  border-radius:12px; padding:10px 12px; min-height:80px; }
.board-col-header { font-family:var(--mono); font-size:11px; font-weight:700;
  text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
  display:flex; justify-content:space-between; align-items:center;
  margin:0 0 10px; padding-bottom:7px; border-bottom:1px solid var(--border); }
.board-col-header .col-count { font-size:10px; background:var(--dim-bg);
  color:var(--muted); padding:1px 7px; border-radius:10px; }
/* column accent colors */
.board-col.col-new    .board-col-header { color:var(--link); }
.board-col.col-accepted .board-col-header { color:var(--good); }
.board-col.col-waiting  .board-col-header { color:var(--warn); }
.board-col.col-resolved .board-col-header { color:var(--dim); }
.board-col.col-dismissed .board-col-header { color:var(--dim); }

/* board cards */
.board-card { background:var(--surface); border:1px solid var(--border);
  border-radius:9px; padding:10px 12px; margin:0 0 8px; font-size:12px; }
.board-card:last-child { margin-bottom:0; }
.board-card .card-check { font-family:var(--mono); font-size:10px; font-weight:700;
  text-transform:uppercase; letter-spacing:.04em; color:var(--muted);
  display:flex; justify-content:space-between; align-items:center;
  margin:0 0 6px; }
.board-card .card-target { margin:0 0 6px; line-height:1.4; }
.board-card .card-target a { font-size:12px; }
.board-card .card-action { color:var(--muted); font-size:11px; margin:4px 0; }
.board-card .card-meta { display:flex; flex-wrap:wrap; gap:4px 8px; margin-top:6px; }
.board-card .card-rationale { margin:6px 0 0; font-size:11px; color:var(--muted);
  border-left:3px solid var(--warn); padding-left:8px; }
.board-card .card-expiry { font-family:var(--mono); font-size:10px; color:var(--warn);
  margin-top:3px; }
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
      // Staged findings carry the target document in evidence.target_path.
      const tp = (evidence as { target_path?: string }).target_path;
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
// Certainty chip (mirrors confidenceMeter in pages.ts).
// ---------------------------------------------------------------------------

function certaintyChip(certainty: string): string {
  const tone = certainty === "high" ? "good" : certainty === "medium" ? "warn" : "bad";
  return `<span class="chip ${tone}">${escHtml(certainty)}</span>`;
}

// ---------------------------------------------------------------------------
// Source chip.
// ---------------------------------------------------------------------------

function sourceChip(source: string): string {
  const tone =
    source === "lint" || source === "staleness" ? "warn" : source === "tension" ? "bad" : "dim";
  return `<span class="chip ${tone}">${escHtml(source)}</span>`;
}

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
// Render one finding card.
// ---------------------------------------------------------------------------

function renderCard(f: Finding): string {
  const wr = f.disposition === "waiting" ? waitingRationale(f.history) : null;
  const rationale =
    wr?.rationale !== undefined
      ? `<div class="card-rationale">${escHtml(wr.rationale)}` +
        (wr.expiry !== undefined
          ? `<div class="card-expiry">until ${escHtml(wr.expiry.slice(0, 10))}</div>`
          : "") +
        `</div>`
      : "";

  return (
    `<div class="board-card" data-id="${escHtml(f.identity_key)}">` +
    `<div class="card-check">` +
    `<span>${escHtml(f.check)}</span>` +
    `</div>` +
    `<div class="card-target">${renderTargetLinks(f.target, f.evidence)}</div>` +
    `<div class="card-action">${escHtml(f.suggested_action)}</div>` +
    `<div class="card-meta">` +
    sourceChip(f.source) +
    certaintyChip(f.certainty) +
    `<span class="chip dim">${escHtml(f.owner)}</span>` +
    `</div>` +
    renderEvidenceSummary(f.evidence) +
    rationale +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Render one board column.
// ---------------------------------------------------------------------------

function renderColumn(id: ColId, findings: Finding[]): string {
  const label = COLUMN_LABELS[id];
  const cards = findings.map(renderCard).join("");
  const empty =
    findings.length === 0
      ? `<p class="empty" style="font-size:12px;margin:6px 0;">No findings</p>`
      : "";
  // NOTE: the column header text must appear directly after `class="board-col-header">` (no
  // child element wrapping it) so that the test regex `class="board-col-header[^"]*"[^>]*>\s*<label>`
  // can match. The count badge follows inside the same div.
  return (
    `<div class="board-col col-${escHtml(id)}">` +
    `<div class="board-col-header">${escHtml(label)}<span class="col-count">${findings.length}</span></div>` +
    cards +
    empty +
    `</div>`
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

export function renderBoardPage(boardState: BoardResult, filters?: BoardFilters): string {
  const columns = COLUMN_ORDER.map((id) => renderColumn(id, boardState.columns[id])).join("");
  const total = boardState.all.length;

  const body =
    `<h1>Vault Board</h1>` +
    (total > 0
      ? `<p style="font-size:13px;color:var(--muted);margin:0 0 14px;">${total} finding${total === 1 ? "" : "s"}</p>`
      : `<p style="font-size:13px;color:var(--muted);margin:0 0 14px;">No findings</p>`) +
    renderFilterForm(filters) +
    `<div class="board">${columns}</div>`;

  // Inline the board CSS as a scoped <style> block appended to the layout's
  // <head>. layout() wraps in a full HTML page with the shared CSS; we inject
  // the board additions via a <style> tag in the body (pre-content).
  const bodyWithCss = `<style>${BOARD_CSS}</style>${body}`;

  return layout("Vault Board", bodyWithCss);
}
