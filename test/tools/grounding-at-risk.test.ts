// nlzr: "grounding at risk" across every push surface. Replays the Stage 2
// vertical test (one real decision, four load-bearing assumptions linked via
// `sources: vault:`) on a synthetic vault:
//
//   V1  — A1 refuted by new evidence (tension A1 <-> evidence)
//   V2  — A3 weakened (tension A3 <-> evidence)
//   V4b — decision canonical and fresh, all four assumptions past their TTL
//
// Before nlzr, V4b left the decision clean on every surface and V1/V2 reached
// it only through a vault_receipt pull that never named the source. Each
// scenario now asserts the decision itself is flagged on vault_read,
// vault_search, vault_receipt, the sleep wake list, and the board — naming
// the source and the reason. Plus the healthy baseline (no false positive),
// draft dependents, retraction/supersession, and RBAC (an unreadable source
// never leaks path, title, or state).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { listBoard } from "../../src/board/board.js";
import { addTension } from "../../src/curation/tension.js";
import { clearContestedCache } from "../../src/search/contested.js";
import { runSleepCycle } from "../../src/sleep/cycle.js";
import { renderMarkdown } from "../../src/sleep/report.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultReceipt } from "../../src/tools/receipt.js";
import { searchTools, vaultReindex, vaultSearch } from "../../src/tools/search.js";
import { cleanupVault } from "../helpers/temp-vault.js";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const SIXTY_AGO = iso(new Date(Date.now() - 60 * DAY));

const D = "decisions/hosted-is-acceptable.md";
const A = [
  "intel/assumption-cloud-sessions.md",
  "intel/assumption-local-mcp-needs-local.md",
  "intel/assumption-remote-mcp-cross-surface.md",
  "intel/assumption-public-https-endpoint.md",
];
const EVIDENCE = "intel/new-evidence.md";
const DOWNSTREAM = "learnings/decision-before-test.md";

const ADMIN: AccessContext = {
  user: "human:operator",
  roleName: "admin",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};
const READER: AccessContext = {
  user: "agent:reader",
  roleName: "reader",
  role: { read: ["decisions", "intel", "learnings"], write: [], promote: false, ratify: false },
};

interface DocOpts {
  title?: string;
  status?: string;
  updated?: string;
  created?: string;
  ttl?: number | null;
  sources?: string[];
  validUntil?: string;
  supersededBy?: string;
}

function md(vault: string, path: string, o: DocOpts = {}): void {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  const title = o.title ?? path;
  writeFileSync(
    join(vault, path),
    "---\n" +
      `title: ${JSON.stringify(title)}\n` +
      "domain: accumulation\n" +
      `collection: ${path.split("/")[0]}\n` +
      `status: ${o.status ?? "canonical"}\n` +
      "confidence: high\n" +
      `created: ${o.created ?? o.updated ?? TODAY}\n` +
      `updated: ${o.updated ?? TODAY}\n` +
      "updated_by: agent:test\n" +
      "provenance: direct\n" +
      `ttl_days: ${o.ttl === undefined ? 30 : o.ttl === null ? "null" : o.ttl}\n` +
      (o.validUntil ? `valid_until: ${o.validUntil}\n` : "") +
      (o.supersededBy ? `superseded_by: ${o.supersededBy}\n` : "") +
      `sources: [${(o.sources ?? []).map((s) => JSON.stringify(s)).join(", ")}]\n` +
      "tags: []\n" +
      `---\n\n# ${title}\n\nBody of ${title}. Should the vault be hosted? Cowork cloud sessions and local MCP.\n`,
  );
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) cleanupVault(r);
});

// The Stage 2 shape: decision cites A1–A4 (plus an external URL), a
// downstream learning cites the decision.
async function seed(opts: {
  decisionStatus?: string;
  assumptionsUpdated?: string;
  extra?: (vault: string) => void;
}): Promise<string> {
  const vault = mkdtempSync(join(tmpdir(), "daftari-nlzr-"));
  roots.push(vault);
  for (const a of A) md(vault, a, { updated: opts.assumptionsUpdated ?? TODAY, ttl: 30 });
  md(vault, D, {
    title: "Daftari hosted is acceptable",
    status: opts.decisionStatus ?? "canonical",
    ttl: null,
    sources: ["https://example.com/support", ...A.map((a) => `vault:${a}`)],
  });
  md(vault, DOWNSTREAM, { ttl: null, sources: [`vault:${D}`] });
  md(vault, EVIDENCE, { ttl: 30 });
  opts.extra?.(vault);
  const r = await vaultReindex(vault);
  if (!r.ok) throw r.error;
  clearContestedCache();
  return vault;
}

async function contest(vault: string, source: string, title: string): Promise<string> {
  const t = await addTension(vault, {
    title,
    sourceA: source,
    claimA: "the assumption holds",
    sourceB: EVIDENCE,
    claimB: "new evidence says it does not",
    loggedBy: "agent:test",
    kind: "factual",
  });
  if (!t.ok) throw t.error;
  clearContestedCache();
  if (!t.value.id) throw new Error("expected a tension id");
  return t.value.id;
}

async function readGrounding(vault: string, path: string, access?: AccessContext) {
  const r = await vaultRead(vault, path, access);
  if (!r.ok) throw r.error;
  return r.value.grounding_at_risk;
}

async function searchHit(vault: string, path: string, access?: AccessContext) {
  const r = await vaultSearch(
    vault,
    { query: "Daftari hosted acceptable decision", limit: 20 },
    access,
  );
  if (!r.ok) throw r.error;
  const hit = r.value.hits.find((h) => h.path === path);
  if (!hit) throw new Error(`${path} not in search hits`);
  return hit;
}

async function receipt(vault: string, path: string, access?: AccessContext) {
  const r = await vaultReceipt(vault, { paths: [path] }, access);
  if (!r.ok) throw r.error;
  return r.value;
}

async function wakeFor(vault: string, path: string) {
  const r = await runSleepCycle(vault, new Date());
  if (!r.ok) throw r.error;
  return { task: r.value.wake.find((w) => w.path === path), cycle: r.value };
}

async function boardFor(vault: string, path: string, access: AccessContext) {
  const b = await listBoard(vault, access, { document: path });
  return b.all.filter((f) => f.check === "grounding-at-risk");
}

describe("healthy baseline — no false positive on any surface", () => {
  it("fresh, uncontested, canonical sources leave the decision clean", async () => {
    const vault = await seed({});
    expect(await readGrounding(vault, D)).toBeUndefined();
    expect((await searchHit(vault, D)).groundingAtRisk).toBeUndefined();
    const rec = await receipt(vault, D);
    expect(rec.sources[0]?.groundingAtRisk).toBeNull();
    expect(rec.summary.flags).not.toContain("cites-expired-upstream");
    expect(rec.summary.flags).not.toContain("cites-contested-upstream");
    expect((await wakeFor(vault, D)).task).toBeUndefined();
    expect(await boardFor(vault, D, ADMIN)).toEqual([]);
  });
});

describe("Stage 2 V4b — canonical decision, four expired assumptions", () => {
  it("is flagged on read, search, receipt, wake list and board, naming every source", async () => {
    const vault = await seed({ assumptionsUpdated: SIXTY_AGO });

    const g = await readGrounding(vault, D);
    expect(g?.reasons.map((r) => r.source)).toEqual([...A].sort());
    expect(new Set(g?.reasons.map((r) => r.kind))).toEqual(new Set(["ttl-expired"]));
    for (const a of A) expect(g?.banner).toContain(`${a} — `);

    const hit = await searchHit(vault, D);
    expect(hit.groundingAtRisk?.reasons).toHaveLength(4);

    const rec = await receipt(vault, D);
    expect(rec.summary.flags).toContain("cites-expired-upstream");
    expect(rec.sources[0]?.upstreamFlags).toContain("cites-expired-upstream");
    expect(rec.sources[0]?.groundingAtRisk?.reasons.map((r) => r.source)).toEqual([...A].sort());

    const { task } = await wakeFor(vault, D);
    expect(task?.reason).toContain("grounding at risk");
    expect(task?.reason).toContain(A[0]);
    expect(task?.groundingAtRisk?.reasons).toHaveLength(4);

    const cards = await boardFor(vault, D, ADMIN);
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0]?.evidence)).toContain(A[0]);
  });

  it("the compact search summary carries the grounding line the model reads", async () => {
    const vault = await seed({ assumptionsUpdated: SIXTY_AGO });
    const r = await vaultSearch(vault, { query: "Daftari hosted acceptable decision", limit: 20 });
    if (!r.ok) throw r.error;
    const tool = searchTools.find((t) => t.name === "vault_search");
    const text = tool?.summarize?.(r.value, vault) ?? "";
    const line = text.split("\n").find((l) => l.includes(D)) ?? "";
    expect(line).toContain(`grounding at risk: ${[...A].sort()[0]} — past its 30d TTL`);
    expect(line).toContain("+3 more");
  });

  it("the decision's own decay stays clean — the risk is upstream, not its age", async () => {
    const vault = await seed({ assumptionsUpdated: SIXTY_AGO });
    const r = await vaultRead(vault, D);
    if (!r.ok) throw r.error;
    expect(r.value.decay).toBeNull();
  });

  it("a DRAFT decision is woken too (decisions are often drafts)", async () => {
    const vault = await seed({ assumptionsUpdated: SIXTY_AGO, decisionStatus: "draft" });
    const { task, cycle } = await wakeFor(vault, D);
    expect(task?.reason).toContain("grounding at risk");
    expect(task?.reason).toContain("draft");
    expect(await readGrounding(vault, D)).toBeDefined();
    const md = renderMarkdown({
      generatedAt: new Date().toISOString(),
      vault,
      cycle,
      wakeQueuePath: null,
      wakeLimit: 50,
    });
    expect(md).toContain(D);
  });

  it("a retired dependent is not woken for its grounding", async () => {
    const vault = await seed({ assumptionsUpdated: SIXTY_AGO, decisionStatus: "deprecated" });
    expect((await wakeFor(vault, D)).task).toBeUndefined();
  });
});

describe("Stage 2 V1/V2 — contested assumption", () => {
  it("V1: A1 refuted — every surface names A1 and the tension id", async () => {
    const vault = await seed({});
    const id = await contest(vault, A[0] as string, "A1 refuted");

    const g = await readGrounding(vault, D);
    expect(g?.reasons).toEqual([
      expect.objectContaining({ source: A[0], kind: "contested", tensionIds: [id] }),
    ]);
    expect((await searchHit(vault, D)).groundingAtRisk?.reasons[0]?.source).toBe(A[0]);

    const rec = await receipt(vault, D);
    expect(rec.summary.flags).toContain("cites-contested-upstream");
    expect(rec.sources[0]?.groundingAtRisk?.reasons).toEqual([
      expect.objectContaining({ source: A[0], kind: "contested", tensionIds: [id] }),
    ]);

    const { task } = await wakeFor(vault, D);
    expect(task?.reason).toContain(A[0]);
    expect(task?.reason).toContain(id);
    expect(await boardFor(vault, D, ADMIN)).toHaveLength(1);
  });

  it("a DRAFT whose only risk is a contested source is not woken, but is still flagged elsewhere", async () => {
    const vault = await seed({ decisionStatus: "draft" });
    await contest(vault, A[0] as string, "A1 refuted");
    expect((await wakeFor(vault, D)).task).toBeUndefined();
    expect((await readGrounding(vault, D))?.reasons[0]?.kind).toBe("contested");
    expect((await searchHit(vault, D)).groundingAtRisk?.reasons[0]?.source).toBe(A[0]);
    expect(await boardFor(vault, D, ADMIN)).toHaveLength(1);
  });

  it("a DRAFT with a contested AND an expired source wakes, naming only the expiry", async () => {
    const vault = await seed({ assumptionsUpdated: SIXTY_AGO, decisionStatus: "draft" });
    await contest(vault, A[0] as string, "A1 refuted");
    const { task } = await wakeFor(vault, D);
    expect(task?.reason).toContain("grounding at risk");
    expect(task?.groundingAtRisk?.reasons.some((r) => r.kind === "contested")).toBe(false);
  });

  it("V2: A3 weakened — the decision names A3, not A1 (V1 and V2 now differ)", async () => {
    const vault = await seed({});
    await contest(vault, A[2] as string, "A3 weakened");
    const g = await readGrounding(vault, D);
    expect(g?.reasons.map((r) => r.source)).toEqual([A[2]]);
    const rec = await receipt(vault, D);
    expect(rec.sources[0]?.groundingAtRisk?.reasons.map((r) => r.source)).toEqual([A[2]]);
  });

  it("one hop only: the downstream learning is not flagged for the decision's assumptions", async () => {
    const vault = await seed({ assumptionsUpdated: SIXTY_AGO });
    expect(await readGrounding(vault, DOWNSTREAM)).toBeUndefined();
  });
});

describe("retracted and superseded sources", () => {
  it("deprecated and superseded sources are named with their kind", async () => {
    const vault = await seed({
      extra: (v) => {
        md(v, A[0] as string, { status: "deprecated" });
        md(v, A[1] as string, { status: "superseded", supersededBy: "intel/a2-v2.md" });
        md(v, "intel/a2-v2.md", {});
      },
    });
    const g = await readGrounding(vault, D);
    expect(g?.reasons.map((r) => [r.source, r.kind])).toEqual([
      [A[0], "retracted"],
      [A[1], "superseded"],
    ]);
    const rec = await receipt(vault, D);
    expect(rec.summary.flags).toEqual(
      expect.arrayContaining(["cites-retracted-upstream", "cites-superseded-upstream"]),
    );
  });

  it("validity-ended source flags the dependent with cites-expired-upstream", async () => {
    const vault = await seed({
      extra: (v) => md(v, A[3] as string, { validUntil: SIXTY_AGO }),
    });
    const g = await readGrounding(vault, D);
    expect(g?.reasons).toEqual([
      expect.objectContaining({ source: A[3], kind: "validity-ended", expiredOn: SIXTY_AGO }),
    ]);
    expect((await receipt(vault, D)).summary.flags).toContain("cites-expired-upstream");
  });
});

describe("RBAC — an unreadable source never leaks", () => {
  const SECRET = "secret/hidden-assumption.md";

  it("reader sees no reason, path, title, or state for a hidden at-risk source", async () => {
    const vault = await seed({
      extra: (v) => {
        md(v, SECRET, { title: "SECRETTITLE", status: "deprecated", updated: SIXTY_AGO });
        md(v, D, {
          title: "Daftari hosted is acceptable",
          ttl: null,
          sources: [...A.map((a) => `vault:${a}`), `vault:${SECRET}`],
        });
      },
    });
    await contest(vault, SECRET, "secret contested");

    // Admin sees it.
    expect((await readGrounding(vault, D, ADMIN))?.reasons.map((r) => [r.source, r.kind])).toEqual([
      [SECRET, "contested"],
      [SECRET, "retracted"],
    ]);

    // Reader: absent everywhere, and nothing about the source in any payload.
    const read = await vaultRead(vault, D, READER);
    if (!read.ok) throw read.error;
    expect(read.value.grounding_at_risk).toBeUndefined();

    const hit = await searchHit(vault, D, READER);
    expect(hit.groundingAtRisk).toBeUndefined();

    const rec = await receipt(vault, D, READER);
    expect(rec.sources[0]?.groundingAtRisk).toBeNull();
    expect(rec.summary.flags).toContain("cites-unreadable-source");
    for (const f of [
      "cites-retracted-upstream",
      "cites-expired-upstream",
      "cites-contested-upstream",
    ]) {
      expect(rec.summary.flags).not.toContain(f);
    }

    const cards = await boardFor(vault, D, READER);
    for (const payload of [
      read.value.grounding_at_risk,
      hit,
      rec.sources[0]?.groundingAtRisk,
      cards,
    ]) {
      const s = JSON.stringify(payload ?? null);
      expect(s).not.toContain("hidden-assumption");
      expect(s).not.toContain("SECRETTITLE");
    }
    expect(cards).toEqual([]);
  });

  it("a readable source contested only by a hidden doc is not contested for the reader", async () => {
    const vault = await seed({
      extra: (v) => md(v, "secret/rebuttal.md", { title: "SECRETREBUTTAL" }),
    });
    const t = await addTension(vault, {
      title: "hidden rebuttal",
      sourceA: A[0] as string,
      claimA: "holds",
      sourceB: "secret/rebuttal.md",
      claimB: "does not",
      loggedBy: "agent:test",
      kind: "factual",
    });
    if (!t.ok) throw t.error;
    clearContestedCache();
    expect(await readGrounding(vault, D, ADMIN)).toBeDefined();
    expect(await readGrounding(vault, D, READER)).toBeUndefined();
    expect((await searchHit(vault, D, READER)).groundingAtRisk).toBeUndefined();
    expect((await receipt(vault, D, READER)).sources[0]?.groundingAtRisk).toBeNull();
  });
});
