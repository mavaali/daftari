import { describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import type { TensionEntry } from "../../src/curation/tension.js";
import { canSeeTension, visibleTensions } from "../../src/curation/tension-access.js";

// Pure segment-rule tests: db null throughout. The indexed-row branch of
// collectionForPath is pinned in test/storage/index-db.test.ts; e2e coverage
// of handlers passing a real db will live in test/tools/curation.test.ts once
// the handlers are wired — Tasks 4-5.
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
