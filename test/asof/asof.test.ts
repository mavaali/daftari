import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTreeDocs, readBlobsAt, resolveAsofCommit } from "../../src/asof/git-read.js";
import { runAsof } from "../../src/asof/index.js";
import {
  beliefSnapshot,
  computeTransitions,
  counterfactualReplay,
  docTrajectory,
  loadDocumentsAt,
} from "../../src/asof/snapshot.js";
import { listTensions } from "../../src/curation/tension.js";

// ---------------------------------------------------------------------------
// Fixture: a real git repo with two commits and controlled dates.
//
//   commit v1 (2026-01-15): pricing/base.md (canonical, cited by two docs),
//     pricing/derived.md (sources: base), competitive-intel/linked.md
//     (markdown link to base), pricing/doomed.md, and a tension log with one
//     unresolved tension.
//   commit v2 (2026-03-20): base flips canonical→superseded and gains a
//     successor; derived's body changes; doomed is deleted; moonshot/new.md
//     appears; the tension is resolved and a new one is opened.
// ---------------------------------------------------------------------------

let vault: string;
let v1: string;

function git(args: string[], date: string): void {
  execFileSync("git", ["-C", vault, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `${date}T12:00:00`,
      GIT_COMMITTER_DATE: `${date}T12:00:00`,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@daftari.local",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@daftari.local",
    },
  });
}

function md(
  path: string,
  overrides: Record<string, string | null>,
  body: string,
  sources: string[] = [],
): void {
  const fm: Record<string, string | null> = {
    title: `Doc ${path}`,
    domain: "accumulation",
    collection: path.split("/")[0] ?? "",
    status: "canonical",
    confidence: "medium",
    created: "2026-01-15",
    updated: "2026-01-15",
    updated_by: "agent:test",
    provenance: "direct",
    superseded_by: null,
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => (v === null ? `${k}: null` : `${k}: "${v}"`));
  const src =
    sources.length > 0 ? `sources:\n${sources.map((s) => `  - "${s}"`).join("\n")}` : "sources: []";
  mkdirSync(join(vault, path.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(
    join(vault, path),
    `---\n${lines.join("\n")}\nttl_days: 365\n${src}\ntags: []\n---\n\n${body}\n`,
    "utf-8",
  );
}

const TENSIONS_V1 = `## 2026-01-15 — Base disputed by derived
- **Id:** tension-asof-1
- **Kind:** factual
- **Source A:** pricing/base.md says X.
- **Source B:** pricing/derived.md says Y.
- **Status:** unresolved
- **Logged by:** agent:test
`;

const TENSIONS_V2 = `## 2026-01-15 — Base disputed by derived
- **Id:** tension-asof-1
- **Kind:** factual
- **Source A:** pricing/base.md says X.
- **Source B:** pricing/derived.md says Y.
- **Status:** resolved
- **Logged by:** agent:test
- **Resolved at:** 2026-03-20T10:00:00Z
- **Resolved by:** human:test
- **Resolution kind:** superseded

## 2026-03-20 — New dispute
- **Id:** tension-asof-2
- **Kind:** interpretive
- **Source A:** pricing/base-v2.md says P.
- **Source B:** competitive-intel/linked.md says Q.
- **Status:** unresolved
- **Logged by:** agent:test
`;

beforeAll(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-asof-"));
  git(["init", "--quiet"], "2026-01-15");

  // v1
  md("pricing/base.md", {}, "Base fact.");
  md("pricing/derived.md", {}, "Derived from base.", ["pricing/base.md"]);
  md("competitive-intel/linked.md", {}, "See [base](../pricing/base.md).");
  md("pricing/doomed.md", { confidence: "low" }, "Will be deleted.", ["pricing/base.md"]);
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(join(vault, ".daftari", "tensions.md"), TENSIONS_V1, "utf-8");
  git(["add", "."], "2026-01-15");
  git(["commit", "--quiet", "-m", "v1: seed vault"], "2026-01-15");
  v1 = execFileSync("git", ["-C", vault, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  // v2
  md(
    "pricing/base.md",
    { status: "superseded", superseded_by: "pricing/base-v2.md", updated: "2026-03-20" },
    "Base fact (superseded).",
  );
  md("pricing/base-v2.md", { created: "2026-03-20", updated: "2026-03-20" }, "Corrected base.");
  md(
    "pricing/derived.md",
    { confidence: "high", updated: "2026-03-20" },
    "Derived, rewritten against v2.",
    ["pricing/base.md"],
  );
  md("moonshot/new.md", { created: "2026-03-20", updated: "2026-03-20" }, "New speculation.");
  unlinkSync(join(vault, "pricing/doomed.md"));
  writeFileSync(join(vault, ".daftari", "tensions.md"), TENSIONS_V2, "utf-8");
  git(["add", "-A", "."], "2026-03-20");
  git(["commit", "--quiet", "-m", "v2: supersede base"], "2026-03-20");
});

afterAll(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("resolveAsofCommit", () => {
  it("resolves a ref", async () => {
    const r = await resolveAsofCommit(vault, "HEAD~1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hash).toBe(v1);
    expect(r.value.date).toBe("2026-01-15");
    expect(r.value.subject).toBe("v1: seed vault");
  });

  it("resolves a date to the last commit on or before it", async () => {
    const r = await resolveAsofCommit(vault, "2026-02-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hash).toBe(v1);
  });

  it("resolves the exact commit date inclusively", async () => {
    const r = await resolveAsofCommit(vault, "2026-01-15");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hash).toBe(v1);
  });

  it("errors on a date before all history", async () => {
    const r = await resolveAsofCommit(vault, "2020-01-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("no commit exists on or before");
  });

  it("errors on an unresolvable ref", async () => {
    const r = await resolveAsofCommit(vault, "not-a-ref");
    expect(r.ok).toBe(false);
  });
});

describe("listTreeDocs / readBlobsAt", () => {
  it("lists managed markdown at the historical commit, excluding .daftari", async () => {
    const r = await listTreeDocs(vault, v1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([
      "competitive-intel/linked.md",
      "pricing/base.md",
      "pricing/derived.md",
      "pricing/doomed.md",
    ]);
  });

  it("batch-reads blobs and skips missing paths", async () => {
    const r = await readBlobsAt(vault, v1, ["pricing/base.md", "pricing/nope.md"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.get("pricing/base.md")).toContain("Base fact.");
    expect(r.value.has("pricing/nope.md")).toBe(false);
  });
});

describe("loadDocumentsAt", () => {
  it("parses historical documents with the live parser", async () => {
    const r = await loadDocumentsAt(vault, v1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const base = r.value.find((d) => d.path === "pricing/base.md");
    expect(base?.frontmatter.status).toBe("canonical");
    expect(base?.content).toContain("Base fact.");
  });
});

describe("beliefSnapshot", () => {
  it("reports the state then and the drift since", async () => {
    const commit = await resolveAsofCommit(vault, "HEAD~1");
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const tensionsNow = await listTensions(vault);
    expect(tensionsNow.ok).toBe(true);
    if (!tensionsNow.ok) return;

    const r = await beliefSnapshot(vault, commit.value, tensionsNow.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value;

    expect(s.docCount).toBe(4);
    expect(s.byStatus).toEqual({ canonical: 4 });
    expect(s.byCollection).toEqual({ pricing: 3, "competitive-intel": 1 });

    expect(s.drift.added).toEqual(["moonshot/new.md", "pricing/base-v2.md"]);
    expect(s.drift.removed).toEqual(["pricing/doomed.md"]);
    expect(s.drift.transitions).toEqual([
      { path: "pricing/base.md", field: "status", from: "canonical", to: "superseded" },
      { path: "pricing/derived.md", field: "confidence", from: "medium", to: "high" },
    ]);
    expect(s.drift.bodiesChanged).toBe(2); // base and derived bodies changed

    expect(s.tensions.openThen).toBe(1);
    expect(s.tensions.openNow).toBe(1);
    expect(s.tensions.openedSince).toEqual([
      { title: "New dispute", date: "2026-03-20", kind: "interpretive" },
    ]);
    expect(s.tensions.resolvedSince).toEqual([
      {
        title: "Base disputed by derived",
        date: "2026-01-15",
        kind: "factual",
        resolutionKind: "superseded",
      },
    ]);
  });
});

describe("counterfactualReplay", () => {
  it("computes blast over the historical tree and annotates present status", async () => {
    const commit = await resolveAsofCommit(vault, "HEAD~1");
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    const r = await counterfactualReplay(vault, commit.value, "pricing/base.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // At v1, derived and doomed cite base via sources (primary) and linked
    // links to it (advisory). derived and linked survive to now; doomed was
    // deleted at v2, so its present-day status reads "gone".
    expect(r.value.downstreamThen).toEqual([
      {
        path: "pricing/derived.md",
        dependency_type: "source",
        distance: 1,
        statusNow: "canonical",
      },
      {
        path: "pricing/doomed.md",
        dependency_type: "source",
        distance: 1,
        statusNow: "gone",
      },
      {
        path: "competitive-intel/linked.md",
        dependency_type: "link",
        distance: 1,
        statusNow: "canonical",
      },
    ]);
    expect(r.value.primaryBlast).toBe(2);
    expect(r.value.advisoryBlast).toBe(1);
    expect(r.value.stillCanonicalNow).toBe(2);
    expect(r.value.goneNow).toBe(1);
  });

  it("errors on a document absent from the vault at the as-of commit", async () => {
    const commit = await resolveAsofCommit(vault, "HEAD~1");
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const r = await counterfactualReplay(vault, commit.value, "moonshot/new.md");
    expect(r.ok).toBe(false); // did not exist at v1
    if (r.ok) return;
    expect(r.error.message).toContain("not found in the vault at");
  });
});

describe("docTrajectory", () => {
  it("shows then vs now and the commits between", async () => {
    const commit = await resolveAsofCommit(vault, "HEAD~1");
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    const r = await docTrajectory(vault, commit.value, "pricing/base.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.asOf?.status).toBe("canonical");
    expect(r.value.current?.status).toBe("superseded");
    expect(r.value.commitsBetween).toHaveLength(1);
    expect(r.value.commitsBetween[0]?.subject).toBe("v2: supersede base");
  });

  it("reports a document deleted since as now: null", async () => {
    const commit = await resolveAsofCommit(vault, "HEAD~1");
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const r = await docTrajectory(vault, commit.value, "pricing/doomed.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.asOf?.status).toBe("canonical");
    expect(r.value.current).toBeNull();
  });

  it("errors on a path unknown both then and now", async () => {
    const commit = await resolveAsofCommit(vault, "HEAD~1");
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const r = await docTrajectory(vault, commit.value, "pricing/never.md");
    expect(r.ok).toBe(false);
  });
});

describe("computeTransitions", () => {
  it("is empty when nothing changed", () => {
    expect(computeTransitions([], [])).toEqual([]);
  });
});

describe("runAsof (CLI)", () => {
  it("writes a markdown and JSON report", async () => {
    const outMd = join(vault, "..", `asof-out-${Date.now()}.md`);
    const outJson = `${outMd}.json`;
    const code = await runAsof([
      "HEAD~1",
      "--vault",
      vault,
      "--doc",
      "pricing/base.md",
      "--blast",
      "pricing/base.md",
      "--output",
      outMd,
      "--output-json",
      outJson,
    ]);
    expect(code).toBe(0);

    const { readFileSync } = await import("node:fs");
    const mdOut = readFileSync(outMd, "utf-8");
    expect(mdOut).toContain("# Belief Snapshot — as of 2026-01-15");
    expect(mdOut).toContain("| pricing/base.md | status | canonical | superseded |");
    expect(mdOut).toContain("## Counterfactual replay — pricing/base.md");
    expect(mdOut).toContain("## Document trajectory — pricing/base.md");

    const json = JSON.parse(readFileSync(outJson, "utf-8"));
    expect(json.snapshot.docCount).toBe(4);
    expect(json.replay.downstreamThen).toHaveLength(3);
    rmSync(outMd, { force: true });
    rmSync(outJson, { force: true });
  });

  it("exits 2 on an unresolvable ref", async () => {
    const code = await runAsof(["not-a-ref", "--vault", vault, "--output", "/dev/null"]);
    expect(code).toBe(2);
  });

  it("exits 2 when the vault is not a git repo", async () => {
    const bare = mkdtempSync(join(tmpdir(), "daftari-asof-nogit-"));
    try {
      const code = await runAsof(["HEAD", "--vault", bare]);
      expect(code).toBe(2);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("exits 2 when <ref-or-date> is missing", async () => {
    const code = await runAsof(["--vault", vault]);
    expect(code).toBe(2);
  });

  it("prints help on --help", async () => {
    const code = await runAsof(["--help"]);
    expect(code).toBe(0);
  });
});
