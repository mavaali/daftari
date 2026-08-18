import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import type { TensionEntry } from "../../src/curation/tension.js";
import {
  canSeeTension,
  sourceVerifiable,
  visibleTensions,
} from "../../src/curation/tension-access.js";
import { deleteDocument } from "../../src/storage/index-db.js";
import { openIndexForAccessOrNull } from "../../src/tools/search.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// Pure segment-rule tests: db null throughout. The indexed-row branch of
// collectionForPath is pinned in test/storage/index-db.test.ts; e2e coverage
// of handlers passing a real db lives in test/tools/curation.test.ts.
const role = (read: string[]): AccessContext => ({
  user: "t",
  roleName: "r",
  role: { read, write: [], promote: false, ratify: false },
});

const entry = (sourceA: string, sourceB: string): TensionEntry => ({
  date: "2026-07-12",
  title: "t",
  kind: "factual",
  sourceA,
  claimA: "a",
  sourceB,
  claimB: "b",
  status: "unresolved",
  loggedBy: "test",
  resolved: false,
});

const AGENT = "agent:compiler";
const fm = (o = {}) => ({
  title: "T",
  domain: "accumulation",
  collection: "pricing",
  status: "draft",
  confidence: "medium",
  created: "2026-07-01",
  provenance: "direct",
  sources: [],
  superseded_by: null,
  ttl_days: null,
  tags: [],
  ...o,
});

describe("tension-access", () => {
  it("an alias path never widens visibility", () => {
    // secret/../pricing/x.md canonicalizes to pricing/x.md (readable), but
    // pricing/../secret/x.md canonicalizes to secret/x.md (not readable).
    const r = role(["pricing", "intel"]);
    expect(canSeeTension(null, r, "secret/../pricing/a.md", "intel/b.md")).toBe(true);
    expect(canSeeTension(null, r, "pricing/../secret/a.md", "intel/b.md")).toBe(false);
  });

  it("requires read on BOTH sides, in either direction", () => {
    const pricingOnly = role(["pricing"]);
    expect(canSeeTension(null, pricingOnly, "pricing/a.md", "intel/b.md")).toBe(false);
    expect(canSeeTension(null, pricingOnly, "intel/b.md", "pricing/a.md")).toBe(false);
    expect(canSeeTension(null, role(["pricing", "intel"]), "pricing/a.md", "intel/b.md")).toBe(
      true,
    );
    expect(canSeeTension(null, pricingOnly, "pricing/a.md", "pricing/b.md")).toBe(true);
  });

  it("errs closed on escaping or blank sides for every role", () => {
    const wildcardless = role(["pricing", "..", ""]); // even a weird config cannot match
    expect(canSeeTension(null, wildcardless, "../escape.md", "pricing/a.md")).toBe(false);
    expect(canSeeTension(null, wildcardless, "", "pricing/a.md")).toBe(false);
  });

  it("access undefined means everything is visible", () => {
    expect(canSeeTension(null, undefined, "secret/a.md", "hidden/b.md")).toBe(true);
  });

  it("visibleTensions drops only invisible entries and preserves order", () => {
    const entries = [
      entry("pricing/a.md", "pricing/b.md"),
      entry("pricing/a.md", "secret/x.md"),
      entry("intel/c.md", "pricing/d.md"),
    ];
    const out = visibleTensions(null, entries, role(["pricing", "intel"]));
    expect(out).toEqual([entries[0], entries[2]]);
    expect(visibleTensions(null, entries, undefined)).toEqual(entries);
  });
});

describe("sourceVerifiable", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => cleanupVault(vault));

  it("null db ⇒ verifiable (cannot tell, do not cry wolf)", () => {
    expect(sourceVerifiable(null, undefined, "pricing/x.md")).toBe(true);
  });

  it("present + readable ⇒ verifiable; evicted ⇒ not", async () => {
    const w = await vaultWrite(vault, {
      path: "pricing/x.md",
      body: "# X\n",
      frontmatter: fm(),
      agent: AGENT,
    });
    if (!w.ok) throw w.error;
    const db = openIndexForAccessOrNull(vault);
    try {
      expect(sourceVerifiable(db, undefined, "pricing/x.md")).toBe(true);
      deleteDocument(db!, "pricing/x.md");
      expect(sourceVerifiable(db, undefined, "pricing/x.md")).toBe(false);
    } finally {
      db?.close();
    }
  }, 60_000);

  it("present but unreadable collection ⇒ not verifiable", async () => {
    const w = await vaultWrite(vault, {
      path: "competitive-intel/s.md",
      body: "# S\n",
      frontmatter: fm({ collection: "competitive-intel" }),
      agent: AGENT,
    });
    if (!w.ok) throw w.error;
    const db = openIndexForAccessOrNull(vault);
    try {
      const pricingOnly = {
        user: "human:n",
        roleName: "pricing-only",
        role: { read: ["pricing"], write: [], promote: false, ratify: false },
      };
      expect(sourceVerifiable(db, pricingOnly, "competitive-intel/s.md")).toBe(false);
    } finally {
      db?.close();
    }
  }, 60_000);
});
