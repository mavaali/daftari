// #84q6: restricted blast must not leak dependency structure through a
// distance gap. With the chain E <- C1 <- C2 (frontmatter `sources`), a reader
// who cannot see C1 used to get C2 at distance 2 with nothing at distance 1 —
// together with C2's readable `sources` naming C1, that disclosed that an
// unreadable doc cites E. Distances for a restricted reader are now computed
// over the readable subgraph; a doc reachable only through hidden docs folds
// into the coarsened `hidden_downstream` bucket with no distance.
//
// Layouts mirror the Stage 1 T04 review (secret-middle / secret-leaf /
// secret-root) for a privileged and a restricted reader.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { runLint } from "../../src/curation/lint.js";
import { computeBlastForReader } from "../../src/curation/tension-blast.js";
import { vaultLint, vaultTensionBlast } from "../../src/tools/curation.js";
import { vaultErasePlan } from "../../src/tools/erase.js";
import { vaultDeprecate } from "../../src/tools/write.js";
import { commit } from "../../src/utils/git.js";
import { cleanupVault } from "../helpers/temp-vault.js";

const TODAY = new Date().toISOString().slice(0, 10);

const PRIV: AccessContext = {
  user: "human:operator",
  roleName: "admin",
  role: { read: ["open", "secret"], write: ["open", "secret"], promote: true, ratify: true },
};
const RESTRICTED: AccessContext = {
  user: "agent:reader",
  roleName: "reader",
  role: { read: ["open"], write: ["open"], promote: false, ratify: false },
};

type Layout = { name: string; E: string; C1: string; C2: string };
const MIDDLE: Layout = {
  name: "secret-middle",
  E: "open/E.md",
  C1: "secret/C1.md",
  C2: "open/C2.md",
};
const LEAF: Layout = { name: "secret-leaf", E: "open/E.md", C1: "open/C1.md", C2: "secret/C2.md" };
const ROOT: Layout = { name: "secret-root", E: "secret/E.md", C1: "open/C1.md", C2: "open/C2.md" };

function md(vault: string, path: string, sources: string[]): void {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  const src = sources.map((s) => JSON.stringify(s)).join(", ");
  writeFileSync(
    join(vault, path),
    "---\n" +
      `title: Doc ${path}\n` +
      "domain: accumulation\n" +
      `collection: ${path.split("/")[0]}\n` +
      "status: canonical\n" +
      "confidence: high\n" +
      `created: ${TODAY}\n` +
      `updated: ${TODAY}\n` +
      "updated_by: agent:test\n" +
      "provenance: direct\n" +
      "ttl_days: 365\n" +
      `sources: [${src}]\n` +
      "tags: []\n" +
      `---\n\n# Doc\n\nBody.\n`,
  );
}

const vaults: string[] = [];
afterEach(() => {
  while (vaults.length > 0) cleanupVault(vaults.pop() as string);
});

async function seed(layout: Layout, extra: [string, string[]][] = []): Promise<string> {
  const vault = mkdtempSync(join(tmpdir(), `blast-84q6-${layout.name}-`));
  vaults.push(vault);
  const docs: [string, string[]][] = [
    [layout.E, []],
    [layout.C1, [`vault:${layout.E}`]],
    [layout.C2, [`vault:${layout.C1}`]],
    ...extra,
  ];
  for (const [p, s] of docs) md(vault, p, s);
  const c = await commit(
    vault,
    docs.map(([p]) => p),
    "seed",
    "agent:test",
  );
  if (!c.ok) throw c.error;
  return vault;
}

function shape(downstream: { path: string; distance: number }[]): string[] {
  return downstream.map((d) => `${d.path}@${d.distance}`);
}

// No visible entry may sit at distance d > 1 unless something visible sits at
// d - 1 — the gap is exactly what disclosed the hidden hop.
function expectNoDistanceGap(downstream: { distance: number }[]): void {
  const ds = new Set(downstream.map((d) => d.distance));
  for (const d of ds) if (d > 1) expect(ds.has(d - 1)).toBe(true);
}

describe("computeBlastForReader (pure)", () => {
  const reverseSource = new Map([
    ["E", new Set(["C1"])],
    ["C1", new Set(["C2"])],
  ]);
  const reverseLink = new Map<string, Set<string>>();

  it("no predicate: identical to the unfiltered BFS, hidden 'none'", () => {
    const r = computeBlastForReader({ seeds: ["E"], reverseSource, reverseLink });
    expect(shape(r.downstream)).toEqual(["C1@1", "C2@2"]);
    expect(r.max_depth).toBe(2);
    expect(r.hidden_downstream).toBe("none");
  });

  it("does not walk through a hidden node: its only-reachable descendant is hidden too", () => {
    const r = computeBlastForReader(
      { seeds: ["E"], reverseSource, reverseLink },
      (p) => p !== "C1",
    );
    expect(r.downstream).toEqual([]);
    expect(r.primary_blast).toBe(0);
    expect(r.max_depth).toBe(0);
    expect(r.hidden_downstream).toBe("some");
  });

  it("a readable alternative path yields its readable-subgraph distance, not the shortcut", () => {
    // E <- H (hidden) <- X, and E <- A <- B <- X: X is 2 hops through H,
    // 3 hops through readable docs.
    const rs = new Map([
      ["E", new Set(["H", "A"])],
      ["H", new Set(["X"])],
      ["A", new Set(["B"])],
      ["B", new Set(["X"])],
    ]);
    const full = computeBlastForReader({ seeds: ["E"], reverseSource: rs, reverseLink });
    expect(shape(full.downstream)).toContain("X@2");
    const r = computeBlastForReader(
      { seeds: ["E"], reverseSource: rs, reverseLink },
      (p) => p !== "H",
    );
    expect(shape(r.downstream)).toEqual(["A@1", "B@2", "X@3"]);
    expect(r.hidden_downstream).toBe("some");
  });
});

describe("vault_tension_blast — T04 layouts", () => {
  it("secret-middle: privileged sees the full chain; restricted sees no gap and no C2", async () => {
    const vault = await seed(MIDDLE);
    const priv = await vaultTensionBlast(vault, { document: MIDDLE.E }, PRIV);
    expect(priv.ok).toBe(true);
    if (!priv.ok) return;
    expect(shape(priv.value.downstream)).toEqual(["secret/C1.md@1", "open/C2.md@2"]);
    expect(priv.value.max_depth).toBe(2);
    expect(priv.value.hidden_downstream).toBe("none");

    const res = await vaultTensionBlast(vault, { document: MIDDLE.E }, RESTRICTED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // C2 is readable but reachable only through the hidden C1: naming it (at
    // any distance) would confirm a hidden doc cites E.
    expect(res.value.downstream).toEqual([]);
    expect(res.value.primary_blast).toBe(0);
    expect(res.value.advisory_blast).toBe(0);
    expect(res.value.max_depth).toBe(0);
    expect(res.value.hidden_downstream).toBe("some");
    expect(JSON.stringify(res.value)).not.toContain("secret/");
  });

  it("secret-leaf: restricted sees C1@1 only, hidden 'some'", async () => {
    const vault = await seed(LEAF);
    const res = await vaultTensionBlast(vault, { document: LEAF.E }, RESTRICTED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(shape(res.value.downstream)).toEqual(["open/C1.md@1"]);
    expect(res.value.max_depth).toBe(1);
    expect(res.value.hidden_downstream).toBe("some");
    expectNoDistanceGap(res.value.downstream);
  });

  it("secret-root: restricted blasting from C1 sees C2@1; from E is denied", async () => {
    const vault = await seed(ROOT);
    const fromC1 = await vaultTensionBlast(vault, { document: ROOT.C1 }, RESTRICTED);
    expect(fromC1.ok).toBe(true);
    if (!fromC1.ok) return;
    expect(shape(fromC1.value.downstream)).toEqual(["open/C2.md@1"]);
    expect(fromC1.value.hidden_downstream).toBe("none");
    const fromE = await vaultTensionBlast(vault, { document: ROOT.E }, RESTRICTED);
    expect(fromE.ok).toBe(false);
  });

  it("secret-middle with a readable bypass: C2 shown at its readable distance, no gap", async () => {
    // E <- C1 (secret) <- C2, and E <- B (open) <- C2: C2 is distance 2 either
    // way; B fills distance 1 so there is no gap.
    const vault = await seed(MIDDLE, [["open/B.md", [`vault:${MIDDLE.E}`]]]);
    md(vault, MIDDLE.C2, [`vault:${MIDDLE.C1}`, "vault:open/B.md"]);
    const res = await vaultTensionBlast(vault, { document: MIDDLE.E }, RESTRICTED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(shape(res.value.downstream)).toEqual(["open/B.md@1", "open/C2.md@2"]);
    expect(res.value.hidden_downstream).toBe("some");
    expectNoDistanceGap(res.value.downstream);
  });
});

describe("dependents advisory (vault_deprecate) — T04 secret-middle", () => {
  it("privileged unchanged; restricted deprecator sees no C2 and no gap", async () => {
    const privVault = await seed(MIDDLE);
    const priv = await vaultDeprecate(
      privVault,
      { path: MIDDLE.E, reason: "retracted", agent: "human:operator" },
      PRIV,
    );
    expect(priv.ok).toBe(true);
    if (!priv.ok) return;
    expect(shape(priv.value.dependents?.downstream ?? [])).toEqual([
      "secret/C1.md@1",
      "open/C2.md@2",
    ]);
    expect(priv.value.dependents?.hidden_downstream).toBe("none");

    const vault = await seed(MIDDLE);
    const res = await vaultDeprecate(
      vault,
      { path: MIDDLE.E, reason: "retracted", agent: "agent:reader" },
      RESTRICTED,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.dependents?.downstream).toEqual([]);
    expect(res.value.dependents?.primary_blast).toBe(0);
    expect(res.value.dependents?.hidden_downstream).toBe("some");
  });
});

describe("vault_erase plan — restricted eraser", () => {
  it("does not report a doc reachable only through a hidden doc", async () => {
    const vault = await seed(MIDDLE);
    const eraser: AccessContext = {
      ...RESTRICTED,
      role: { ...RESTRICTED.role, erase: true } as AccessContext["role"],
    };
    const plan = await vaultErasePlan(vault, { path: MIDDLE.E }, eraser);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.downstream).toEqual([]);
    expect(plan.value.hidden_downstream).toBe("some");
  });
});

describe("lint — hidden vs missing source wording", () => {
  it("restricted: a hidden source and a missing source read identically (coarsened)", async () => {
    const vault = await seed(MIDDLE, [["open/G.md", ["vault:open/gone.md"]]]);
    const res = await vaultLint(vault, {}, RESTRICTED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const broken = res.value.checks.brokenSourceRefs;
    const c2 = broken.find((f) => f.path === MIDDLE.C2)?.detail;
    const g = broken.find((f) => f.path === "open/G.md")?.detail;
    expect(c2).toBe("unresolvable or unreadable reference(s): vault:secret/C1.md");
    expect(g).toBe("unresolvable or unreadable reference(s): vault:open/gone.md");
  });

  // "Sees everything" is the role's wildcard read grant — the same rule the
  // receipt uses for cites-broken-source vs cites-unreadable-source — never a
  // property of the vault's current contents (that would be an oracle).
  it("wildcard-read and no-RBAC wording unchanged", async () => {
    const vault = await seed(MIDDLE, [["open/G.md", ["vault:open/gone.md"]]]);
    const wildcard: AccessContext = {
      user: "human:operator",
      roleName: "admin",
      role: { read: ["*"], write: ["*"], promote: true, ratify: true },
    };
    for (const access of [wildcard, undefined]) {
      const res = await vaultLint(vault, {}, access);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.checks.brokenSourceRefs).toEqual([
        { path: "open/G.md", detail: "unresolvable reference(s): vault:open/gone.md" },
      ]);
    }
    const direct = await runLint(vault);
    expect(direct.ok).toBe(true);
  });
});
