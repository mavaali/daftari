import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { exportBundle } from "../../src/okf/export.js";

describe("exportBundle", () => {
  const tmpDirs: string[] = [];

  function makeVault(docs: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "daftari-okf-export-"));
    tmpDirs.push(dir);
    for (const [rel, body] of Object.entries(docs)) {
      const path = join(dir, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body, "utf-8");
    }
    return dir;
  }

  const helios = `---
title: "Helios Consumption Pricing"
domain: accumulation
collection: pricing
status: canonical
confidence: high
created: 2026-01-20
updated: 2026-05-10
updated_by: human:me
provenance: direct
sources:
  - helios-pricing-page
  - https://helios.test/pricing
superseded_by: null
ttl_days: 45
tags: [helios, pricing]
---

# Helios Consumption Pricing

Helios bills in compute credits. More detail follows.
`;

  const moonshot = `---
title: "Moonshot"
domain: generative
collection: moonshot
status: draft
confidence: low
created: 2026-03-01
updated: 2026-03-01
updated_by: agent:x
provenance: inferred
sources: []
superseded_by: null
ttl_days: null
tags: []
---

# Moonshot

A speculative sketch.
`;

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes an OKF concept doc per vault doc, preserving the folder layout", async () => {
    const vault = makeVault({
      "pricing/helios.md": helios,
      "moonshot/moonshot.md": moonshot,
    });
    const out = mkdtempSync(join(tmpdir(), "daftari-okf-out-"));
    tmpDirs.push(out);

    const result = await exportBundle(vault, out);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentCount).toBe(2);

    const doc = matter(readFileSync(join(out, "pricing/helios.md"), "utf-8"));
    expect(doc.data.type).toBe("pricing"); // OKF required field, from collection
    expect(doc.data.title).toBe("Helios Consumption Pricing");
    expect(doc.data.description).toBe("Helios bills in compute credits.");
    expect(doc.data.resource).toBe("https://helios.test/pricing"); // first URI source
    expect(doc.data.tags).toEqual(["helios", "pricing"]);
    expect(doc.data.timestamp).toBe("2026-05-10T00:00:00Z");
    // Lossless sidecar retains the original Daftari frontmatter.
    expect((doc.data.daftari as Record<string, unknown>).status).toBe("canonical");
    // Body is preserved.
    expect(doc.content).toContain("Helios bills in compute credits.");
  });

  it("generates root index.md (with okf_version) and log.md", async () => {
    const vault = makeVault({ "pricing/helios.md": helios, "moonshot/moonshot.md": moonshot });
    const out = mkdtempSync(join(tmpdir(), "daftari-okf-out-"));
    tmpDirs.push(out);

    await exportBundle(vault, out);

    const index = matter(readFileSync(join(out, "index.md"), "utf-8"));
    expect(index.data.okf_version).toBe("0.1");
    expect(index.content).toContain("(/pricing/helios.md)");
    expect(index.content).toContain("(/moonshot/moonshot.md)");

    const log = readFileSync(join(out, "log.md"), "utf-8");
    // Newest updated date first.
    expect(log.indexOf("## 2026-05-10")).toBeLessThan(log.indexOf("## 2026-03-01"));
  });

  it("filters to a single collection when requested", async () => {
    const vault = makeVault({ "pricing/helios.md": helios, "moonshot/moonshot.md": moonshot });
    const out = mkdtempSync(join(tmpdir(), "daftari-okf-out-"));
    tmpDirs.push(out);

    const result = await exportBundle(vault, out, { collection: "pricing" });
    expect(result.ok && result.value.documentCount).toBe(1);
    const index = readFileSync(join(out, "index.md"), "utf-8");
    expect(index).toContain("/pricing/helios.md");
    expect(index).not.toContain("/moonshot/moonshot.md");
  });
});
