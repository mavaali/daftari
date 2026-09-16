// 6mf.1: vault_merge must FUSE reader parentage, not inherit one side.
//
// Before this bead, the merged target's frontmatter was built from path_a's raw
// alone (write.ts ~2131), so path_b's reader provenance was silently dropped and
// the merged belief falsely claimed path_a's single reader as its sole parent.
//
// The fix: the merged `readers` array is the DEDUPED UNION of both sources'
// `readers` (A's entries first, then B's new ones). If that union names exactly
// one distinct reader, the merged doc keeps that reader's scalar reader_* fields;
// if it names MORE THAN ONE, the merged belief must NOT claim single parentage —
// every scalar reader_* field is dropped and only the unioned `readers` set
// survives as the authoritative parentage.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultRead } from "../../src/tools/read.js";
import { vaultMerge, vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "A Note",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "medium",
    created: "2026-05-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["note"],
    ...overrides,
  };
}

// Encoded reader strings, in the shape reader-fingerprint.ts#encodeReader emits.
// The merge logic treats these as opaque strings — it unions the strings, it
// does not re-encode — so literals here are sufficient and keep the test
// independent of the encoder's internals.
const READER_A = "modelA@0.2|prompt=aaaaaaaa|retry=false";
const READER_B = "modelB@0.7|prompt=bbbbbbbb|retry=false";

async function seedWithReader(
  vault: string,
  path: string,
  reader: {
    reader_model: string;
    reader_served_model?: string;
    reader_via_retry?: boolean;
    readers: string[];
  },
): Promise<void> {
  const written = await vaultWrite(vault, {
    path,
    body: `# A Note\n\nBody of ${path}.\n`,
    frontmatter: frontmatter({ ...reader }),
    agent: "agent:seed",
  });
  if (!written.ok) throw written.error;
}

describe("vault_merge — reader parentage fusion (6mf.1)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("unions readers and DROPS scalar reader_* when the two sources have DIFFERENT readers (no false single-parent claim)", async () => {
    await seedWithReader(vault, "pricing/a.md", {
      reader_model: "modelA",
      reader_served_model: "modelA-served",
      reader_via_retry: false,
      readers: [READER_A],
    });
    await seedWithReader(vault, "pricing/b.md", {
      reader_model: "modelB",
      reader_served_model: "modelB-served",
      reader_via_retry: true,
      readers: [READER_B],
    });

    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      target_path: "pricing/merged.md",
      body: "# Merged\n\nCombined content.\n",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const merged = await vaultRead(vault, "pricing/merged.md");
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;

    // readers is the deduped union: A's entry first, then B's.
    expect(merged.value.raw.readers).toEqual([READER_A, READER_B]);

    // The load-bearing assertion: a mixed-parentage merge must NOT carry a
    // single-parent scalar. Every scalar reader_* field is absent — the merged
    // belief cannot claim path_a's (or path_b's) reader as its sole parent.
    expect(merged.value.raw.reader_model).toBeUndefined();
    expect(merged.value.raw.reader_served_model).toBeUndefined();
    expect(merged.value.raw.reader_via_retry).toBeUndefined();
  });

  it("keeps the reader's scalar reader_* fields when both sources share the SAME reader (union has one entry)", async () => {
    await seedWithReader(vault, "pricing/a.md", {
      reader_model: "modelA",
      reader_served_model: "modelA-served",
      reader_via_retry: false,
      readers: [READER_A],
    });
    await seedWithReader(vault, "pricing/b.md", {
      reader_model: "modelA",
      reader_served_model: "modelA-served",
      reader_via_retry: false,
      readers: [READER_A],
    });

    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      target_path: "pricing/merged.md",
      body: "# Merged\n\nCombined content.\n",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const merged = await vaultRead(vault, "pricing/merged.md");
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;

    // Deduped union has exactly one entry.
    expect(merged.value.raw.readers).toEqual([READER_A]);
    // Single reader ⇒ scalars retained (from path_a, which equals path_b here).
    expect(merged.value.raw.reader_model).toBe("modelA");
    expect(merged.value.raw.reader_served_model).toBe("modelA-served");
    expect(merged.value.raw.reader_via_retry).toBe(false);
  });

  it("does not crash and carries no reader fields when NEITHER source has readers (legacy)", async () => {
    const wa = await vaultWrite(vault, {
      path: "pricing/a.md",
      body: "# A\n\nLegacy.\n",
      frontmatter: frontmatter(),
      agent: "agent:seed",
    });
    if (!wa.ok) throw wa.error;
    const wb = await vaultWrite(vault, {
      path: "pricing/b.md",
      body: "# B\n\nLegacy.\n",
      frontmatter: frontmatter(),
      agent: "agent:seed",
    });
    if (!wb.ok) throw wb.error;

    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      target_path: "pricing/merged.md",
      body: "# Merged\n\nCombined.\n",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const merged = await vaultRead(vault, "pricing/merged.md");
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    // No empty placeholder array, no scalar fields.
    expect(merged.value.raw.readers).toBeUndefined();
    expect(merged.value.raw.reader_model).toBeUndefined();
  });

  it("unions and drops scalars when only ONE source has readers but they resolve to two distinct entries", async () => {
    // A carries two distinct readers already (a doc that was itself a prior
    // merge); B is legacy. The union is A's two entries — more than one distinct
    // reader — so scalars must be dropped even though only A contributed.
    await seedWithReader(vault, "pricing/a.md", {
      reader_model: "modelA",
      reader_served_model: "modelA-served",
      reader_via_retry: false,
      readers: [READER_A, READER_B],
    });
    const wb = await vaultWrite(vault, {
      path: "pricing/b.md",
      body: "# B\n\nLegacy.\n",
      frontmatter: frontmatter(),
      agent: "agent:seed",
    });
    if (!wb.ok) throw wb.error;

    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      target_path: "pricing/merged.md",
      body: "# Merged\n\nCombined.\n",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const merged = await vaultRead(vault, "pricing/merged.md");
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.raw.readers).toEqual([READER_A, READER_B]);
    expect(merged.value.raw.reader_model).toBeUndefined();
  });
});
