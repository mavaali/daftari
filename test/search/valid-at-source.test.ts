// resolveValidAtSource — foregrounding the chain member whose interval covers
// a queried date.
//
// The rule that makes this safe: SUPERSESSION REACHABILITY IS NOT FACT
// IDENTITY. `superseded_by` is functional forward but a relation backward, and
// vault_merge manufactures fan-in on every merge. A walk that turned around at
// a merge node would reach a SIBLING lineage and foreground a document that
// never made the claim — with a verbatim snippet making it look sourced. So
// the two walks are direction-monotone and never turn.
//
// The disclosure rule is asymmetric for a reason. A forward `restricted`
// marker tells the caller nothing new: the seed's own frontmatter already
// contains `superseded_by: <path>`. A backward one would disclose a pure
// existence bit — an unreadable document exists and claims this one replaced
// it — reachable ONLY by a reverse-edge walk. That is Disposition A (omission)
// under the 2026-07-14 edge-graph existence-disclosure spec.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { resolveValidAtSource } from "../../src/search/valid-at-source.js";
import {
  type IndexDb,
  type IndexedDocument,
  insertDocument,
  openIndexDb,
} from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function doc(path: string, over: Partial<IndexedDocument> = {}): IndexedDocument {
  return {
    path,
    title: path,
    collection: path.split("/")[0] ?? "pricing",
    domain: "accumulation",
    status: "canonical",
    confidence: "high",
    updated: "2026-05-01",
    tags: [],
    content: `body of ${path}`,
    tokens: ["body"],
    ttlDays: null,
    created: "2026-01-01",
    supersededBy: null,
    validFrom: null,
    validUntil: null,
    ...over,
  };
}

const PRICING_ONLY: AccessContext = {
  user: "human:test",
  roleName: "analyst",
  role: { read: ["pricing"], write: [], promote: false, ratify: false },
};

describe("resolveValidAtSource", () => {
  let vault: string;
  let db: IndexDb;

  beforeEach(() => {
    vault = makeTempVault();
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    db = opened.value;
  });

  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("returns null when the seed itself covers the date", () => {
    insertDocument(db, doc("pricing/a.md", { validFrom: "2026-01-01", validUntil: "2026-12-31" }));
    expect(resolveValidAtSource(db, "pricing/a.md", "2026-06-01")).toBeNull();
  });

  it("returns null for an unknown seed path", () => {
    expect(resolveValidAtSource(db, "pricing/nope.md", "2026-06-01")).toBeNull();
  });

  it("walks FORWARD to the successor covering the date", () => {
    insertDocument(
      db,
      doc("pricing/v1.md", {
        supersededBy: "pricing/v2.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    insertDocument(db, doc("pricing/v2.md", { validFrom: "2026-04-01" }));

    const r = resolveValidAtSource(db, "pricing/v1.md", "2026-06-01");
    expect(r?.kind).toBe("resolved");
    if (r?.kind !== "resolved") return;
    expect(r.path).toBe("pricing/v2.md");
    expect(r.hops).toBe(1);
    expect(r.snippet).toContain("body of pricing/v2.md");
    expect(r.from).toBe("2026-04-01");
  });

  it("walks BACKWARD to the predecessor covering the date", () => {
    insertDocument(
      db,
      doc("pricing/v1.md", {
        supersededBy: "pricing/v2.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    insertDocument(db, doc("pricing/v2.md", { validFrom: "2026-04-01" }));

    const r = resolveValidAtSource(db, "pricing/v2.md", "2026-02-01");
    expect(r?.kind).toBe("resolved");
    if (r?.kind !== "resolved") return;
    expect(r.path).toBe("pricing/v1.md");
    expect(r.hops).toBe(1);
  });

  it("reports no-cover when no chain member covers the date", () => {
    insertDocument(
      db,
      doc("pricing/v1.md", {
        supersededBy: "pricing/v2.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    insertDocument(db, doc("pricing/v2.md", { validFrom: "2026-06-01" }));
    // 2026-04-15 falls in the gap between the two intervals.
    expect(resolveValidAtSource(db, "pricing/v1.md", "2026-04-15")?.kind).toBe("no-cover");
  });

  it("reports dangling when the forward chain points at a missing document", () => {
    insertDocument(
      db,
      doc("pricing/v1.md", { supersededBy: "pricing/gone.md", validUntil: "2026-03-31" }),
    );
    const r = resolveValidAtSource(db, "pricing/v1.md", "2026-06-01");
    expect(r?.kind).toBe("dangling");
    if (r?.kind !== "dangling") return;
    expect(r.brokenAt).toBe("pricing/v1.md");
  });

  it("reports cycle when the forward chain loops", () => {
    insertDocument(
      db,
      doc("pricing/a.md", { supersededBy: "pricing/b.md", validUntil: "2026-01-31" }),
    );
    insertDocument(
      db,
      doc("pricing/b.md", { supersededBy: "pricing/a.md", validUntil: "2026-01-31" }),
    );
    expect(resolveValidAtSource(db, "pricing/a.md", "2026-06-01")?.kind).toBe("cycle");
  });

  // --- the lineage-membership regression (design record, Decision 6) --------

  it("does NOT foreground a sibling lineage across a merge fan-in", () => {
    // vault_merge shape: two independent sources, one successor. Seeded at
    // source A, a walk that went forward to merged.md and then BACKWARD would
    // reach source B — a document that never made A's claim. The walk must be
    // direction-monotone, so B is unreachable from A.
    insertDocument(
      db,
      doc("pricing/source-a.md", {
        supersededBy: "pricing/merged.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    insertDocument(
      db,
      doc("pricing/source-b.md", {
        supersededBy: "pricing/merged.md",
        validFrom: "2025-01-01",
        validUntil: "2025-12-31",
      }),
    );
    insertDocument(db, doc("pricing/merged.md", { validFrom: "2026-04-01" }));

    // 2025-06-01 is covered ONLY by source-b, which is a sibling of the seed.
    const r = resolveValidAtSource(db, "pricing/source-a.md", "2025-06-01");
    expect(r?.kind).not.toBe("resolved");
    expect(r?.kind).toBe("no-cover");
  });

  it("reports ambiguous rather than picking a winner on backward fan-in", () => {
    // Seeded AT the merge node, both predecessors are legitimately reachable
    // backward. If both cover the date, an honest refusal beats a stable but
    // arbitrary answer.
    insertDocument(
      db,
      doc("pricing/source-a.md", {
        supersededBy: "pricing/merged.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    insertDocument(
      db,
      doc("pricing/source-b.md", {
        supersededBy: "pricing/merged.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    insertDocument(db, doc("pricing/merged.md", { validFrom: "2026-04-01" }));

    const r = resolveValidAtSource(db, "pricing/merged.md", "2026-02-01");
    expect(r?.kind).toBe("ambiguous");
    if (r?.kind !== "ambiguous") return;
    expect(r.count).toBe(2);
  });

  // --- the disclosure regression (design record, Decision 6) ----------------

  it("degrades a FORWARD unreadable hop to a path-free restricted marker", () => {
    insertDocument(
      db,
      doc("pricing/v1.md", {
        supersededBy: "secret/v2.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    insertDocument(db, doc("secret/v2.md", { collection: "secret", validFrom: "2026-04-01" }));

    const r = resolveValidAtSource(db, "pricing/v1.md", "2026-06-01", PRICING_ONLY);
    expect(r?.kind).toBe("restricted");
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("emits NO marker for an unreadable predecessor on the backward walk", () => {
    // The seed's frontmatter says nothing about who it replaced. A `restricted`
    // here would be a pure existence disclosure obtained from a reverse edge.
    insertDocument(
      db,
      doc("secret/v1.md", {
        collection: "secret",
        supersededBy: "pricing/v2.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    insertDocument(db, doc("pricing/v2.md", { validFrom: "2026-04-01" }));

    const r = resolveValidAtSource(db, "pricing/v2.md", "2026-02-01", PRICING_ONLY);
    expect(r?.kind).not.toBe("restricted");
    expect(r?.kind).toBe("no-cover");
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("continues the backward walk PAST an unreadable predecessor", () => {
    // readable(v3) <- unreadable(v2) <- readable(v1). Seeded at v3, the walk
    // must skip v2 silently and still find v1.
    insertDocument(
      db,
      doc("pricing/v1.md", {
        supersededBy: "secret/v2.md",
        validFrom: "2026-01-01",
        validUntil: "2026-01-31",
      }),
    );
    insertDocument(
      db,
      doc("secret/v2.md", {
        collection: "secret",
        supersededBy: "pricing/v3.md",
        validFrom: "2026-02-01",
        validUntil: "2026-02-28",
      }),
    );
    insertDocument(db, doc("pricing/v3.md", { validFrom: "2026-03-01" }));

    const r = resolveValidAtSource(db, "pricing/v3.md", "2026-01-15", PRICING_ONLY);
    expect(r?.kind).toBe("resolved");
    if (r?.kind !== "resolved") return;
    expect(r.path).toBe("pricing/v1.md");
  });

  it("counts only readable members when reporting ambiguous", () => {
    insertDocument(
      db,
      doc("pricing/a.md", {
        supersededBy: "pricing/merged.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    insertDocument(
      db,
      doc("secret/b.md", {
        collection: "secret",
        supersededBy: "pricing/merged.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    insertDocument(db, doc("pricing/merged.md", { validFrom: "2026-04-01" }));

    // Only pricing/a.md is readable, so this is a single unambiguous answer.
    const r = resolveValidAtSource(db, "pricing/merged.md", "2026-02-01", PRICING_ONLY);
    expect(r?.kind).toBe("resolved");
    if (r?.kind !== "resolved") return;
    expect(r.path).toBe("pricing/a.md");
  });

  it("ignores chain members with no authored interval", () => {
    insertDocument(
      db,
      doc("pricing/v1.md", { supersededBy: "pricing/v2.md", validUntil: "2026-03-31" }),
    );
    insertDocument(db, doc("pricing/v2.md"));
    // v2 authors nothing, so it cannot cover anything — absence is not evidence.
    expect(resolveValidAtSource(db, "pricing/v1.md", "2026-06-01")?.kind).toBe("no-cover");
  });
});
