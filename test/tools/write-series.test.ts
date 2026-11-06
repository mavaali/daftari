// `series` through the real write path (#645): set on create, and kept when a
// later write does not mention it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";
import { vaultPromote, vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";
const PATH = "pricing/weekly-2026-05-01.md";

function snapshot(): Record<string, unknown> {
  return {
    title: "Weekly review",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    updated: "2026-05-01",
    updated_by: "agent:seed",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 14,
    tags: [],
    series: "weekly-review",
  };
}

function seriesOnDisk(vault: string): unknown {
  const parsed = parseDocument(readFileSync(join(vault, PATH), "utf-8"));
  expect(parsed.ok).toBe(true);
  return parsed.ok ? parsed.value.frontmatter.series : undefined;
}

describe("vault_write — series", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("persists series on create", async () => {
    const r = await vaultWrite(vault, {
      path: PATH,
      body: "# Weekly\n",
      frontmatter: snapshot(),
      agent: AGENT,
    });
    expect(r.ok).toBe(true);
    expect(seriesOnDisk(vault)).toBe("weekly-review");
  });

  it("survives a later frontmatter write", async () => {
    const created = await vaultWrite(vault, {
      path: PATH,
      body: "# Weekly\n",
      frontmatter: snapshot(),
      agent: AGENT,
    });
    expect(created.ok).toBe(true);
    const promoted = await vaultPromote(vault, { path: PATH, status: "canonical", agent: AGENT });
    expect(promoted.ok).toBe(true);
    expect(seriesOnDisk(vault)).toBe("weekly-review");
  });
});
