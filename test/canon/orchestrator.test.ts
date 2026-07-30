// Orchestrator integration test: RBAC blind-spot flag.
//
// Verifies that when an access context can read collection "open" but NOT
// "secret", a tension between open/a.md and secret/b.md is hidden from the
// resolved canon — the tension is not contested — but the partial_visibility
// flag is true and hidden_tension_count is 1.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { computeCanon } from "../../src/canon/index.js";
import { addTension } from "../../src/curation/tension.js";
import type { RoleConfig } from "../../src/utils/config.js";

function makeDoc(collection: string, name: string, updatedBy: string, vaultRoot: string): void {
  const dir = join(vaultRoot, collection);
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `title: ${name}`,
    `collection: ${collection}`,
    "status: canonical",
    "confidence: high",
    "provenance: primary",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    `updated_by: ${updatedBy}`,
    "valid_from: 2026-01-01",
    "sources: []",
    "---",
    "",
    `Body of ${name}.`,
  ].join("\n");
  writeFileSync(join(dir, `${name}.md`), fm, "utf-8");
}

describe("computeCanon — RBAC blind-spot flag", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-canon-orch-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("sets partial_visibility=true and hidden_tension_count=1 when one tension side is unreadable", async () => {
    // Create two docs in different collections.
    makeDoc("open", "a", "human:alice", vault);
    makeDoc("secret", "b", "human:bob", vault);

    // Log a tension between them.
    const tensionRes = await addTension(vault, {
      title: "Open vs Secret conflict",
      kind: "factual",
      sourceA: "open/a.md",
      claimA: "open claim",
      sourceB: "secret/b.md",
      claimB: "secret claim",
      loggedBy: "test",
    });
    expect(tensionRes.ok).toBe(true);

    // Construct an AccessContext whose role can read "open" but NOT "secret".
    const restrictedRole: RoleConfig = {
      read: ["open"],
      write: [],
      promote: false,
      ratify: false,
    };
    const access: AccessContext = {
      user: "test-user",
      roleName: "restricted",
      role: restrictedRole,
    };

    const result = await computeCanon(vault, { seed: "open/a.md", asOf: "2026-07-01" }, access);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { settled, contested, flags } = result.value;

    // open/a.md should be settled (not contested — the tension partner is hidden).
    expect(contested).toHaveLength(0);
    const paths = settled.flatMap((s) => s.citations);
    expect(paths).toContain("open/a.md");

    // The blind-spot flags must be set.
    expect(flags.partial_visibility).toBe(true);
    expect(flags.hidden_tension_count).toBe(1);
  });
});
