// 0ksb regression suite: the Stage 1 review's T04 (dependency propagation) and
// T06 (evidence disappearance) scenarios, which observed vault_receipt
// returning empty flags ("current, grounded, uncontested") over evidence that
// was retracted, contested, deleted, or never checkable. Each scenario here
// replays that flow end to end through the real tools and asserts the
// receipt now says so.
//
// The distill flow mocks the LLM transport (same pattern as
// test/distill/cli-propose.test.ts): no network, no key.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { err, ok } from "../../src/frontmatter/types.js";

const fake: { statements: string[] } = { statements: [] };

vi.mock("../../src/eval/transport.js", () => ({
  createTransportClient: () =>
    ok({
      complete: vi.fn(),
      completeWithTools: vi.fn(),
      completeJson: async (_opts: Parameters<LlmClient["completeJson"]>[0]) =>
        fake.statements.length === 0
          ? err({ kind: "llm", message: "unset", retryable: false })
          : ok({
              text: "{}",
              parsed: { claims: fake.statements.map((statement) => ({ statement })) },
              input_tokens: 1,
              output_tokens: 1,
              stop_reason: "end_turn",
            }),
    }),
}));

const { runDistill } = await import("../../src/distill/cli.js");
const { vaultReceipt } = await import("../../src/tools/receipt.js");
const { vaultRead } = await import("../../src/tools/read.js");
const { vaultReindex } = await import("../../src/tools/search.js");
const { vaultTensionLog } = await import("../../src/tools/curation.js");
const { vaultEdgeContest, vaultEdgeObserve } = await import("../../src/tools/edges.js");
const { vaultDeprecate, vaultPromote, vaultSetConfidence, vaultSupersede, vaultWrite } =
  await import("../../src/tools/write.js");
const { commit } = await import("../../src/utils/git.js");

const TODAY = new Date().toISOString().slice(0, 10);
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function receiptFlags(vault: string, path: string, access?: AccessContext) {
  const r = await vaultReceipt(vault, { paths: [path] }, access);
  if (!r.ok) throw r.error;
  return r.value;
}

// ---------------------------------------------------------------------------
// T04: E <- C1 <- C2 via frontmatter `sources`
// ---------------------------------------------------------------------------

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
const SECRET_MIDDLE: Layout = {
  name: "secret-middle",
  E: "open/E.md",
  C1: "secret/C1.md",
  C2: "open/C2.md",
};
const SECRET_ROOT: Layout = {
  name: "secret-root",
  E: "secret/E.md",
  C1: "open/C1.md",
  C2: "open/C2.md",
};
const SUCCESSOR = "open/E2.md";
const REBUTTAL = "open/R.md";

function md(vault: string, path: string, title: string, sources: string[]): void {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  writeFileSync(
    join(vault, path),
    "---\n" +
      `title: ${title}\n` +
      "domain: accumulation\n" +
      `collection: ${path.split("/")[0]}\n` +
      "status: canonical\n" +
      "confidence: high\n" +
      `created: ${TODAY}\n` +
      `updated: ${TODAY}\n` +
      "updated_by: agent:test\n" +
      "provenance: direct\n" +
      "ttl_days: 365\n" +
      `sources: [${sources.map((s) => JSON.stringify(s)).join(", ")}]\n` +
      "tags: []\n" +
      `---\n\n# ${title}\n\nBody of ${title}.\n`,
  );
}

async function seedChain(layout: Layout): Promise<string> {
  const vault = mkdtempSync(join(tmpdir(), `receipt-0ksb-${layout.name}-`));
  roots.push(vault);
  md(vault, layout.E, "Root evidence E SECRETTITLE-E", []);
  md(vault, layout.C1, "Claim C1 SECRETTITLE-C1", [`vault:${layout.E}`]);
  md(vault, layout.C2, "Claim C2 SECRETTITLE-C2", [`vault:${layout.C1}`]);
  md(vault, SUCCESSOR, "Successor E2", []);
  md(vault, REBUTTAL, "Rebuttal R", []);
  const c = await commit(
    vault,
    [layout.E, layout.C1, layout.C2, SUCCESSOR, REBUTTAL],
    "seed chain",
    "agent:test",
  );
  if (!c.ok) throw c.error;
  return vault;
}

describe("T04 regression — a dependent's receipt reflects its retracted grounding", () => {
  it("deprecate E: C1's receipt carries cites-retracted-upstream (was [])", async () => {
    const vault = await seedChain(SECRET_MIDDLE);
    const d = await vaultDeprecate(
      vault,
      { path: SECRET_MIDDLE.E, reason: "retracted", agent: "human:operator" },
      PRIV,
    );
    if (!d.ok) throw d.error;
    const c1 = await receiptFlags(vault, SECRET_MIDDLE.C1, PRIV);
    expect(c1.summary.flags).toEqual(["cites-retracted-upstream"]);
    // One hop by design: C2 cites C1, which is still canonical and uncontested.
    expect((await receiptFlags(vault, SECRET_MIDDLE.C2, PRIV)).summary.flags).toEqual([]);
  });

  it("supersede E: C1's receipt carries cites-superseded-upstream (was [])", async () => {
    const vault = await seedChain(SECRET_MIDDLE);
    const s = await vaultSupersede(
      vault,
      {
        old_path: SECRET_MIDDLE.E,
        new_path: SUCCESSOR,
        reason: "replaced",
        agent: "human:operator",
      },
      PRIV,
    );
    if (!s.ok) throw s.error;
    expect((await receiptFlags(vault, SECRET_MIDDLE.C1, PRIV)).summary.flags).toEqual([
      "cites-superseded-upstream",
    ]);
  });

  it("tension on E: C1's receipt carries cites-contested-upstream (was [])", async () => {
    const vault = await seedChain(SECRET_MIDDLE);
    const t = await vaultTensionLog(
      vault,
      {
        title: "E contradicted by R",
        sourceA: SECRET_MIDDLE.E,
        claimA: "E holds",
        sourceB: REBUTTAL,
        claimB: "E does not hold",
        agent: "agent:test",
        kind: "factual",
      },
      PRIV,
    );
    if (!t.ok) throw t.error;
    expect((await receiptFlags(vault, SECRET_MIDDLE.C1, PRIV)).summary.flags).toEqual([
      "cites-contested-upstream",
    ]);
  });

  it("contested edge C1->E: C2's receipt now carries cites-contested-upstream (was [])", async () => {
    const vault = await seedChain(SECRET_MIDDLE);
    for (const [from, to] of [
      [SECRET_MIDDLE.C1, SECRET_MIDDLE.E],
      [SECRET_MIDDLE.C2, SECRET_MIDDLE.C1],
    ] as const) {
      const o = await vaultEdgeObserve(
        vault,
        { from_path: from, to_path: to, observed_by: "agent:test", blind: true },
        PRIV,
      );
      if (!o.ok) throw o.error;
    }
    const c = await vaultEdgeContest(
      vault,
      {
        from_path: SECRET_MIDDLE.C1,
        to_path: SECRET_MIDDLE.E,
        contested_by: "agent:test",
        reason: "re-derivation failed",
      },
      PRIV,
    );
    if (!c.ok) throw c.error;
    const c1 = await receiptFlags(vault, SECRET_MIDDLE.C1, PRIV);
    expect(c1.summary.flags).toContain("cites-contested");
    expect(c1.summary.flags).toContain("cites-contested-upstream");
    expect((await receiptFlags(vault, SECRET_MIDDLE.C2, PRIV)).summary.flags).toEqual([
      "cites-contested-upstream",
    ]);
  });

  it("restricted reader: a hidden upstream is coarsened, never named or described", async () => {
    // secret-middle: C2 (open) cites C1 (secret). secret-root: C1 (open)
    // cites E (secret), which the privileged role then deprecates.
    const mid = await seedChain(SECRET_MIDDLE);
    const root = await seedChain(SECRET_ROOT);
    const d = await vaultDeprecate(
      root,
      { path: SECRET_ROOT.E, reason: "retracted", agent: "human:operator" },
      PRIV,
    );
    if (!d.ok) throw d.error;
    const midC2 = await receiptFlags(mid, SECRET_MIDDLE.C2, RESTRICTED);
    const rootC1 = await receiptFlags(root, SECRET_ROOT.C1, RESTRICTED);
    for (const [r, hiddenMarker] of [
      [midC2, "SECRETTITLE-C1"],
      [rootC1, "SECRETTITLE-E"],
    ] as const) {
      expect(r.summary.flags).toEqual(["cites-unreadable-source"]);
      expect(r.sources[0]?.upstreamFlags).toEqual(["cites-unreadable-source"]);
      expect(JSON.stringify(r)).not.toContain(hiddenMarker);
    }
    // The privileged role sees the real state.
    expect((await receiptFlags(root, SECRET_ROOT.C1, PRIV)).summary.flags).toEqual([
      "cites-retracted-upstream",
    ]);
  });
});

// ---------------------------------------------------------------------------
// T06: a distilled claim, and a vault-internal compiled source
// ---------------------------------------------------------------------------

const CONFIG_YAML = [
  "version: 1",
  "distill:",
  "  model: claude-sonnet-5-5",
  "roles:",
  "  admin:",
  "    read: ['*']",
  "    write: ['*']",
  "    promote: true",
  "    ratify: true",
  "",
].join("\n");

const ADMIN: AccessContext = {
  user: "human:operator",
  roleName: "admin",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

const SOURCE_V1 = [
  "[1/2/26, 9:00:00 AM] Alice: The vendor contract budget is 4,200 dollars per month.",
  "[1/2/26, 9:01:00 AM] Bob: Agreed, and the renewal date is 2026-03-31.",
].join("\n");
const CLAIM = "The vendor contract budget is 4,200 dollars per month, renewing 2026-03-31.";

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const out: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const e = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return { value: await fn(), out: out.join("") };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

function listMd(dir: string, base = ""): string[] {
  const res: string[] = [];
  for (const ent of readdirSync(join(dir, base), { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) res.push(...listMd(dir, rel));
    else if (rel.endsWith(".md")) res.push(rel);
  }
  return res;
}

describe("T06 regression — a distilled claim never reads as grounded", () => {
  it("canonical/high distilled claim is flagged unverifiable, before and after its source is deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "receipt-0ksb-t06-"));
    roots.push(root);
    const vault = join(root, "vault");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    mkdirSync(join(root, "external"));
    writeFileSync(join(vault, ".daftari", "config.yaml"), CONFIG_YAML);
    const source = join(root, "external", "vendor-memo.txt");
    writeFileSync(source, SOURCE_V1);

    fake.statements = [CLAIM];
    const proposed = await quiet(() =>
      runDistill(["--vault", vault, "--propose", "--source-id", "vendor-memo", source]),
    );
    expect(proposed.value).toBe(0);
    const runId = /run-id:\s+(\S+)/.exec(proposed.out)?.[1] as string;
    expect(runId).toBeTruthy();
    const reviewed = await quiet(() => runDistill(["--vault", vault, "--review", runId, "--yes"]));
    expect(reviewed.value).toBe(0);
    const [doc] = listMd(vault) as [string];
    const ri = await vaultReindex(vault);
    if (!ri.ok) throw ri.error;
    const conf = await vaultSetConfidence(
      vault,
      { path: doc, confidence: "high", reason: "trusted", agent: "human:operator" },
      ADMIN,
    );
    if (!conf.ok) throw conf.error;
    const prom = await vaultPromote(
      vault,
      { path: doc, reason: "trusted", agent: "human:operator" },
      ADMIN,
    );
    if (!prom.ok) throw prom.error;

    const before = await receiptFlags(vault, doc, ADMIN);
    expect(before.sources[0]?.status).toBe("canonical");
    expect(before.summary.flags).toEqual(["cites-unverifiable-source"]);

    unlinkSync(source);
    expect((await receiptFlags(vault, doc, ADMIN)).summary.flags).toEqual([
      "cites-unverifiable-source",
    ]);
  }, 120_000);
});

describe("T06 regression — a vault-internal compiled source", () => {
  async function setupCompiled(): Promise<{ vault: string; src: string; art: string }> {
    const root = mkdtempSync(join(tmpdir(), "receipt-0ksb-t06c-"));
    roots.push(root);
    const vault = join(root, "vault");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, ".daftari", "config.yaml"), CONFIG_YAML);
    const fm = (o: Record<string, unknown>) => ({
      title: "Note",
      domain: "accumulation",
      collection: "notes",
      status: "canonical",
      confidence: "high",
      created: "2026-11-01",
      provenance: "direct",
      sources: [],
      superseded_by: null,
      ttl_days: null,
      ...o,
    });
    const src = "notes/vendor-memo-source.md";
    const art = "notes/vendor-budget-claim.md";
    const w1 = await vaultWrite(
      vault,
      {
        path: src,
        body: "Budget is 4,200 per month.\n",
        frontmatter: fm({ title: "Memo" }),
        agent: "human:operator",
      },
      ADMIN,
    );
    if (!w1.ok) throw w1.error;
    const ri = await vaultReindex(vault);
    if (!ri.ok) throw ri.error;
    const rd = await vaultRead(vault, src, ADMIN, "run-compile-1");
    if (!rd.ok) throw rd.error;
    const w2 = await vaultWrite(
      vault,
      {
        path: art,
        body: "The vendor budget is 4,200 per month.\n",
        frontmatter: fm({ title: "Claim", sources: [`vault:${src}`] }),
        agent: "agent:test",
        run_id: "run-compile-1",
      },
      ADMIN,
    );
    if (!w2.ok) throw w2.error;
    const ri2 = await vaultReindex(vault);
    if (!ri2.ok) throw ri2.error;
    return { vault, src, art };
  }

  it("baseline: a current compiled source leaves the receipt clean", async () => {
    const { vault, art } = await setupCompiled();
    expect((await receiptFlags(vault, art, ADMIN)).summary.flags).toEqual([]);
  }, 60_000);

  it("source deleted: cites-broken-source (was [])", async () => {
    const { vault, src, art } = await setupCompiled();
    unlinkSync(join(vault, src));
    expect((await receiptFlags(vault, art, ADMIN)).summary.flags).toEqual(["cites-broken-source"]);
    await vaultReindex(vault);
    expect((await receiptFlags(vault, art, ADMIN)).summary.flags).toEqual(["cites-broken-source"]);
  }, 60_000);

  it("source rewritten through vault_write: cites-pending-broken-upstream (was [])", async () => {
    const { vault, src, art } = await setupCompiled();
    const cur = await vaultRead(vault, src, ADMIN);
    if (!cur.ok) throw cur.error;
    const w = await vaultWrite(
      vault,
      {
        path: src,
        body: "Budget is 9,900 per month.\n",
        frontmatter: cur.value.frontmatter as unknown as Record<string, unknown>,
        agent: "human:operator",
      },
      ADMIN,
    );
    if (!w.ok) throw w.error;
    await vaultReindex(vault);
    const r = await receiptFlags(vault, art, ADMIN);
    expect(r.summary.flags).toEqual(["cites-pending-broken-upstream"]);
    expect(r.sources[0]?.upstreamFlags).toEqual(["cites-pending-broken-upstream"]);
  }, 60_000);
});
