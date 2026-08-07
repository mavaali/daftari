import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultAssert } from "../../src/tools/positions.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const ALICE = {
  user: "alice",
  roleName: "writer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false },
};
const BOB = { ...ALICE, user: "bob" };
const DOC = "pricing/retry-storms.md";

async function seedDoc(vault: string): Promise<void> {
  const r = await vaultWrite(vault, {
    path: DOC,
    body: "# Retry storms\n\nThe claim.\n",
    frontmatter: {
      title: "Retry storms",
      domain: "accumulation",
      collection: "pricing",
      status: "canonical",
      confidence: "high",
      created: "2026-08-01",
      provenance: "direct",
    },
    agent: "agent:seed",
  });
  if (!r.ok) throw r.error;
}

describe("vault_read contested_positions (U-7)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("contested-unratified doc: CONTESTED flag, LD-11 order, open tension ids, low confidence (mandated)", async () => {
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "b" },
      BOB,
    );
    const read = await vaultRead(vault, DOC, ALICE);
    expect(read.ok).toBe(true);
    if (!read.ok) throw read.error;
    const block = read.value.contested_positions;
    expect(block?.flag).toBe("CONTESTED");
    // high (pos-001) before medium (pos-002).
    expect(block?.positions.map((p) => p.id)).toEqual(["pos-001", "pos-002"]);
    expect(block?.open_tension_ids).toHaveLength(1);
    expect(block?.note).toContain("no consolidated view");
    expect(read.value.frontmatter.confidence).toBe("low"); // R-9 cap visible
  });

  it("legacy doc: no contested_positions key at all (mandated: byte-identical absence)", async () => {
    const read = await vaultRead(vault, DOC, ALICE);
    expect(read.ok).toBe(true);
    if (!read.ok) throw read.error;
    expect("contested_positions" in read.value).toBe(false);
  });

  it("doc whose only dispute was superseded: no key", async () => {
    await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a" },
      ALICE,
    );
    await vaultAssert(vault, { path: DOC, stance: "dispute", confidence: "low", agent: "b" }, BOB);
    await vaultAssert(vault, { path: DOC, stance: "qualify", confidence: "low", agent: "b" }, BOB);
    const read = await vaultRead(vault, DOC, ALICE);
    if (!read.ok) throw read.error;
    expect("contested_positions" in read.value).toBe(false);
  });
});
