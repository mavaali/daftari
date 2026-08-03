// `daftari court --triage` — the unranked mode. renderTriageCard is asserted
// directly (pure); runCourt --triage is checked for exit codes + output
// end-to-end against a temp vault.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCourt } from "../../src/court/index.js";
import { renderTriageCard } from "../../src/court/triage.js";
import { addTension } from "../../src/curation/tension.js";
import type {
  TensionTriageResult,
  TriageSide,
  TriageTension,
} from "../../src/curation/tension-triage.js";

const side = (overrides: Partial<TriageSide> = {}): TriageSide => ({
  path: "a.md",
  claim: "A claim",
  tier: 1,
  confidence: "high",
  read_heat: { count: 3, last_read: "2026-05-30T00:00:00Z", instrumented: true },
  ...overrides,
});

const tension = (overrides: Partial<TriageTension> = {}): TriageTension => ({
  id: "tension-001",
  title: "t",
  kind: "factual",
  age_days: 31,
  a: side({ path: "a.md", claim: "A claim" }),
  b: side({ path: "b.md", claim: "B claim", tier: null, confidence: "low" }),
  primary_blast: 4,
  advisory_blast: 2,
  hidden_downstream: "none",
  ...overrides,
});

describe("renderTriageCard", () => {
  it("prints the empty-state message when there are no tensions", () => {
    const result: TensionTriageResult = { cluster_count: 0, tension_count: 0, clusters: [] };
    expect(renderTriageCard(result)).toBe("No open tensions.\n");
  });

  it("renders a cluster header, tension row, both sides, and blast", () => {
    const result: TensionTriageResult = {
      cluster_count: 1,
      tension_count: 1,
      clusters: [
        { cluster_id: "cluster:ab12cd34", documents: ["a.md", "b.md"], tensions: [tension()] },
      ],
    };
    const out = renderTriageCard(result);
    expect(out).toContain("1 open tension across 1 cluster.");
    expect(out).toContain("cluster:ab12cd34 (2 docs: a.md, b.md)");
    expect(out).toContain(
      "[tension-001] factual · 31d old · blast 4 primary / 2 advisory (hidden: none)",
    );
    expect(out).toContain("A  a.md");
    expect(out).toContain("tier 1 · conf high · read 3 (last 2026-05-30)");
    expect(out).toContain("B  b.md");
    expect(out).toContain("tier — · conf low");
    expect(out).toContain('"A claim"');
    expect(out).toContain('"B claim"');
  });

  it("distinguishes cold from pre-log read-heat, and unknown sides", () => {
    const result: TensionTriageResult = {
      cluster_count: 1,
      tension_count: 1,
      clusters: [
        {
          cluster_id: "cluster:00000000",
          documents: ["a.md", "b.md"],
          tensions: [
            tension({
              a: side({ read_heat: { count: 0, last_read: null, instrumented: true } }),
              b: side({ path: "b.md", tier: null, confidence: null, read_heat: null }),
            }),
          ],
        },
      ],
    };
    const out = renderTriageCard(result);
    expect(out).toContain("read 0 (cold)");
    expect(out).toContain("read unknown");
  });

  it("marks blast unavailable when null", () => {
    const result: TensionTriageResult = {
      cluster_count: 1,
      tension_count: 1,
      clusters: [
        {
          cluster_id: "cluster:00000000",
          documents: ["a.md", "b.md"],
          tensions: [
            tension({ primary_blast: null, advisory_blast: null, hidden_downstream: null }),
          ],
        },
      ],
    };
    expect(renderTriageCard(result)).toContain("blast unavailable");
  });

  it("caps clusters at the limit and notes the remainder", () => {
    const mkCluster = (id: string) => ({
      cluster_id: id,
      documents: ["x.md", "y.md"],
      tensions: [tension({ id: `t-${id}` })],
    });
    const result: TensionTriageResult = {
      cluster_count: 3,
      tension_count: 3,
      clusters: [
        mkCluster("cluster:aaaaaaaa"),
        mkCluster("cluster:bbbbbbbb"),
        mkCluster("cluster:cccccccc"),
      ],
    };
    const out = renderTriageCard(result, 1);
    expect(out).toContain("cluster:aaaaaaaa");
    expect(out).not.toContain("cluster:bbbbbbbb");
    expect(out).toContain("2 more clusters not shown (raise --limit).");
  });
});

describe("runCourt --triage (unranked mode)", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-court-triage-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writeDoc(path: string): Promise<void> {
    const fm = [
      "---",
      `title: "${path}"`,
      "domain: accumulation",
      "collection: triage",
      "status: canonical",
      "confidence: high",
      "created: 2026-05-01",
      "updated: 2026-05-01",
      "updated_by: agent:test",
      "provenance: direct",
      "sources: []",
      "superseded_by: null",
      "ttl_days: null",
      "tags: []",
      "---",
      "",
    ].join("\n");
    const abs = join(vault, path);
    mkdirSync(dirname(abs), { recursive: true });
    await writeFile(abs, `${fm}\n`);
  }

  it("prints the empty state and exits 0 when no tensions exist", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await runCourt(["--triage", "--vault", vault]);
    expect(code).toBe(0);
    expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("No open tensions.");
  });

  it("renders a logged tension unranked and exits 0", async () => {
    await writeDoc("a.md");
    await writeDoc("b.md");
    await addTension(vault, {
      title: "a/b",
      sourceA: "a.md",
      claimA: "X",
      sourceB: "b.md",
      claimB: "Y",
      loggedBy: "agent:test",
      kind: "factual",
    });
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await runCourt(["--triage", "--vault", vault]);
    expect(code).toBe(0);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("1 open tension across 1 cluster.");
    expect(out).toContain("[tension-001] factual");
  });

  it("rejects a non-numeric --limit with exit 2", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runCourt(["--triage", "--vault", vault, "--limit", "lots"])).toBe(2);
  });

  it("rejects a non-numeric --window with exit 2", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runCourt(["--triage", "--vault", vault, "--window", "-5"])).toBe(2);
  });

  it("documents triage mode in --help", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await runCourt(["--help"]);
    expect(code).toBe(0);
    expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("--triage");
  });
});
