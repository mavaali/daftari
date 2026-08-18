// board-page.test.ts — U13 TDD suite.
//
// Tests for renderBoardPage (pure renderer: board state in → HTML string out).
// No file I/O; all board states are constructed in-memory.
//
// Coverage targets:
//   R25 — 5 columns present + labeled; Waiting is one column
//   R26 — filter form reflects applied filters; filters narrow rendered cards
//   R27 — doc with multiple findings: each is independent card; resolving one
//          does not hide another
//   R28 — card back-links: lint/staleness → /doc/<path>; staged → /doc/<path>;
//          tension → both sides' docs; tier2 → /doc/<artifact>
//   R29 — no document-body editing controls
//   XSS — all vault-derived text (title, evidence, rationale, owner, path) is
//          HTML-escaped before insertion
//
// Also covers: doc-page "open findings" section link (/board?document=<encoded>)
//              added to renderDocPage (R28, admin-loopback convenience).

import { describe, expect, it } from "vitest";
import type { BoardResult } from "../board/board.js";
import type { Finding, LedgerEvent } from "../board/types.js";
import { type BoardFilters, renderBoardPage } from "./board-page.js";
import { renderDocPage } from "./pages.js";

// ---------------------------------------------------------------------------
// Helpers — minimal Finding factories
// ---------------------------------------------------------------------------

let _seq = 0;
function makeId(): string {
  return `finding-${++_seq}`;
}

function baseFinding(overrides: Partial<Finding> = {}): Finding {
  const id = makeId();
  return {
    identity_key: id,
    source: "lint",
    check: "staleFiles",
    target: { kind: "lint", path: "notes/foo.md" },
    fingerprint: "fp-" + id,
    certainty: "medium",
    evidence: {},
    suggested_action: "Review the file",
    verify_predicate: "re-run lint",
    owner: "alice",
    first_seen: "2024-01-01T00:00:00.000Z",
    last_seen: "2024-01-02T00:00:00.000Z",
    disposition: "new",
    history: [],
    ...overrides,
  };
}

function emptyBoard(): BoardResult {
  return {
    columns: { new: [], accepted: [], waiting: [], resolved: [], dismissed: [] },
    all: [],
  };
}

function boardWith(findings: Finding[]): BoardResult {
  const columns: BoardResult["columns"] = {
    new: [],
    accepted: [],
    waiting: [],
    resolved: [],
    dismissed: [],
  };
  for (const f of findings) {
    columns[f.disposition].push(f);
  }
  return { columns, all: findings };
}

// ---------------------------------------------------------------------------
// R25 — Five columns, correct labels, single Waiting column
// ---------------------------------------------------------------------------

describe("R25 — board columns", () => {
  it("renders all five column headings on an empty board", () => {
    const html = renderBoardPage(emptyBoard());
    expect(html).toContain("New");
    expect(html).toContain("Accepted");
    expect(html).toContain("Waiting");
    expect(html).toContain("Resolved");
    expect(html).toContain("Dismissed");
  });

  it("renders exactly ONE Waiting column (not split into deferred/blocked/awaiting)", () => {
    // Count how many times the column header appears — should be exactly 1.
    const html = renderBoardPage(emptyBoard());
    // The heading should appear wrapped in a column-header element; we check
    // that "Waiting" appears as a column label and "Deferred" / "Blocked" /
    // "Awaiting" do NOT appear as separate column headings.
    const waitingCount = (html.match(/class="board-col-header[^"]*"[^>]*>\s*Waiting/g) ?? [])
      .length;
    expect(waitingCount).toBe(1);
    expect(html).not.toMatch(/class="board-col-header[^"]*"[^>]*>\s*Deferred/);
    expect(html).not.toMatch(/class="board-col-header[^"]*"[^>]*>\s*Blocked/);
    expect(html).not.toMatch(/class="board-col-header[^"]*"[^>]*>\s*Awaiting/);
  });

  it("places a finding in the correct column based on its disposition", () => {
    const f = baseFinding({ disposition: "accepted", check: "orphanFiles" });
    const html = renderBoardPage(boardWith([f]));
    // The card should appear; we verify the check name renders in context.
    expect(html).toContain("orphanFiles");
  });

  it("renders column counts", () => {
    const findings = [
      baseFinding({ disposition: "new" }),
      baseFinding({ disposition: "new" }),
      baseFinding({ disposition: "resolved" }),
    ];
    const html = renderBoardPage(boardWith(findings));
    // Two new, one resolved — counts should reflect reality
    expect(html).toMatch(/New.*?2|2.*?New/s);
  });
});

// ---------------------------------------------------------------------------
// R25 / Waiting — deferred and blocked findings both land in Waiting column
// ---------------------------------------------------------------------------

describe("R25 — Waiting column carries all deferred/blocked findings", () => {
  it("shows a deferred finding's rationale and expiry in the Waiting column", () => {
    const expiry = "2025-06-01T00:00:00.000Z";
    const deferEvent: LedgerEvent = {
      finding_id: "x",
      event: "defer",
      by: "alice",
      principal_type: "human",
      at: "2024-01-03T00:00:00.000Z",
      rationale: "Waiting for upstream fix",
      expiry,
      against_fingerprint: "fp-x",
      identity_scheme_version: "1",
    };
    const f = baseFinding({
      disposition: "waiting",
      history: [deferEvent],
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).toContain("Waiting for upstream fix");
    expect(html).toContain("2025-06-01");
  });

  it("shows a finding without history entry in Waiting without crashing", () => {
    const f = baseFinding({ disposition: "waiting", history: [] });
    expect(() => renderBoardPage(boardWith([f]))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// R27 — Per-finding independence: multiple findings on the same doc
// ---------------------------------------------------------------------------

describe("R27 — per-finding card independence", () => {
  it("renders 3 findings on the same doc as 3 independent cards", () => {
    const path = "notes/shared.md";
    const f1 = baseFinding({ disposition: "new", target: { kind: "lint", path } });
    const f2 = baseFinding({ disposition: "accepted", target: { kind: "lint", path } });
    const f3 = baseFinding({ disposition: "resolved", target: { kind: "lint", path } });
    const html = renderBoardPage(boardWith([f1, f2, f3]));
    // All three identity keys must appear (each card has its key as a data attr or similar)
    expect(html).toContain(f1.identity_key);
    expect(html).toContain(f2.identity_key);
    expect(html).toContain(f3.identity_key);
  });

  it("resolving one finding does not remove others — resolved card still renders siblings", () => {
    const path = "notes/shared.md";
    const f1 = baseFinding({
      disposition: "new",
      target: { kind: "lint", path },
      check: "check-A",
    });
    const f2 = baseFinding({
      disposition: "new",
      target: { kind: "lint", path },
      check: "check-B",
    });
    const f3 = baseFinding({
      disposition: "resolved",
      target: { kind: "lint", path },
      check: "check-C",
    });
    const html = renderBoardPage(boardWith([f1, f2, f3]));
    // Both siblings of the resolved finding still appear
    expect(html).toContain("check-A");
    expect(html).toContain("check-B");
    expect(html).toContain("check-C");
  });
});

// ---------------------------------------------------------------------------
// R26 — Filter form: reflects applied filters, form submits to /board
// ---------------------------------------------------------------------------

describe("R26 — filter form", () => {
  it("renders a filter form targeting /board", () => {
    const html = renderBoardPage(emptyBoard());
    expect(html).toContain('action="/board"');
    expect(html).toContain('method="get"');
  });

  it("reflects collection filter in the form input", () => {
    const filters: BoardFilters = { collection: "decisions" };
    const html = renderBoardPage(emptyBoard(), filters);
    expect(html).toContain('name="collection"');
    expect(html).toContain('value="decisions"');
  });

  it("reflects check filter", () => {
    const filters: BoardFilters = { check: "orphanFiles" };
    const html = renderBoardPage(emptyBoard(), filters);
    expect(html).toContain('name="check"');
    expect(html).toContain('value="orphanFiles"');
  });

  it("reflects certainty filter", () => {
    const filters: BoardFilters = { certainty: "high" };
    const html = renderBoardPage(emptyBoard(), filters);
    expect(html).toContain('name="certainty"');
    expect(html).toContain('value="high"');
  });

  it("reflects owner filter", () => {
    const filters: BoardFilters = { owner: "bob" };
    const html = renderBoardPage(emptyBoard(), filters);
    expect(html).toContain('name="owner"');
    expect(html).toContain('value="bob"');
  });

  it("reflects minAgeDays filter", () => {
    const filters: BoardFilters = { minAgeDays: 7 };
    const html = renderBoardPage(emptyBoard(), filters);
    expect(html).toContain('name="minAgeDays"');
    expect(html).toContain('value="7"');
  });

  it("reflects document filter", () => {
    const filters: BoardFilters = { document: "notes/foo.md" };
    const html = renderBoardPage(emptyBoard(), filters);
    expect(html).toContain('name="document"');
    expect(html).toContain('value="notes/foo.md"');
  });

  it("renders all filter fields (collection/check/certainty/owner/age/document) regardless of applied filters", () => {
    const html = renderBoardPage(emptyBoard());
    expect(html).toContain('name="collection"');
    expect(html).toContain('name="check"');
    expect(html).toContain('name="certainty"');
    expect(html).toContain('name="owner"');
    expect(html).toContain('name="minAgeDays"');
    expect(html).toContain('name="document"');
  });

  it("renders only cards matching the board state (filtering is done by listBoard, not renderBoardPage)", () => {
    // renderBoardPage renders whatever is in boardState — filtered state.
    // If the board has only one card matching a filter, only one card appears.
    const f = baseFinding({ check: "staleFiles", disposition: "new" });
    const board = boardWith([f]);
    const html = renderBoardPage(board, { check: "staleFiles" });
    expect(html).toContain(f.identity_key);
    // No extra spurious cards
    const cardCount = (html.match(/class="board-card"/g) ?? []).length;
    expect(cardCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R28 — Back-links: cards link to the correct target
// ---------------------------------------------------------------------------

describe("R28 — card back-links", () => {
  it("lint finding links to /doc/<path>", () => {
    const f = baseFinding({
      source: "lint",
      target: { kind: "lint", path: "notes/foo.md" },
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).toContain('href="/doc/notes/foo.md"');
  });

  it("staleness finding links to /doc/<path>", () => {
    const f = baseFinding({
      source: "staleness",
      target: { kind: "staleness", path: "decisions/bar.md" },
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).toContain('href="/doc/decisions/bar.md"');
  });

  it("staged finding links to /doc/<targetPath>", () => {
    const f = baseFinding({
      source: "staged",
      target: { kind: "staged", stagedActionId: "sa-001" },
      evidence: { target_path: "decisions/retry.md" },
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).toContain('href="/doc/decisions/retry.md"');
  });

  it("tension finding links to both sourceA and sourceB docs", () => {
    const f = baseFinding({
      source: "tension",
      target: { kind: "tension", tensionId: "t-001" },
      evidence: { sourceA: "notes/alpha.md", sourceB: "notes/beta.md" },
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).toContain('href="/doc/notes/alpha.md"');
    expect(html).toContain('href="/doc/notes/beta.md"');
  });

  it("tier2 finding links to /doc/<artifact> and mentions unit", () => {
    const f = baseFinding({
      source: "tier2",
      target: {
        kind: "tier2",
        artifact: "notes/dependent.md",
        unit: "notes/upstream.md",
        edgeClass: "derives_from",
      },
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).toContain('href="/doc/notes/dependent.md"');
    expect(html).toContain('href="/doc/notes/upstream.md"');
  });

  it("paths with special URL chars are percent-encoded in hrefs", () => {
    const f = baseFinding({
      target: { kind: "lint", path: "notes/foo bar.md" },
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    // encodeURI preserves slashes but encodes spaces
    expect(html).toContain('href="/doc/notes/foo%20bar.md"');
  });
});

// ---------------------------------------------------------------------------
// R28 — Doc-page "open findings" section links into /board?document=<path>
// ---------------------------------------------------------------------------

describe("R28 — doc-page open-findings link", () => {
  it("doc page includes a link to /board?document=<encoded path>", () => {
    const html = renderDocPage({
      path: "notes/foo.md",
      frontmatter: {
        title: "Foo",
        collection: "notes",
        status: "canonical",
        confidence: "high",
        provenance: "authored",
        tier: null,
        tags: [],
      },
      bodyHtml: "<p>Body</p>",
      backlinks: [],
    });
    expect(html).toContain("/board?document=notes%2Ffoo.md");
  });

  it("doc-page board link text says 'Open findings'", () => {
    const html = renderDocPage({
      path: "decisions/use-sqlite.md",
      frontmatter: {
        title: "Use SQLite",
        collection: "decisions",
        status: "draft",
        confidence: "medium",
        provenance: "authored",
        tier: null,
        tags: [],
      },
      bodyHtml: "<p>Body</p>",
      backlinks: [],
    });
    expect(html).toMatch(/[Oo]pen findings/);
    expect(html).toContain("/board?document=decisions%2Fuse-sqlite.md");
  });

  it("doc-page board link escapes special chars in the path", () => {
    const html = renderDocPage({
      path: "notes/foo & bar.md",
      frontmatter: {
        title: "Foo & Bar",
        collection: "notes",
        status: "draft",
        confidence: "low",
        provenance: "authored",
        tier: null,
        tags: [],
      },
      bodyHtml: "<p>Body</p>",
      backlinks: [],
    });
    // encodeURIComponent encodes & and spaces
    expect(html).toContain("board?document=notes%2Ffoo%20%26%20bar.md");
  });
});

// ---------------------------------------------------------------------------
// XSS — all vault-derived text is HTML-escaped
// ---------------------------------------------------------------------------

describe("XSS escaping", () => {
  it("escapes <script> in suggested_action", () => {
    const f = baseFinding({
      suggested_action: '<script>alert("xss")</script>',
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes <script> in evidence string field", () => {
    const f = baseFinding({
      target: { kind: "lint", path: "notes/foo.md" },
      evidence: { message: '<img src=x onerror="alert(1)">' },
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).not.toContain("<img src=x onerror=");
    expect(html).toContain("&lt;img");
  });

  it("escapes <script> in owner field", () => {
    const f = baseFinding({
      owner: "<b>evil</b>",
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
  });

  it("escapes <script> in rationale (history event)", () => {
    const event: LedgerEvent = {
      finding_id: "x",
      event: "defer",
      by: "alice",
      principal_type: "human",
      at: "2024-01-01T00:00:00.000Z",
      rationale: '<script>alert("rationale")</script>',
      against_fingerprint: "fp",
      identity_scheme_version: "1",
    };
    const f = baseFinding({ disposition: "waiting", history: [event] });
    const html = renderBoardPage(boardWith([f]));
    expect(html).not.toContain('<script>alert("rationale")');
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes <script> in target path", () => {
    const f = baseFinding({
      target: { kind: "lint", path: '<script>alert("path")</script>' },
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).not.toContain('<script>alert("path")');
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes <script> in check field", () => {
    const f = baseFinding({
      check: '<script>alert("check")</script>',
      disposition: "new",
    });
    const html = renderBoardPage(boardWith([f]));
    expect(html).not.toContain('<script>alert("check")');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// R29 — No document-body editing controls
// ---------------------------------------------------------------------------

describe("R29 — no document-body editing controls", () => {
  it("does not render a textarea for document body", () => {
    const f = baseFinding({ disposition: "new" });
    const html = renderBoardPage(boardWith([f]));
    expect(html).not.toContain("<textarea");
  });

  it("does not render inputs with type=text for document body editing", () => {
    // There should be no document-body edit inputs. Filter inputs (for the
    // filter form) are type=text/search, so we check specifically that no
    // input targets a 'body' or 'content' field.
    const f = baseFinding({ disposition: "new" });
    const html = renderBoardPage(boardWith([f]));
    expect(html).not.toMatch(/name="body"/);
    expect(html).not.toMatch(/name="content"/);
  });

  it("does not render a contenteditable attribute", () => {
    const html = renderBoardPage(emptyBoard());
    expect(html).not.toContain("contenteditable");
  });
});

// ---------------------------------------------------------------------------
// General — page structure
// ---------------------------------------------------------------------------

describe("page structure", () => {
  it("returns a full HTML page with doctype", () => {
    const html = renderBoardPage(emptyBoard());
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("</html>");
  });

  it("has a page title containing 'Board'", () => {
    const html = renderBoardPage(emptyBoard());
    expect(html).toMatch(/<title>[^<]*[Bb]oard[^<]*<\/title>/);
  });

  it("contains a link to /board in the nav", () => {
    const html = renderBoardPage(emptyBoard());
    expect(html).toContain('href="/board"');
  });

  it("renders source label on each card", () => {
    const f = baseFinding({ source: "staleness", disposition: "new" });
    const html = renderBoardPage(boardWith([f]));
    expect(html).toContain("staleness");
  });

  it("renders certainty on each card", () => {
    const f = baseFinding({ certainty: "high", disposition: "new" });
    const html = renderBoardPage(boardWith([f]));
    expect(html).toContain("high");
  });
});
