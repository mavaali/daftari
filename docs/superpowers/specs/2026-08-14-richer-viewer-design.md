# Richer Vault Viewer — Design

Readiness: requirements-only
Follows: `daftari view` (3.4.0). Epic to be filed in beads.
Status: phased; Phase 1 (epistemic surface) is the first build.

## Problem

`daftari view` (3.4.0) renders documents, frontmatter, backlinks, a contested panel, and search. It is honest MVP but reads as a generic markdown viewer. A generic reader is commoditized; daftari should not compete there. The reframe: **the viewer's job is to make daftari's epistemic state and knowledge graph legible and navigable — the moat made visible**, not to render prose more prettily. This is the host-side complement to the embodiment/separability positioning: a bare library can hold graded, contested, decaying knowledge; a host that lets a human *see and walk* that state is what a library alone cannot offer.

## Architecture decision — C, built API-first (B-ready)

The viewer stays **server-rendered over `node:http` with minimal vanilla JS**, plus **one lazy-loaded graph library on the graph route only** (option C). It does **not** become an SPA (option B) now.

The load-bearing rule that keeps B a clean future upgrade rather than a rewrite:

- **Every page reads from a JSON data contract; HTML is never rendered straight from internal objects.** The server grows small read-only JSON endpoints (`/api/*`); the HTML page builders render *from those DTOs*; the graph route's client lib fetches the same JSON.
- Then B (a bundled client app, someday) is a **presentation swap against the same API** — the server (routes, RBAC, host-guard, all `vault_read`/edges/search computation) carries over wholesale. C already breaks the "no client JS" barrier, so B becomes a matter of degree, not category.

All `/api/*` routes inherit the existing loopback Host guard and are read-only (GET). No mutation, ever.

## What already exists (reuse, don't rebuild)

- **`vault_read`** already computes `decay`, `validity`, `upstream_staleness`, `structural` (orphan / deprecated-still-linked), `contested`, supersession, provenance, anchors — the entire epistemic surface is *data that already exists and simply is not shown*.
- **`vault_edges` / `vault_consumes` / reverse-source & reverse-link maps** — the graph's edges.
- **`vault_status` / `daftari sleep` (SleepCycleResult) / run-ledger / `daftari court` docket** — the dashboard's numbers.
- **`vault_themes`** — clustering for the graph/nav.
- **Existing viewer** — layout, render pipeline (`unified`+`rehype-sanitize`), host-guard, search route.

## Graph library (Phase 2)

**Cytoscape.js**, vendored as a single minified static asset served by the viewer (not hot-linked — offline ethos), lazy-loaded only on the graph route. Mature, canvas rendering, built-in pan/zoom/click/filter, no build step. Alternative if vaults exceed a few thousand nodes: **Sigma** (WebGL). Decision recorded; revisit at scale.

---

## Phase 1 — Epistemic surface (first build)

Surface the state `vault_read` already computes, on the doc page.

- **R1** — A JSON endpoint `GET /api/doc/<path>` returns the full read DTO: frontmatter, computed `decay`, `validity`, `upstream_staleness`, `structural`, `contested`, supersession chain, provenance/anchors, backlinks. Read-only, host-guarded, RBAC-off (loopback).
- **R2** — The doc HTML page renders **from that DTO** (the B-seam): a decay/staleness banner when decayed; validity (valid-time) when present; an upstream-staleness callout listing compiled inputs that changed; a structural warning (orphan / deprecated-still-linked); the supersession chain; confidence/status/tier/provenance as badges.
- **R3** — Existing panels (rendered markdown, backlinks, contested) are folded into the same DTO-driven page; no regression.
- **R4** — Absent/null computed fields render as *nothing* (not "unknown"), matching the annotate-when-present idiom; a doc with no decay shows no banner.

## Phase 2 — Graph view

- **R5** — `GET /api/graph?scope=all|ego&root=<path>&depth=<n>` returns `{nodes, edges}`: nodes carry path, title, collection, tier, status, and a decay/contested flag; edges carry kind (`source`/`link`/`derives_from`/`consumes`/`contested`). Ego scope returns the neighborhood of `root` to `depth`.
- **R6** — A `/graph` route serves an HTML shell that lazy-loads the vendored graph lib and renders `/api/graph`; clicking a node navigates to `/doc/<path>`; filters by collection/tier/status; contested and decayed nodes are visually flagged.
- **R7** — The doc page links to its ego-graph (`/graph?scope=ego&root=<path>`).
- **R8** — Graph degrades gracefully: an empty vault renders an empty canvas with a message; a huge graph is capped (node limit with a "showing N of M" notice) rather than hanging the browser.

## Phase 3 — Dashboard home

- **R9** — `GET /api/status` returns vault metrics (from `vault_status`), the latest `sleep` summary + run-ledger trend, staleness buckets, open-tension count, and ratification-queue size.
- **R10** — The home route becomes a dashboard rendered from `/api/status`; the collection index moves under it (or a `/docs` route). Tiles link into the relevant surfaces (tensions → court view, stale → the wake list).

## Phase 4 — Render polish

- **R11** — Mermaid rendering, code syntax highlighting, in-vault wikilink/relative-link resolution to `/doc/<path>`, heading anchors + a per-doc table of contents. Each is additive and independently shippable.

---

## Data flow — four paths (Phase 1, representative)

- **Happy:** doc exists → DTO with computed reports → full page.
- **Empty/nil:** doc exists, all reports null (fresh, unlinked-but-not-orphan) → clean page, no banners (R4).
- **Error:** malformed path / read failure → themed 500, host-guard unaffected.
- **Upstream failure:** `loadDocuments`/index unavailable → 500 with the reason; graph/search degrade to empty, never a false-empty presented as truth.

## NOT in scope

- Option B (SPA/bundler/client framework) — deliberately deferred; the JSON contract keeps it a clean future upgrade.
- Editing / any mutation from the UI — the viewer is read-only, permanently.
- Auth / non-loopback hosting — loopback-only stands.
- Hot-linked CDN assets — the graph lib is vendored for offline use.
- Real-time / websockets — pages are request-scoped snapshots.

## Failure-mode check

- **Succeeds wildly (huge vault):** the graph is the risk — cap nodes (R8), offer ego-scope by default from a doc, keep whole-vault behind an explicit toggle. `/api/*` are O(docs) like existing curation; acceptable.
- **Fails:** everything is read-only — worst case is a stale/empty read, never data loss or a mutation.
- **6-month consequence:** the JSON contract is the durable asset. If the viewer earns product status, B is a presentation swap; if it doesn't, C stays lightweight and in-grain. The one debt to avoid is tangling HTML with internal objects — the spec forbids it (R2 seam).

## Sequencing

Phase 1 → 2 → 3 → 4, each its own PR. Phase 1 needs no new dependency (pure reuse) and is the highest differentiation-per-effort. Phase 2 introduces the single vendored graph asset. Phases 3–4 are additive polish.
