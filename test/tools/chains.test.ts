import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { STATE_READ_TOOLS } from "../../src/federation/classification.js";
import { reindexVault } from "../../src/search/reindex.js";
import { CORE_TOOLS, STANDARD_TOOLS } from "../../src/server.js";
import { chainsTools, vaultChains } from "../../src/tools/chains.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const tool = chainsTools.find((t) => t.name === "vault_chains");
if (!tool) throw new Error("vault_chains is not registered");

function writeDoc(
  vault: string,
  relPath: string,
  supersededBy: string | null,
  status = "canonical",
): void {
  const abs = join(vault, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    [
      "---",
      `title: "${relPath}"`,
      "domain: accumulation",
      `collection: ${relPath.split("/")[0]}`,
      `status: ${status}`,
      "confidence: medium",
      "created: 2026-10-01",
      "updated: 2026-10-02",
      "updated_by: agent:test",
      "provenance: direct",
      "sources: []",
      `superseded_by: ${supersededBy === null ? "null" : `"${supersededBy}"`}`,
      "ttl_days: null",
      "tags: []",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("vault_chains", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  async function chainsFor(args: Record<string, unknown>, access?: AccessContext) {
    const indexed = await reindexVault(vault);
    if (!indexed.ok) throw indexed.error;
    const result = await vaultChains(vault, args, access);
    if (!result.ok) throw result.error;
    return result.value;
  }

  it("is a read-only tool outside the core and standard tiers", () => {
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(CORE_TOOLS).not.toContain("vault_chains");
    expect(STANDARD_TOOLS).not.toContain("vault_chains");
  });

  it("does not cross federation mounts", () => {
    expect(STATE_READ_TOOLS.has("vault_chains")).toBe(true);
  });

  it("returns every chain end in one call, walked through the real index", async () => {
    writeDoc(vault, "topic/v1.md", "topic/v2.md", "superseded");
    writeDoc(vault, "topic/v2.md", "topic/v3.md", "superseded");
    writeDoc(vault, "topic/v3.md", null);

    const value = await chainsFor({});
    const chain = value.chains.find((c) => c.head?.path === "topic/v3.md");
    expect(chain).toEqual({
      head: { path: "topic/v3.md", status: "canonical", updated: "2026-10-02" },
      replaced: [
        { path: "topic/v2.md", status: "superseded", updated: "2026-10-02", depth: 1 },
        { path: "topic/v1.md", status: "superseded", updated: "2026-10-02", depth: 2 },
      ],
      hidden_replaced: "none",
      flags: [],
    });
    expect(value.count).toBe(value.chains.length);
  });

  it("flags a loop and a draft end in the same call", async () => {
    writeDoc(vault, "topic/x.md", "topic/y.md");
    writeDoc(vault, "topic/y.md", "topic/x.md");
    writeDoc(vault, "topic/old.md", "topic/next.md");
    writeDoc(vault, "topic/next.md", null, "draft");

    const { chains } = await chainsFor({});
    expect(chains.find((c) => c.head === null)?.flags).toEqual(["loop"]);
    expect(chains.find((c) => c.head?.path === "topic/next.md")?.flags).toEqual(["draft"]);
  });

  it("narrows to flagged chains on request", async () => {
    writeDoc(vault, "topic/fine-old.md", "topic/fine-new.md");
    writeDoc(vault, "topic/fine-new.md", null);
    writeDoc(vault, "topic/bad-old.md", "topic/bad-new.md");
    writeDoc(vault, "topic/bad-new.md", null, "draft");

    const { chains, count } = await chainsFor({ flagged_only: true });
    expect(chains.map((c) => c.head?.path)).toContain("topic/bad-new.md");
    expect(chains.map((c) => c.head?.path)).not.toContain("topic/fine-new.md");
    expect(chains.every((c) => c.flags.length > 0)).toBe(true);
    expect(count).toBe(chains.length);
  });

  it("rejects a non-boolean flagged_only", async () => {
    const result = await vaultChains(vault, { flagged_only: "yes" });
    expect(result.ok).toBe(false);
  });

  it("projects chains through the caller's read scope", async () => {
    writeDoc(vault, "topic/old.md", "secret/new.md");
    writeDoc(vault, "secret/new.md", null, "draft");

    const access: AccessContext = {
      user: "a",
      roleName: "analyst",
      role: { read: ["topic"], write: [], promote: false, ratify: false },
    };
    const value = await chainsFor({}, access);
    const serialized = JSON.stringify(value);
    expect(value.chains).toHaveLength(1);
    expect(value.chains[0]?.flags).toEqual(["restricted"]);
    expect(serialized).not.toContain("secret/new.md");
    expect(serialized).not.toContain("draft");
  });

  it("denies a role with no read access", async () => {
    const guest: AccessContext = { user: "guest", roleName: "guest", role: null };
    const result = await vaultChains(vault, {}, guest);
    expect(result.ok).toBe(false);
  });

  it("summarizes chains, replaced documents, and flagged chains", () => {
    const line = tool.summarize?.(
      {
        count: 2,
        chains: [
          {
            head: { path: "a.md", status: "canonical", updated: "2026-10-02" },
            replaced: [
              { path: "b.md", status: "superseded", updated: "2026-10-02", depth: 1 },
              { path: "c.md", status: "superseded", updated: "2026-10-02", depth: 2 },
            ],
            hidden_replaced: "none",
            flags: [],
          },
          { head: null, replaced: [], hidden_replaced: "none", flags: ["loop"] },
        ],
      },
      vault,
    );
    expect(line).toBe("2 chains replacing 2 documents, 1 flagged");
  });

  it("links every path the result names", () => {
    const links = tool.docLinks?.({
      count: 1,
      chains: [
        {
          head: { path: "a.md", status: "canonical", updated: "2026-10-02" },
          replaced: [{ path: "b.md", status: "superseded", updated: "2026-10-02", depth: 1 }],
          hidden_replaced: "none",
          flags: [],
        },
      ],
    });
    expect(links).toEqual(["a.md", "b.md"]);
  });
});
