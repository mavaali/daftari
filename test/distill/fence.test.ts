// test/distill/fence.test.ts
//
// U11 — distill-and-discard fence. Distill COMPILES; it must never emit raw
// source material. Two landing invariants, enforced at emit time as
// defense-in-depth (the emitter hardcodes a synthesized, distill-collection
// proposal, so these should never fire in normal operation — but a bad path
// override or a future refactor must fail loud, not pollute the
// import-reserved raw tier):
//   1. No target under a top-level `raw/` segment (reserved for daftari import).
//   2. No `tier: source` frontmatter — that IS the raw-ingested marker,
//      immutable to every writer; distill output is compiled, not source.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listStagedActions } from "../../src/curation/staged-actions.js";
import type { ExtractedClaim } from "../../src/distill/extract.js";
import { refuseRawDistillOutput } from "../../src/distill/output-fence.js";
import { DISTILL_COLLECTION, proposeAllClaims } from "../../src/distill/propose.js";

// ---------------------------------------------------------------------------
// Pure guard
// ---------------------------------------------------------------------------

describe("refuseRawDistillOutput (U11)", () => {
  const synthesized = {
    collection: DISTILL_COLLECTION,
    provenance: "synthesized",
    status: "draft",
  };

  it("allows a normal synthesized distill-collection proposal", () => {
    const r = refuseRawDistillOutput("distill/chat-a/x--aabbccdd.md", synthesized);
    expect(r.ok).toBe(true);
  });

  it("refuses a top-level raw/ landing (reserved for daftari import)", () => {
    const r = refuseRawDistillOutput("raw/chat-a/x.md", synthesized);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/raw\//);
  });

  it("refuses tier: source output (raw-ingested marker, never distill's)", () => {
    const r = refuseRawDistillOutput("distill/chat-a/x--aabbccdd.md", {
      ...synthesized,
      tier: "source",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/source/);
  });

  it("does not false-positive when 'raw' is a non-leading path segment", () => {
    // 'raw' only matters as the top-level import-reserved namespace; a distill
    // sub-path or slug that merely contains the substring must still pass.
    expect(refuseRawDistillOutput("distill/raw-notes/brawl--aabbccdd.md", synthesized).ok).toBe(
      true,
    );
  });

  it("normalizes backslash separators before checking the leading segment", () => {
    const r = refuseRawDistillOutput("raw\\chat-a\\x.md", synthesized);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enforced at the emit chokepoint
// ---------------------------------------------------------------------------

describe("proposeAllClaims enforces the distill output fence (U11)", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-distill-fence-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  const claim: ExtractedClaim = {
    claim_key: "chunk-001:the-secret-is-sapphire-aabbccdd",
    statement: "The secret is sapphire.",
    proposed_frontmatter: { title: "The secret is sapphire." },
  };

  it("stages a normal claim under the distill collection with no raw leakage", async () => {
    const out = await proposeAllClaims(vault, [claim], { sourceId: "chat-a", runId: "r1" });
    expect(out.errors).toHaveLength(0);
    const listed = await listStagedActions(vault, "pending");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0].targetPath.startsWith(`${DISTILL_COLLECTION}/`)).toBe(true);
    expect(listed.value.some((a) => a.targetPath.split("/")[0] === "raw")).toBe(false);
  });

  it("refuses (does not stage) a claim forced to a raw/ path via override", async () => {
    const out = await proposeAllClaims(
      vault,
      [claim],
      { sourceId: "chat-a", runId: "r1" },
      { [claim.claim_key]: "raw/leak.md" },
    );
    expect(out.proposed).toBe(0);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.error).toMatch(/raw\//);

    // Nothing landed in the import-reserved namespace.
    const listed = await listStagedActions(vault, "pending");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(0);
  });
});

describe("refuseRawDistillOutput against an overridden collection (#506)", () => {
  it("allows a normal synthesized proposal under a non-default collection", () => {
    const r = refuseRawDistillOutput("sensitive-reports/m365-item/x--aabbccdd.md", {
      collection: "sensitive-reports",
      provenance: "synthesized",
      status: "draft",
    });
    expect(r.ok).toBe(true);
  });

  it("still refuses a top-level raw/ landing even when it came from a collection override", () => {
    // The fence is purely structural (path + frontmatter.tier); it must fire
    // identically regardless of which collection produced the path.
    const r = refuseRawDistillOutput("raw/m365-item/x.md", {
      collection: "raw",
      provenance: "synthesized",
      status: "draft",
    });
    expect(r.ok).toBe(false);
  });
});
