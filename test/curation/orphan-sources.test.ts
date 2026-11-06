import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runLint } from "../../src/curation/lint.js";
import { backtickedVaultPaths, outgoingEdges } from "../../src/curation/source-refs.js";
import { structuralDecay } from "../../src/curation/structural.js";
import { buildPathIndexes } from "../../src/curation/vault-docs.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { openIndexDb } from "../../src/storage/index-db.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultReindex, vaultSearch } from "../../src/tools/search.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:test";

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Doc",
    domain: "accumulation",
    collection: "decisions",
    status: "draft",
    confidence: "medium",
    created: "2026-07-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    ...overrides,
  };
}

describe("outgoingEdges (#641)", () => {
  const indexes = buildPathIndexes(
    ["decisions/a.md", "decisions/b.md", "decisions/c.md"].map((path) => ({ path })),
  );

  it("emits body links and resolved sources as separate kinds", () => {
    const edges = outgoingEdges(
      "See [[b]].",
      ["vault:decisions/b.md", "decisions/c.md"],
      "decisions/a.md",
      indexes,
    );
    expect(edges).toEqual([
      { target: "decisions/b.md", kind: "link" },
      { target: "decisions/b.md", kind: "source" },
      { target: "decisions/c.md", kind: "source" },
    ]);
  });

  it("drops self-citations and sources that are not vault dependencies", () => {
    const edges = outgoingEdges(
      "",
      [
        "vault:decisions/a.md",
        "vault:decisions/gone.md",
        "https://example.com/b.md",
        "repo:decisions/b.md",
        "distill:session-1",
        "mount:decisions/b.md",
        "an opaque legacy citation",
      ],
      "decisions/a.md",
      indexes,
    );
    expect(edges).toEqual([]);
  });
});

describe("backtickedVaultPaths (#641)", () => {
  const { byPath } = buildPathIndexes(
    ["decisions/a.md", "decisions/b.md"].map((path) => ({ path })),
  );

  it("finds inline code spans that exactly name a vault path", () => {
    const found = backtickedVaultPaths(
      "See `decisions/a.md` and `decisions/a.md` again, not `decisions/gone.md` or `a.md`.",
      byPath,
    );
    expect(found).toEqual(["decisions/a.md"]);
  });

  it("ignores fenced code blocks", () => {
    expect(
      backtickedVaultPaths(
        "```sh\ncat `decisions/a.md`\n```\n\n~~~\n`decisions/b.md`\n~~~\n",
        byPath,
      ),
    ).toEqual([]);
  });
});

describe("lint orphan check counts sources (#641)", () => {
  let dir: string;
  const doc = (path: string, fm: Record<string, unknown>, body: string) => {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    const lines = Object.entries(frontmatter({ title: path, ...fm })).map(
      ([k, v]) => `${k}: ${JSON.stringify(v)}`,
    );
    writeFileSync(abs, `---\n${lines.join("\n")}\n---\n\n${body}\n`, "utf-8");
  };
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const orphans = async (opts = {}) => {
    const report = await runLint(dir, opts);
    if (!report.ok) throw report.error;
    return report.value.checks;
  };

  it("does not flag a document cited only through another document's sources", async () => {
    dir = mkdtempSync(join(tmpdir(), "daftari-orphan-sources-"));
    doc("decisions/cited-explicit.md", {}, "Body.");
    doc("decisions/cited-legacy.md", {}, "Body.");
    doc("decisions/lonely.md", {}, "Body.");
    doc(
      "decisions/citer.md",
      { sources: ["vault:decisions/cited-explicit.md", "decisions/cited-legacy.md"] },
      "Body.",
    );

    const checks = await orphans();
    expect(checks.orphanFiles.map((f) => f.path).sort()).toEqual([
      "decisions/citer.md",
      "decisions/lonely.md",
    ]);
  });

  it("does not count a self-citation", async () => {
    dir = mkdtempSync(join(tmpdir(), "daftari-orphan-sources-"));
    doc("decisions/self.md", { sources: ["vault:decisions/self.md"] }, "Body.");
    expect((await orphans()).orphanFiles.map((f) => f.path)).toEqual(["decisions/self.md"]);
  });

  it("does not let a hidden citer un-flag an orphan", async () => {
    dir = mkdtempSync(join(tmpdir(), "daftari-orphan-sources-"));
    doc("decisions/island.md", {}, "Body.");
    doc("moonshot/hidden.md", { sources: ["vault:decisions/island.md"] }, "Body.");

    const checks = await orphans({ pathVisible: (p: string) => p.startsWith("decisions/") });
    expect(checks.orphanFiles.map((f) => f.path)).toEqual(["decisions/island.md"]);
    expect(checks.orphanFiles[0]?.detail).not.toContain("moonshot");
  });

  it("keeps retiredStillLinked to body links: tier0 owns sources citations", async () => {
    dir = mkdtempSync(join(tmpdir(), "daftari-orphan-sources-"));
    doc("decisions/retired.md", { status: "deprecated" }, "Body.");
    doc(
      "decisions/citer.md",
      { status: "canonical", confidence: "high", sources: ["vault:decisions/retired.md"] },
      "Body.",
    );

    const checks = await orphans();
    expect(checks.retiredStillLinked).toEqual([]);
    expect(checks.lifecycleConflicts.map((f) => f.path)).toContain("decisions/citer.md");
    expect(checks.orphanFiles.map((f) => f.path)).not.toContain("decisions/retired.md");
  });

  it("still flags a document only named in backticks, and says so without naming hidden docs", async () => {
    dir = mkdtempSync(join(tmpdir(), "daftari-orphan-sources-"));
    doc("decisions/named.md", {}, "Body.");
    doc("decisions/mentioner.md", {}, "Compare with `decisions/named.md`.");
    doc("moonshot/hidden.md", {}, "Also `decisions/named.md`.");

    const checks = await orphans({ pathVisible: (p: string) => p.startsWith("decisions/") });
    const finding = checks.orphanFiles.find((f) => f.path === "decisions/named.md");
    expect(finding?.detail).toContain("decisions/mentioner.md");
    expect(finding?.detail).toContain("not an edge");
    expect(finding?.detail).not.toContain("moonshot");
  });

  it("caps the backticked mentions it names", async () => {
    dir = mkdtempSync(join(tmpdir(), "daftari-orphan-sources-"));
    doc("decisions/named.md", {}, "Body.");
    for (const n of [1, 2, 3, 4, 5]) doc(`decisions/m${n}.md`, {}, "See `decisions/named.md`.");

    const finding = (await orphans()).orphanFiles.find((f) => f.path === "decisions/named.md");
    expect(finding?.detail).toContain("decisions/m3.md");
    expect(finding?.detail).not.toContain("decisions/m4.md");
    expect(finding?.detail).toContain("+2 more");
  });
});

describe("structural decay counts sources (#641)", () => {
  let vault: string;
  const write = async (path: string, body: string, fm: Record<string, unknown>) => {
    const w = await vaultWrite(vault, {
      path,
      body,
      frontmatter: frontmatter({ title: path, ...fm }),
      agent: AGENT,
    });
    if (!w.ok) throw w.error;
  };

  beforeAll(async () => {
    vault = makeTempVault();
    await write("decisions/cited.md", "# Cited\n\nThe quillwort decision.\n", {});
    await write("decisions/lonely.md", "# Lonely\n\nThe quillwort remainder.\n", {});
    await write("decisions/retired.md", "# Retired\n\nOld thinking.\n", { status: "deprecated" });
    await write("competitive-intel/hidden-citer.md", "# Hidden\n\nCites things.\n", {
      collection: "competitive-intel",
      sources: ["vault:decisions/shadowed.md"],
    });
    await write("decisions/shadowed.md", "# Shadowed\n\nOnly a hidden doc cites this.\n", {});
    await write("decisions/citer.md", "# Citer\n\nNo body links at all.\n", {
      status: "canonical",
      confidence: "high",
      sources: ["vault:decisions/cited.md", "vault:decisions/retired.md"],
    });
    const r = await vaultReindex(vault);
    if (!r.ok) throw r.error;
  }, 60_000);
  afterAll(() => cleanupVault(vault));

  it("clears orphan on read and on search hits for a sources-only citation", async () => {
    const read = await vaultRead(vault, "decisions/cited.md");
    if (!read.ok) throw read.error;
    expect(read.value.structural).toBeNull();

    const search = await vaultSearch(vault, { query: "quillwort" });
    if (!search.ok) throw search.error;
    const cited = search.value.hits.find((h) => h.path === "decisions/cited.md");
    const lonely = search.value.hits.find((h) => h.path === "decisions/lonely.md");
    expect(cited).toBeDefined();
    expect(cited?.orphan).toBeUndefined();
    expect(lonely?.orphan).toBe(true);
  });

  it("does not report a sources citation as retired_still_linked", async () => {
    const read = await vaultRead(vault, "decisions/retired.md");
    if (!read.ok) throw read.error;
    expect(read.value.structural).toBeNull();
  });

  it("computes from the caller's vantage: a hidden citer neither counts nor leaks", async () => {
    const full = await vaultRead(vault, "decisions/shadowed.md");
    if (!full.ok) throw full.error;
    expect(full.value.structural).toBeNull();

    const decisionsOnly = {
      user: "human:narrow",
      roleName: "decisions-only",
      role: { read: ["decisions"], write: [], promote: false, ratify: false },
    };
    const gated = await vaultRead(vault, "decisions/shadowed.md", decisionsOnly);
    if (!gated.ok) throw gated.error;
    expect(gated.value.structural?.orphan).toBe(true);
    expect(JSON.stringify(gated.value.structural)).not.toContain("hidden-citer");
  });

  it("an incremental write adds the edge even when the body has no links", async () => {
    await write("decisions/note.md", "# Note\n\nNo links here.\n", {
      sources: ["vault:decisions/lonely.md"],
    });
    const read = await vaultRead(vault, "decisions/lonely.md");
    if (!read.ok) throw read.error;
    expect(read.value.structural).toBeNull();
  }, 60_000);

  it("lint and the materialized graph agree on who is an orphan", async () => {
    const report = await runLint(vault);
    if (!report.ok) throw report.error;
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    try {
      const paths = (
        opened.value.prepare("SELECT path, status FROM documents").all() as {
          path: string;
          status: string;
        }[]
      )
        .filter((d) => structuralDecay({ db: opened.value, ...d })?.orphan)
        .map((d) => d.path)
        .sort();
      expect(paths).toEqual(report.value.checks.orphanFiles.map((f) => f.path).sort());
    } finally {
      opened.value.close();
    }
  });
});
