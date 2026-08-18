import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceVerifiable } from "../../src/curation/tension-access.js";
import { openIndexForAccessOrNull } from "../../src/tools/search.js";
import { deleteDocument } from "../../src/storage/index-db.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:compiler";
const fm = (o = {}) => ({
  title: "T", domain: "accumulation", collection: "pricing", status: "draft",
  confidence: "medium", created: "2026-07-01", provenance: "direct",
  sources: [], superseded_by: null, ttl_days: null, tags: [], ...o,
});

describe("sourceVerifiable", () => {
  let vault: string;
  beforeEach(() => { vault = makeTempVault(); });
  afterEach(() => cleanupVault(vault));

  it("null db ⇒ verifiable (cannot tell, do not cry wolf)", () => {
    expect(sourceVerifiable(null, undefined, "pricing/x.md")).toBe(true);
  });

  it("present + readable ⇒ verifiable; evicted ⇒ not", async () => {
    const w = await vaultWrite(vault, { path: "pricing/x.md", body: "# X\n", frontmatter: fm(), agent: AGENT });
    if (!w.ok) throw w.error;
    const db = openIndexForAccessOrNull(vault);
    try {
      expect(sourceVerifiable(db, undefined, "pricing/x.md")).toBe(true);
      deleteDocument(db!, "pricing/x.md");
      expect(sourceVerifiable(db, undefined, "pricing/x.md")).toBe(false);
    } finally { db?.close(); }
  }, 60_000);

  it("present but unreadable collection ⇒ not verifiable", async () => {
    const w = await vaultWrite(vault, { path: "competitive-intel/s.md", body: "# S\n", frontmatter: fm({ collection: "competitive-intel" }), agent: AGENT });
    if (!w.ok) throw w.error;
    const db = openIndexForAccessOrNull(vault);
    try {
      const pricingOnly = { user: "human:n", roleName: "pricing-only", role: { read: ["pricing"], write: [], promote: false, ratify: false } };
      expect(sourceVerifiable(db, pricingOnly, "competitive-intel/s.md")).toBe(false);
    } finally { db?.close(); }
  }, 60_000);
});
