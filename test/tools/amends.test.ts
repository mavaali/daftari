// #643: a later document declares `amends`, and the earlier document's readers
// see "amended by" through search and vault_read. The earlier file is never
// written — that is the point of declaring on the later side.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { LINT_CHECKS, runLint } from "../../src/curation/lint.js";
import { TIER0_LINT_CHECKS } from "../../src/curation/tier0.js";
import { reindexVault } from "../../src/search/reindex.js";
import { vaultRead } from "../../src/tools/read.js";
import { searchTools, vaultSearch } from "../../src/tools/search.js";
import { vaultSupersede, vaultWrite } from "../../src/tools/write.js";
import { clearConfigCache } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:test";
const A = "pricing/a.md";
const B = "pricing/b.md";
const QUERY = "quillfeather toggle";

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Doc",
    domain: "accumulation",
    collection: "pricing",
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

function reader(...collections: string[]): AccessContext {
  return {
    user: "u",
    roleName: "r",
    role: { read: collections, write: [], promote: false, ratify: false },
  };
}

function writer(read: string[], write: string[]): AccessContext {
  return {
    user: "u",
    roleName: "w",
    role: { read, write, promote: false, ratify: false },
  };
}

async function write(
  vault: string,
  path: string,
  body: string,
  fm: Record<string, unknown> = {},
  access?: AccessContext,
) {
  const res = await vaultWrite(
    vault,
    { path, body, frontmatter: frontmatter({ title: path, ...fm }), agent: AGENT },
    access,
  );
  if (!res.ok) throw res.error;
  return res.value;
}

async function hitFor(vault: string, path: string, access?: AccessContext) {
  const res = await vaultSearch(vault, { query: QUERY }, access);
  if (!res.ok) throw res.error;
  return { result: res.value, hit: res.value.hits.find((h) => h.path === path) };
}

describe("amends relation (#643)", () => {
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    await write(vault, A, "The quillfeather toggle stays off until re-enabled.\n");
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("acceptance: a search hit on the earlier entry names its amender, A untouched", async () => {
    const before = readFileSync(join(vault, A), "utf8");
    await write(vault, B, "Re-enabled the same day.\n", { amends: [A] });

    expect(readFileSync(join(vault, A), "utf8")).toBe(before);

    const { result, hit } = await hitFor(vault, A);
    expect(hit?.amendedBy).toMatchObject([
      { path: B, title: B, status: "draft", snippet: "Re-enabled the same day." },
    ]);
    expect(hit?.amendedByCount).toBe(1);

    const tool = searchTools.find((candidate) => candidate.name === "vault_search");
    const summary = tool?.summarize?.(result, vault) ?? "";
    const line = summary.split("\n").find((l) => l.includes(A));
    expect(line).toContain(`amended by: ${B}`);
    expect(summary).toContain("1 amended");
  });

  it("vault_read carries the same annotation without changing A's frontmatter", async () => {
    await write(vault, B, "Re-enabled the same day.\n", { amends: [A] });

    const res = await vaultRead(vault, A);
    if (!res.ok) throw res.error;
    expect(res.value.amendedBy).toMatchObject([{ path: B, status: "draft" }]);
    expect(res.value.amendedByCount).toBe(1);
    expect(res.value.frontmatter.amends ?? []).toEqual([]);
    expect(res.value.raw.amended_by).toBeUndefined();
  });

  it("the annotation is absent when nothing amends the document", async () => {
    const { hit } = await hitFor(vault, A);
    expect(hit).toBeDefined();
    expect(hit?.amendedBy).toBeUndefined();
    expect(hit?.amendedByCount).toBeUndefined();

    const res = await vaultRead(vault, A);
    if (!res.ok) throw res.error;
    expect(res.value).not.toHaveProperty("amendedBy");
  });

  it("the amender also shows its own declaration in frontmatter", async () => {
    await write(vault, B, "Re-enabled.\n", { amends: [A] });
    expect(readFileSync(join(vault, B), "utf8")).toMatch(/^amends:\n {2}- pricing\/a\.md$/m);
    const res = await vaultRead(vault, B);
    if (!res.ok) throw res.error;
    expect(res.value.frontmatter.amends).toEqual([A]);
  });

  it("a document that declares nothing stays byte-stable: no `amends:` key", async () => {
    expect(readFileSync(join(vault, A), "utf8")).not.toContain("amends");
  });

  it("is orthogonal to supersession: an amended hit keeps its currentSource and rank", async () => {
    await write(vault, B, "Re-enabled.\n", { amends: [A] });
    const amendedOnly = await hitFor(vault, A);
    expect(amendedOnly.hit?.currentSource).toBeUndefined();
    expect(amendedOnly.hit?.demoted).toBeUndefined();

    await write(vault, "pricing/c.md", "Replacement.\n");
    const superseded = await vaultSupersede(vault, {
      old_path: A,
      new_path: "pricing/c.md",
      agent: AGENT,
    });
    if (!superseded.ok) throw superseded.error;

    const both = await hitFor(vault, A);
    expect(both.hit?.currentSource).toMatchObject({ kind: "resolved", path: "pricing/c.md" });
    expect(both.hit?.amendedBy).toMatchObject([{ path: B }]);
  });

  it("reports a superseded amender's status rather than walking its chain", async () => {
    await write(vault, B, "Re-enabled.\n", { amends: [A] });
    await write(vault, "pricing/c.md", "Replacement.\n");
    const superseded = await vaultSupersede(vault, {
      old_path: B,
      new_path: "pricing/c.md",
      agent: AGENT,
    });
    if (!superseded.ok) throw superseded.error;

    const { hit } = await hitFor(vault, A);
    expect(hit?.amendedBy).toMatchObject([{ path: B, status: "superseded" }]);
  });

  it("an explicit null clears the declaration and the annotation", async () => {
    await write(vault, B, "Re-enabled.\n", { amends: [A] });
    await write(vault, B, "Re-enabled.\n", { amends: null });

    expect(readFileSync(join(vault, B), "utf8")).not.toContain("amends");
    const { hit } = await hitFor(vault, A);
    expect(hit?.amendedBy).toBeUndefined();
  });

  it("rejects a non-list `amends` at the write boundary", async () => {
    const res = await vaultWrite(vault, {
      path: B,
      body: "x\n",
      frontmatter: frontmatter({ amends: A }),
      agent: AGENT,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("amends");
  });

  it("survives a full rebuild: the markdown is the only source of truth", async () => {
    await write(vault, B, "Re-enabled.\n", { amends: [A] });
    const rebuilt = await reindexVault(vault);
    if (!rebuilt.ok) throw rebuilt.error;

    const res = await vaultRead(vault, A);
    if (!res.ok) throw res.error;
    expect(res.value.amendedBy).toMatchObject([{ path: B }]);
  });

  describe("write-time advisory", () => {
    it("is silent when every target resolves", async () => {
      const res = await write(vault, B, "Re-enabled.\n", { amends: [A] });
      expect(res.amends_warnings).toBeUndefined();
    });

    it("names a target that does not resolve; the write still lands", async () => {
      const res = await write(vault, B, "Re-enabled.\n", { amends: ["pricing/nope.md"] });
      expect(res.action).toBe("create");
      expect(res.amends_warnings).toHaveLength(1);
      expect(res.amends_warnings?.[0]).toContain("pricing/nope.md");
    });

    it("names a self-reference", async () => {
      const res = await write(vault, B, "Re-enabled.\n", { amends: [B] });
      expect(res.amends_warnings?.[0]).toContain(B);
    });

    // No existence oracle: a hidden document and an absent one read the same.
    it("words a hidden target exactly like an absent one", async () => {
      await write(vault, "secret/s.md", "Hidden.\n", { collection: "secret" });
      const access = writer(["pricing"], ["pricing"]);
      const hidden = await write(vault, B, "x\n", { amends: ["secret/s.md"] }, access);
      const absent = await write(vault, "pricing/d.md", "x\n", { amends: ["secret/t.md"] }, access);
      expect(hidden.amends_warnings?.[0]?.replace("secret/s.md", "P")).toBe(
        absent.amends_warnings?.[0]?.replace("secret/t.md", "P"),
      );
    });
  });

  describe("RBAC", () => {
    beforeEach(async () => {
      await write(vault, "secret/b.md", "Hidden amendment.\n", {
        collection: "secret",
        amends: [A],
      });
    });

    it("omits an unreadable amender from search: no entry, count or marker", async () => {
      const { hit } = await hitFor(vault, A, reader("pricing"));
      expect(hit).toBeDefined();
      expect(hit).not.toHaveProperty("amendedBy");
      expect(hit).not.toHaveProperty("amendedByCount");
    });

    it("omits an unreadable amender from vault_read, leaving nothing in the payload", async () => {
      const res = await vaultRead(vault, A, reader("pricing"));
      if (!res.ok) throw res.error;
      expect(JSON.stringify(res.value)).not.toContain("secret/b.md");
    });

    it("shows the amender to a role that can read both sides", async () => {
      const { hit } = await hitFor(vault, A, reader("pricing", "secret"));
      expect(hit?.amendedBy).toMatchObject([{ path: "secret/b.md" }]);
    });
  });

  describe("lint", () => {
    async function dangling(): Promise<string[]> {
      const res = await runLint(vault);
      if (!res.ok) throw res.error;
      return res.value.checks.danglingAmends.map((f) => `${f.path}: ${f.detail}`);
    }

    it("is advisory: registered, but not a tier-0 check that gates ratification", () => {
      expect(LINT_CHECKS).toContain("danglingAmends");
      expect(TIER0_LINT_CHECKS).not.toContain("danglingAmends");
    });

    it("is clean when the target exists", async () => {
      await write(vault, B, "x\n", { amends: [A] });
      expect(await dangling()).toEqual([]);
    });

    it("flags a target that names no document", async () => {
      await write(vault, B, "x\n", { amends: ["pricing/nope.md"] });
      const findings = await dangling();
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain(B);
      expect(findings[0]).toContain("pricing/nope.md");
    });

    it("flags a self-reference", async () => {
      await write(vault, B, "x\n", { amends: [B] });
      expect(await dangling()).toHaveLength(1);
    });

    it("does not count an amendment as an inbound link", async () => {
      await write(vault, B, "x\n", { amends: [A] });
      const res = await runLint(vault);
      if (!res.ok) throw res.error;
      expect(res.value.checks.orphanFiles.map((f) => f.path)).toContain(A);
    });
  });

  it("an amendment the file declares by hand is picked up by a reindex", async () => {
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(
      join(vault, "notes", "hand.md"),
      `---\ntitle: Hand\ndomain: accumulation\ncollection: notes\nstatus: draft\nconfidence: low\ncreated: 2026-07-01\nupdated: 2026-07-01\nupdated_by: human:h\nprovenance: direct\namends: [${A}]\n---\n\nBy hand.\n`,
    );
    clearConfigCache();
    const rebuilt = await reindexVault(vault);
    if (!rebuilt.ok) throw rebuilt.error;

    const res = await vaultRead(vault, A);
    if (!res.ok) throw res.error;
    expect(res.value.amendedBy).toMatchObject([{ path: "notes/hand.md", title: "Hand" }]);
  });
});
