import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { importBundle } from "../../src/okf/import.js";

describe("importBundle", () => {
  const tmpDirs: string[] = [];

  function mkTmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  function writeDoc(root: string, rel: string, body: string): void {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf-8");
  }

  const foreignDoc = `---
type: BigQuery Table
title: Orders
resource: bigquery://proj/ds/orders
tags: [sales, core]
timestamp: 2026-06-15T12:00:00Z
---

# Orders

One row per order.
`;

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("dry-run reports the plan and writes nothing", async () => {
    const bundle = mkTmp("okf-bundle-");
    const vault = mkTmp("okf-vault-");
    writeDoc(bundle, "playbooks/orders.md", foreignDoc);
    writeDoc(bundle, "index.md", "# Index\n"); // reserved — must be ignored

    const result = await importBundle(bundle, vault, { dryRun: true, today: "2026-07-13" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dryRun).toBe(true);
    expect(result.value.imported).toBe(1);
    expect(result.value.plan).toHaveLength(1);
    expect(result.value.plan[0].collection).toBe("playbooks");
    expect(result.value.plan[0].roundTrip).toBe(false);
    expect(result.value.commit).toBeNull();
  });

  it("synthesizes Daftari frontmatter for a foreign bundle and skips reserved files", async () => {
    const bundle = mkTmp("okf-bundle-");
    const vault = mkTmp("okf-vault-");
    writeDoc(bundle, "playbooks/orders.md", foreignDoc);
    writeDoc(bundle, "index.md", "# Index\n");
    writeDoc(bundle, "log.md", "# Log\n");

    const result = await importBundle(bundle, vault, { today: "2026-07-13" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imported).toBe(1);

    const doc = matter(readFileSync(join(vault, "playbooks/orders.md"), "utf-8"));
    expect(doc.data.collection).toBe("playbooks");
    expect(doc.data.domain).toBe("accumulation");
    expect(doc.data.status).toBe("draft");
    expect(doc.data.sources).toEqual(["bigquery://proj/ds/orders"]);
    expect(doc.data.okf_type).toBe("BigQuery Table");
    expect(doc.content).toContain("One row per order.");

    // Reserved files were not imported as concept docs.
    let missing = false;
    try {
      readFileSync(join(vault, "index.md"), "utf-8");
    } catch {
      missing = true;
    }
    expect(missing).toBe(true);
  });

  it("maps v0.2 trust signals: verified, status, stale_after, structured sources", async () => {
    const bundle = mkTmp("okf-bundle-");
    const vault = mkTmp("okf-vault-");
    const v02Doc = `---
type: Metric Definition
title: Net Revenue
generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-30T14:00:00Z }
verified:
  - { by: human:jsmith@acme, at: 2026-07-01T09:00:00Z }
status: stable
stale_after: 2026-12-31
sources:
  - id: revenue-policy
    resource: https://wiki.test/policies/revenue
    author: human:jsmith@acme
    last_modified: 2026-06-15
---

# Net Revenue

Delivered orders only, 30-day return window.
`;
    writeDoc(bundle, "metrics/net-revenue.md", v02Doc);

    const result = await importBundle(bundle, vault, { today: "2026-07-13" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const doc = matter(readFileSync(join(vault, "metrics/net-revenue.md"), "utf-8"));
    expect(doc.data.created).toBe("2026-06-30"); // from generated.at
    expect(doc.data.confidence).toBe("high"); // human-reviewed trust tier
    expect(doc.data.status).toBe("draft"); // stable is NOT canonized on import
    expect(doc.data.ttl_days).toBe(184); // 2026-06-30 → 2026-12-31
    expect(doc.data.sources).toEqual(["https://wiki.test/policies/revenue"]);
    // The trust record survives under okf_* keys.
    expect(doc.data.okf_generated).toBeTruthy();
    expect(doc.data.okf_verified).toBeTruthy();
    expect(doc.data.okf_sources).toBeTruthy();
  });

  it("imports an Attested Computation as tier: source", async () => {
    const bundle = mkTmp("okf-bundle-");
    const vault = mkTmp("okf-vault-");
    const attestedDoc = `---
type: Attested Computation
title: Revenue for a fiscal year
runtime: bigquery
parameters:
  - { name: year, type: integer, required: true }
executor:
  resource: skills/run-on-bq.md
receipt: [job_id, executed_sql, result]
attester:
  resource: attesters/sql_equality.py
status: stable
---

# Computation

SELECT 1
`;
    writeDoc(bundle, "computations/revenue.md", attestedDoc);

    const result = await importBundle(bundle, vault, { today: "2026-07-13" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const doc = matter(readFileSync(join(vault, "computations/revenue.md"), "utf-8"));
    expect(doc.data.tier).toBe("source"); // body immutable — sanctioned computation
    expect(doc.data.okf_type).toBe("Attested Computation");
    expect(doc.data.okf_runtime).toBe("bigquery");
    expect(doc.data.okf_attester).toEqual({ resource: "attesters/sql_equality.py" });
  });

  it("round-trips a doc carrying a daftari sidecar verbatim", async () => {
    const bundle = mkTmp("okf-bundle-");
    const vault = mkTmp("okf-vault-");
    // An OKF doc as produced by `okf export`: core fields + verbatim sidecar.
    const withSidecar = matter.stringify("\n# Helios\n\nBody.\n", {
      type: "pricing",
      title: "Helios",
      daftari: {
        title: "Helios",
        domain: "accumulation",
        collection: "pricing",
        status: "canonical",
        confidence: "high",
        created: "2026-01-20",
        updated: "2026-05-10",
        updated_by: "human:me",
        provenance: "direct",
        sources: ["helios-page"],
        superseded_by: null,
        ttl_days: 45,
        tags: ["helios"],
      },
    });
    writeDoc(bundle, "pricing/helios.md", withSidecar);

    const result = await importBundle(bundle, vault, { today: "2026-07-13" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan[0].roundTrip).toBe(true);

    const doc = matter(readFileSync(join(vault, "pricing/helios.md"), "utf-8"));
    expect(doc.data.status).toBe("canonical"); // from the sidecar, not synthesized
    expect(doc.data.confidence).toBe("high");
    expect(doc.data.updated_by).toBe("human:me");
    expect(doc.data.ttl_days).toBe(45);
    // The synthesized default (draft/medium) did NOT apply.
    expect(doc.data.status).not.toBe("draft");
  });
});
