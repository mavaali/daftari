// Phase 3 of the tension graph plan (2026-05-31): blast radius — the
// transitive closure of downstream documents that cite or link a contested
// document, or the union over a contested cluster.
//
// Test surface mirrors the spec's required cases:
//   1.  Single source edge, document mode.
//   2.  Single link edge, document mode.
//   3.  Mixed source+link edge — source wins.
//   4.  Distance-2 chain via sources.
//   5.  Distance-2 chain via links.
//   6.  Cycle protection.
//   7.  `superseded_by` is NOT a blast edge.
//   8.  `superseded_by` PLUS independent citation still surfaces via the
//       independent edge (not via supersession).
//   9.  Cluster mode — union of two members' downstream.
//   10. Cluster mode — dedup with channel precedence.
//   11. Cluster mode — minimum distance preserved.
//   12. No downstream — zeroed counts, empty list.
//   13. Errors — neither/both/unknown-doc/unknown-cluster.
//   14. Document IS in a cluster — context populated.
//   15. Document is NOT in any cluster — `cluster_id: null`, empty members
//       array. Convention: null over absent, so the response shape is the
//       same across both modes and consumers never need to branch on
//       undefined vs null.
//   16. Sort order — (distance ASC, source before link, path ASCII ASC).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTension } from "../../src/curation/tension.js";
import {
  buildReverseLinkMap,
  buildReverseSourceMap,
  computeBlast,
  computeTensionBlast,
} from "../../src/curation/tension-blast.js";
import type { LoadedDoc } from "../../src/curation/vault-docs.js";
import type { Frontmatter } from "../../src/frontmatter/types.js";

// Synthetic-doc helper for the pure reverse-map tests. Only the fields the
// builders read (`path`, `content`, `frontmatter.sources`) are meaningful;
// the rest are filled with valid placeholders.
function syntheticDoc(opts: { path: string; content?: string; sources?: string[] }): LoadedDoc {
  const fm: Frontmatter = {
    title: opts.path,
    domain: "accumulation",
    collection: "blast",
    status: "canonical",
    confidence: "high",
    created: "2026-05-01",
    updated: "2026-05-01",
    updated_by: "agent:test",
    provenance: "direct",
    sources: opts.sources ?? [],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    questions_answered: [],
    questions_raised: [],
  };
  return { path: opts.path, frontmatter: fm, content: opts.content ?? "" };
}

interface DocSpec {
  path: string;
  sources?: string[];
  superseded_by?: string | null;
  links?: string[]; // each rendered as `[ref](target)` in the body
  body?: string;
}

// Writes a markdown file with a valid frontmatter block. Defaults give a
// canonical, high-confidence doc — none of the lint carve-outs apply, so the
// loader picks it up unconditionally.
async function writeDoc(vault: string, spec: DocSpec): Promise<void> {
  const sources = spec.sources ?? [];
  const sourcesYaml =
    sources.length === 0 ? "sources: []" : `sources:\n${sources.map((s) => `  - ${s}`).join("\n")}`;
  const supersededYaml =
    spec.superseded_by === undefined || spec.superseded_by === null
      ? "superseded_by: null"
      : `superseded_by: ${spec.superseded_by}`;

  const fm = [
    "---",
    `title: "${spec.path}"`,
    "domain: accumulation",
    "collection: blast",
    "status: canonical",
    "confidence: high",
    "created: 2026-05-01",
    "updated: 2026-05-01",
    "updated_by: agent:test",
    "provenance: direct",
    sourcesYaml,
    supersededYaml,
    "ttl_days: null",
    "tags: []",
    "---",
    "",
  ].join("\n");

  const linkLines = (spec.links ?? []).map((target) => `[ref](${target})`).join("\n");
  const body = spec.body ?? "";
  const content = `${fm}${linkLines}${linkLines && body ? "\n" : ""}${body}\n`;

  const abs = join(vault, spec.path);
  mkdirSync(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe("computeBlast (pure)", () => {
  it("terminates on a cycle (A↔B mutual sources)", () => {
    // reverseSource.get(A) = {B} — B sources A. reverseSource.get(B) = {A}.
    const reverseSource = new Map<string, Set<string>>([
      ["a.md", new Set(["b.md"])],
      ["b.md", new Set(["a.md"])],
    ]);
    const reverseLink = new Map<string, Set<string>>();
    const result = computeBlast({
      seeds: ["a.md"],
      reverseSource,
      reverseLink,
    });
    expect(result.downstream).toEqual([{ path: "b.md", dependency_type: "source", distance: 1 }]);
    expect(result.primary_blast).toBe(1);
    expect(result.advisory_blast).toBe(0);
    expect(result.max_depth).toBe(1);
  });

  it("sorts downstream by (distance ASC, source before link, path ASC)", () => {
    // Distance 1: m-source.md (source), b-link.md (link), a-source.md (source)
    // Distance 2: z-source.md (source via a-source), c-link.md (link via b-link)
    const reverseSource = new Map<string, Set<string>>([
      ["seed.md", new Set(["a-source.md", "m-source.md"])],
      ["a-source.md", new Set(["z-source.md"])],
    ]);
    const reverseLink = new Map<string, Set<string>>([
      ["seed.md", new Set(["b-link.md"])],
      ["b-link.md", new Set(["c-link.md"])],
    ]);
    const result = computeBlast({
      seeds: ["seed.md"],
      reverseSource,
      reverseLink,
    });
    expect(result.downstream.map((e) => `${e.distance}:${e.dependency_type}:${e.path}`)).toEqual([
      "1:source:a-source.md",
      "1:source:m-source.md",
      "1:link:b-link.md",
      "2:source:z-source.md",
      "2:link:c-link.md",
    ]);
    expect(result.max_depth).toBe(2);
    expect(result.primary_blast).toBe(3);
    expect(result.advisory_blast).toBe(2);
  });
});

describe("buildReverseSourceMap / buildReverseLinkMap", () => {
  it("collects sources and skips self-citations", () => {
    const docs: LoadedDoc[] = [
      syntheticDoc({ path: "a.md", sources: ["a.md"] }),
      syntheticDoc({ path: "b.md", sources: ["a.md"] }),
    ];
    const map = buildReverseSourceMap(docs);
    expect([...(map.get("a.md") ?? [])]).toEqual(["b.md"]);
    // No self-loop entry.
    expect(map.has("b.md")).toBe(false);
  });

  it("collects in-vault links and skips externals", () => {
    const docs: LoadedDoc[] = [
      syntheticDoc({ path: "a.md" }),
      syntheticDoc({
        path: "b.md",
        content: "see [ref](a.md) and [google](https://google.com)",
      }),
    ];
    const map = buildReverseLinkMap(docs);
    expect([...(map.get("a.md") ?? [])]).toEqual(["b.md"]);
  });
});

describe("computeTensionBlast", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-blast-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("traces a single source edge (B sources A) in document mode", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md", sources: ["a.md"] });

    const result = await computeTensionBlast(vault, { document: "a.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contested_document).toBe("a.md");
    expect(result.value.downstream).toEqual([
      { path: "b.md", dependency_type: "source", distance: 1 },
    ]);
    expect(result.value.primary_blast).toBe(1);
    expect(result.value.advisory_blast).toBe(0);
    expect(result.value.max_depth).toBe(1);
  });

  it("traces a single link edge (C links A) in document mode", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "c.md", links: ["a.md"] });

    const result = await computeTensionBlast(vault, { document: "a.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.downstream).toEqual([
      { path: "c.md", dependency_type: "link", distance: 1 },
    ]);
    expect(result.value.primary_blast).toBe(0);
    expect(result.value.advisory_blast).toBe(1);
    expect(result.value.max_depth).toBe(1);
  });

  it("reports source once when a doc has BOTH sources and links to the contested doc", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "d.md", sources: ["a.md"], links: ["a.md"] });

    const result = await computeTensionBlast(vault, { document: "a.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.downstream).toEqual([
      { path: "d.md", dependency_type: "source", distance: 1 },
    ]);
    expect(result.value.primary_blast).toBe(1);
    expect(result.value.advisory_blast).toBe(0);
  });

  it("walks a distance-2 source chain (B sources A, C sources B)", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md", sources: ["a.md"] });
    await writeDoc(vault, { path: "c.md", sources: ["b.md"] });

    const result = await computeTensionBlast(vault, { document: "a.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.downstream).toEqual([
      { path: "b.md", dependency_type: "source", distance: 1 },
      { path: "c.md", dependency_type: "source", distance: 2 },
    ]);
    expect(result.value.primary_blast).toBe(2);
    expect(result.value.advisory_blast).toBe(0);
    expect(result.value.max_depth).toBe(2);
  });

  it("walks a distance-2 link chain (B links A, C links B)", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md", links: ["a.md"] });
    await writeDoc(vault, { path: "c.md", links: ["b.md"] });

    const result = await computeTensionBlast(vault, { document: "a.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.downstream).toEqual([
      { path: "b.md", dependency_type: "link", distance: 1 },
      { path: "c.md", dependency_type: "link", distance: 2 },
    ]);
    expect(result.value.primary_blast).toBe(0);
    expect(result.value.advisory_blast).toBe(2);
    expect(result.value.max_depth).toBe(2);
  });

  it("terminates on a cycle (A and B mutually source each other)", async () => {
    await writeDoc(vault, { path: "a.md", sources: ["b.md"] });
    await writeDoc(vault, { path: "b.md", sources: ["a.md"] });

    const result = await computeTensionBlast(vault, { document: "a.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.downstream).toEqual([
      { path: "b.md", dependency_type: "source", distance: 1 },
    ]);
    expect(result.value.max_depth).toBe(1);
  });

  it("does NOT follow `superseded_by` as a blast edge", async () => {
    // A.superseded_by = B; nothing else cites or links A. B should NOT show
    // up as downstream because supersession is not a blast edge.
    await writeDoc(vault, { path: "a.md", superseded_by: "b.md" });
    await writeDoc(vault, { path: "b.md" });

    const result = await computeTensionBlast(vault, { document: "a.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.downstream).toEqual([]);
    expect(result.value.primary_blast).toBe(0);
    expect(result.value.advisory_blast).toBe(0);
    expect(result.value.max_depth).toBe(0);
  });

  it("surfaces a superseder via an independent source edge, not via supersession", async () => {
    // A.superseded_by = B. Independently: C.sources=[A], B.sources=[C].
    // Blast(A) must trace C (d=1, source) then B (d=2, source via C), NOT B
    // at d=1 via supersession.
    await writeDoc(vault, { path: "a.md", superseded_by: "b.md" });
    await writeDoc(vault, { path: "c.md", sources: ["a.md"] });
    await writeDoc(vault, { path: "b.md", sources: ["c.md"] });

    const result = await computeTensionBlast(vault, { document: "a.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.downstream).toEqual([
      { path: "c.md", dependency_type: "source", distance: 1 },
      { path: "b.md", dependency_type: "source", distance: 2 },
    ]);
    expect(result.value.primary_blast).toBe(2);
    expect(result.value.advisory_blast).toBe(0);
  });

  it("returns empty downstream for a doc with no inbound sources or links", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "other.md" });

    const result = await computeTensionBlast(vault, { document: "a.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.downstream).toEqual([]);
    expect(result.value.primary_blast).toBe(0);
    expect(result.value.advisory_blast).toBe(0);
    expect(result.value.max_depth).toBe(0);
  });

  it("populates cluster context when the document is in a cluster", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md" });
    // Logging a tension between A and B builds a cluster of {a.md, b.md}.
    await addTension(vault, {
      title: "a/b disagreement",
      sourceA: "a.md",
      claimA: "X",
      sourceB: "b.md",
      claimB: "Y",
      loggedBy: "agent:test",
      kind: "factual",
    });

    const result = await computeTensionBlast(vault, { document: "a.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contested_document).toBe("a.md");
    expect(result.value.cluster_id).toMatch(/^cluster:[0-9a-f]{8}$/);
    expect(result.value.cluster_documents).toEqual(["a.md", "b.md"]);
  });

  it("reports cluster_id: null and an empty cluster_documents when the doc is not in any cluster", async () => {
    await writeDoc(vault, { path: "lone.md" });

    const result = await computeTensionBlast(vault, { document: "lone.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contested_document).toBe("lone.md");
    // Convention: null over absent so the response shape is identical across
    // both modes — consumers never branch on undefined vs null.
    expect(result.value.cluster_id).toBeNull();
    expect(result.value.cluster_documents).toEqual([]);
  });

  it("unions downstream sets across cluster members (cluster mode)", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md" });
    await writeDoc(vault, { path: "c.md", sources: ["a.md"] });
    await writeDoc(vault, { path: "d.md", sources: ["b.md"] });
    await addTension(vault, {
      title: "cluster ab",
      sourceA: "a.md",
      claimA: "X",
      sourceB: "b.md",
      claimB: "Y",
      loggedBy: "agent:test",
      kind: "factual",
    });

    // Look up the cluster id from the document-mode response.
    const docResult = await computeTensionBlast(vault, { document: "a.md" });
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) return;
    const clusterId = docResult.value.cluster_id;
    expect(clusterId).not.toBeNull();

    const result = await computeTensionBlast(vault, { cluster_id: clusterId as string });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contested_document).toBeNull();
    expect(result.value.cluster_documents).toEqual(["a.md", "b.md"]);
    expect(result.value.downstream).toEqual([
      { path: "c.md", dependency_type: "source", distance: 1 },
      { path: "d.md", dependency_type: "source", distance: 1 },
    ]);
    expect(result.value.primary_blast).toBe(2);
    expect(result.value.advisory_blast).toBe(0);
    expect(result.value.max_depth).toBe(1);
  });

  it("dedups a doc reached via both a source edge and a link edge in cluster mode (source wins)", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md" });
    // C sources A AND C links B. In cluster {A, B}, C must surface once
    // with dependency_type: source.
    await writeDoc(vault, { path: "c.md", sources: ["a.md"], links: ["b.md"] });
    await addTension(vault, {
      title: "cluster ab",
      sourceA: "a.md",
      claimA: "X",
      sourceB: "b.md",
      claimB: "Y",
      loggedBy: "agent:test",
      kind: "factual",
    });

    const docResult = await computeTensionBlast(vault, { document: "a.md" });
    if (!docResult.ok) throw new Error("setup failed");
    const clusterId = docResult.value.cluster_id as string;

    const result = await computeTensionBlast(vault, { cluster_id: clusterId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.downstream).toEqual([
      { path: "c.md", dependency_type: "source", distance: 1 },
    ]);
    expect(result.value.primary_blast).toBe(1);
    expect(result.value.advisory_blast).toBe(0);
  });

  it("preserves the minimum distance across cluster members", async () => {
    // Cluster {A, B}. C.sources=[A] (C is direct downstream of A at d=1).
    // D.sources=[B] (D is downstream of B at d=1). C.sources also contains
    // D (so C is reachable from B at d=2 via D). C's distance is 1 (the min).
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md" });
    await writeDoc(vault, { path: "d.md", sources: ["b.md"] });
    await writeDoc(vault, { path: "c.md", sources: ["a.md", "d.md"] });
    await addTension(vault, {
      title: "cluster ab",
      sourceA: "a.md",
      claimA: "X",
      sourceB: "b.md",
      claimB: "Y",
      loggedBy: "agent:test",
      kind: "factual",
    });

    const docResult = await computeTensionBlast(vault, { document: "a.md" });
    if (!docResult.ok) throw new Error("setup failed");
    const clusterId = docResult.value.cluster_id as string;

    const result = await computeTensionBlast(vault, { cluster_id: clusterId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cEntry = result.value.downstream.find((e) => e.path === "c.md");
    expect(cEntry).toEqual({ path: "c.md", dependency_type: "source", distance: 1 });
    const dEntry = result.value.downstream.find((e) => e.path === "d.md");
    expect(dEntry).toEqual({ path: "d.md", dependency_type: "source", distance: 1 });
    expect(result.value.max_depth).toBe(1);
  });

  describe("errors", () => {
    it("rejects calls with neither document nor cluster_id", async () => {
      const result = await computeTensionBlast(vault, {});
      expect(result.ok).toBe(false);
    });

    it("rejects calls with both document and cluster_id", async () => {
      await writeDoc(vault, { path: "a.md" });
      const result = await computeTensionBlast(vault, {
        document: "a.md",
        cluster_id: "cluster:00000000",
      });
      expect(result.ok).toBe(false);
    });

    it("rejects an unknown document path", async () => {
      await writeDoc(vault, { path: "a.md" });
      const result = await computeTensionBlast(vault, { document: "nonexistent.md" });
      expect(result.ok).toBe(false);
    });

    it("rejects a cluster_id with no matching current cluster", async () => {
      await writeDoc(vault, { path: "a.md" });
      const result = await computeTensionBlast(vault, { cluster_id: "cluster:deadbeef" });
      expect(result.ok).toBe(false);
    });
  });
});
