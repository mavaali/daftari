// Supersession suppression pass (MAV-161): demote stale hits, foreground
// their current heads. Gated off by default; only `kind: "resolved"` chains
// participate; nothing is ever dropped.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HybridHit } from "../../src/search/hybrid.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import {
  applySupersededSuppression,
  setSuppressSuperseded,
  suppressSuperseded,
} from "../../src/search/suppression.js";
import {
  type IndexDb,
  type IndexedDocument,
  insertDocument,
  openIndexDb,
} from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function doc(over: Partial<IndexedDocument> & { path: string }): IndexedDocument {
  return {
    path: over.path,
    title: over.title ?? over.path,
    collection: over.collection ?? "notes",
    domain: "accumulation",
    status: over.status ?? "canonical",
    confidence: "high",
    updated: over.updated ?? "2026-05-01",
    tags: over.tags ?? [],
    content: over.content ?? "body",
    tokens: [],
    ttlDays: null,
    created: over.created ?? "2026-01-01",
    supersededBy: over.supersededBy ?? null,
  };
}
function hit(path: string): HybridHit {
  return {
    path,
    title: path,
    collection: "notes",
    status: "canonical",
    score: 1,
    bm25Score: 1,
    vectorScore: 0,
    snippet: "",
    decay: null,
  };
}

describe("applySupersededSuppression", () => {
  let vault: string;
  let db: IndexDb;
  beforeEach(() => {
    vault = makeTempVault();
    const o = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!o.ok) throw o.error;
    db = o.value;
    setSuppressSuperseded(true);
  });
  afterEach(() => {
    setSuppressSuperseded(false);
    db.close();
    cleanupVault(vault);
  });

  it("defaults to off and no-ops when gated", () => {
    setSuppressSuperseded(false);
    expect(suppressSuperseded()).toBe(false);
    insertDocument(db, doc({ path: "old.md", supersededBy: "new.md" }));
    insertDocument(db, doc({ path: "new.md" }));
    const hits = [hit("old.md")];
    const out = applySupersededSuppression(db, hits, undefined, { pullIn: true });
    expect(out).toEqual(hits);
    expect(out.filter((h) => h.demoted).length).toBe(0);
    expect(out.some((h) => h.viaForeground)).toBe(false);
  });

  it("pulls the absent head into the stale hit's slot and demotes the stale hit", () => {
    insertDocument(db, doc({ path: "old.md", supersededBy: "new.md" }));
    insertDocument(db, doc({ path: "new.md", content: "the current value" }));
    insertDocument(db, doc({ path: "other.md" }));
    const out = applySupersededSuppression(db, [hit("old.md"), hit("other.md")], undefined, {
      pullIn: true,
    });
    // Head occupies old.md's rank slot; old.md moves to the tail, flagged.
    expect(out.map((h) => h.path)).toEqual(["new.md", "other.md", "old.md"]);
    expect(out[0].viaForeground).toBe(true);
    expect(out[0].score).toBe(0);
    expect(out[0].snippet).toContain("the current value");
    expect(out[2].demoted).toBe("superseded");
    expect(out.filter((h) => h.demoted).length).toBe(1);
  });

  it("demotes without duplicating when the head is already ranked", () => {
    insertDocument(db, doc({ path: "old.md", supersededBy: "new.md" }));
    insertDocument(db, doc({ path: "new.md" }));
    const out = applySupersededSuppression(db, [hit("old.md"), hit("new.md")], undefined, {
      pullIn: true,
    });
    expect(out.map((h) => h.path)).toEqual(["new.md", "old.md"]);
    expect(out.filter((h) => h.viaForeground)).toEqual([]);
    expect(out[1].demoted).toBe("superseded");
  });

  it("pulls a shared head once for two stale hits", () => {
    insertDocument(db, doc({ path: "a.md", supersededBy: "head.md" }));
    insertDocument(db, doc({ path: "b.md", supersededBy: "head.md" }));
    insertDocument(db, doc({ path: "head.md" }));
    const out = applySupersededSuppression(db, [hit("a.md"), hit("b.md")], undefined, {
      pullIn: true,
    });
    expect(out.map((h) => h.path)).toEqual(["head.md", "a.md", "b.md"]);
    expect(out.filter((h) => h.viaForeground).length).toBe(1);
    expect(out.filter((h) => h.demoted).length).toBe(2);
  });

  it("walks a multi-hop chain to the terminal head", () => {
    insertDocument(db, doc({ path: "v1.md", supersededBy: "v2.md" }));
    insertDocument(db, doc({ path: "v2.md", supersededBy: "v3.md" }));
    insertDocument(db, doc({ path: "v3.md" }));
    const out = applySupersededSuppression(db, [hit("v1.md")], undefined, { pullIn: true });
    expect(out.map((h) => h.path)).toEqual(["v3.md", "v1.md"]);
  });

  it("leaves dangling and cyclic chains untouched — no head to offer", () => {
    insertDocument(db, doc({ path: "dangling.md", supersededBy: "gone.md" }));
    insertDocument(db, doc({ path: "loop-a.md", supersededBy: "loop-b.md" }));
    insertDocument(db, doc({ path: "loop-b.md", supersededBy: "loop-a.md" }));
    const hits = [hit("dangling.md"), hit("loop-a.md")];
    const out = applySupersededSuppression(db, hits, undefined, { pullIn: true });
    expect(out.map((h) => h.path)).toEqual(["dangling.md", "loop-a.md"]);
    expect(out.filter((h) => h.demoted).length).toBe(0);
    for (const h of out) expect(h.demoted).toBeUndefined();
  });

  it("pullIn: false (the mount posture) demotes but never adds", () => {
    insertDocument(db, doc({ path: "old.md", supersededBy: "new.md" }));
    insertDocument(db, doc({ path: "new.md" }));
    insertDocument(db, doc({ path: "other.md" }));
    const out = applySupersededSuppression(db, [hit("old.md"), hit("other.md")], undefined, {
      pullIn: false,
    });
    expect(out.map((h) => h.path)).toEqual(["other.md", "old.md"]);
    expect(out.some((h) => h.viaForeground)).toBe(false);
    expect(out[1].demoted).toBe("superseded");
  });

  it("caches currentSource on inspected hits so enrichment need not re-walk", () => {
    insertDocument(db, doc({ path: "old.md", supersededBy: "new.md" }));
    insertDocument(db, doc({ path: "new.md" }));
    const stale = hit("old.md");
    applySupersededSuppression(db, [stale], undefined, { pullIn: true });
    expect(stale.currentSource?.kind).toBe("resolved");
  });
});
