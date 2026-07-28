// Validity columns on `documents`, and the reverse supersession edge.
//
// Two things matter here. First, the index normalizes what the frontmatter
// layer deliberately preserves raw: a malformed valid_from stays verbatim on
// disk (#113) but must not reach date-math consumers, so it lands as NULL —
// distinct from `created`'s "" sentinel, because these fields are optional and
// NULL already means valid-time-unknown.
//
// Second, `supersessionPredecessors` returns an ARRAY. `superseded_by` is
// functional forward but a relation backward — vault_merge points two sources
// at one successor on every merge — so anything walking the chain backward has
// to handle fan-in rather than assume a scalar.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import {
  getDocument,
  type IndexDb,
  type IndexedDocument,
  insertDocument,
  openIndexDb,
  supersessionPredecessors,
} from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function doc(over: Partial<IndexedDocument> & Pick<IndexedDocument, "path">): IndexedDocument {
  return {
    title: "T",
    collection: "pricing",
    domain: "accumulation",
    status: "canonical",
    confidence: "high",
    updated: "2026-05-01",
    tags: [],
    content: "body",
    tokens: ["body"],
    ttlDays: null,
    created: "2026-01-01",
    supersededBy: null,
    validFrom: null,
    validUntil: null,
    ...over,
  };
}

describe("validity columns", () => {
  let vault: string;
  let db: IndexDb;

  beforeEach(() => {
    vault = makeTempVault();
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
    if (!opened.ok) throw opened.error;
    db = opened.value;
  });

  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("round-trips both endpoints", () => {
    insertDocument(
      db,
      doc({ path: "pricing/pro.md", validFrom: "2026-01-01", validUntil: "2026-03-31" }),
    );
    const read = getDocument(db, "pricing/pro.md");
    expect(read?.validFrom).toBe("2026-01-01");
    expect(read?.validUntil).toBe("2026-03-31");
  });

  it("stores absent endpoints as null", () => {
    insertDocument(db, doc({ path: "pricing/pro.md" }));
    const read = getDocument(db, "pricing/pro.md");
    expect(read?.validFrom).toBeNull();
    expect(read?.validUntil).toBeNull();
  });

  it("stores an open-ended interval with a null upper endpoint", () => {
    insertDocument(db, doc({ path: "pricing/pro.md", validFrom: "2026-04-01" }));
    const read = getDocument(db, "pricing/pro.md");
    expect(read?.validFrom).toBe("2026-04-01");
    expect(read?.validUntil).toBeNull();
  });

  it("normalizes a malformed endpoint to null rather than poisoning date math", () => {
    insertDocument(
      db,
      doc({ path: "pricing/pro.md", validFrom: "January 2026", validUntil: "2026-13-45" }),
    );
    const read = getDocument(db, "pricing/pro.md");
    expect(read?.validFrom).toBeNull();
    expect(read?.validUntil).toBeNull();
  });

  it("updates the columns on re-insert of the same path", () => {
    insertDocument(db, doc({ path: "pricing/pro.md", validFrom: "2026-01-01" }));
    insertDocument(db, doc({ path: "pricing/pro.md", validFrom: "2026-02-01" }));
    expect(getDocument(db, "pricing/pro.md")?.validFrom).toBe("2026-02-01");
  });
});

describe("supersessionPredecessors", () => {
  let vault: string;
  let db: IndexDb;

  beforeEach(() => {
    vault = makeTempVault();
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM, "float32");
    if (!opened.ok) throw opened.error;
    db = opened.value;
  });

  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("returns an empty array when nothing points at the path", () => {
    insertDocument(db, doc({ path: "pricing/pro.md" }));
    expect(supersessionPredecessors(db, "pricing/pro.md")).toEqual([]);
  });

  it("finds the single document superseded by the given path", () => {
    insertDocument(db, doc({ path: "pricing/pro-v1.md", supersededBy: "pricing/pro-v2.md" }));
    insertDocument(db, doc({ path: "pricing/pro-v2.md" }));
    const preds = supersessionPredecessors(db, "pricing/pro-v2.md");
    expect(preds.map((p) => p.path)).toEqual(["pricing/pro-v1.md"]);
  });

  it("returns every predecessor on fan-in, ordered by path", () => {
    // What vault_merge produces: two sources, one successor.
    insertDocument(db, doc({ path: "pricing/b.md", supersededBy: "pricing/merged.md" }));
    insertDocument(db, doc({ path: "pricing/a.md", supersededBy: "pricing/merged.md" }));
    insertDocument(db, doc({ path: "pricing/merged.md" }));
    const preds = supersessionPredecessors(db, "pricing/merged.md");
    expect(preds.map((p) => p.path)).toEqual(["pricing/a.md", "pricing/b.md"]);
  });

  it("carries the predecessor's validity endpoints", () => {
    insertDocument(
      db,
      doc({
        path: "pricing/pro-v1.md",
        supersededBy: "pricing/pro-v2.md",
        validFrom: "2026-01-01",
        validUntil: "2026-03-31",
      }),
    );
    const [pred] = supersessionPredecessors(db, "pricing/pro-v2.md");
    expect(pred?.validFrom).toBe("2026-01-01");
    expect(pred?.validUntil).toBe("2026-03-31");
  });

  it("does not treat a document as its own predecessor", () => {
    insertDocument(db, doc({ path: "pricing/pro.md" }));
    expect(supersessionPredecessors(db, "pricing/pro.md")).toEqual([]);
  });
});
