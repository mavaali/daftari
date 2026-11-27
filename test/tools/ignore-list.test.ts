// #646 acceptance: with `README.md` and `Clippings/**` ignored, neither appears
// in status, lint or search; a root file is never a collection; write tools
// refuse an ignored path rather than commit a file nothing can see.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { runLint } from "../../src/curation/lint.js";
import { indexDocument, isIndexFresh, reindexVault } from "../../src/search/reindex.js";
import { getProvider } from "../../src/search/vector.js";
import { allDocumentPaths, openIndexDb } from "../../src/storage/index-db.js";
import { vaultIndex, vaultRead, vaultStatus } from "../../src/tools/read.js";
import { vaultSearch } from "../../src/tools/search.js";
import { vaultMerge, vaultSupersede, vaultWrite } from "../../src/tools/write.js";
import { clearConfigCache } from "../../src/utils/config.js";

const AGENT = "agent:test";
const IGNORE = "ignore:\n  - README.md\n  - Clippings/**\n";

function document(title: string, collection: string): string {
  return [
    "---",
    `title: ${title}`,
    "domain: accumulation",
    `collection: ${collection}`,
    "status: draft",
    "confidence: high",
    "created: 2026-09-01",
    "updated: 2026-09-01",
    "updated_by: agent:test",
    "provenance: direct",
    "tags: []",
    "---",
    "",
    "Common needle in the body.",
    "",
  ].join("\n");
}

const ROOT_README = "# Vault readme\n\nCommon needle in the readme.\n";
const CLIPPING = "Saved from the web. Common needle in the clipping.\n";

describe("vault ignore list (#646)", () => {
  let vault: string;

  function put(relPath: string, text: string): void {
    const abs = join(vault, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }

  function configure(yaml: string): void {
    put(".daftari/config.yaml", yaml);
    clearConfigCache();
  }

  async function reindex(): Promise<void> {
    const indexed = await reindexVault(vault);
    if (!indexed.ok) throw indexed.error;
  }

  async function searchPaths(): Promise<string[]> {
    const result = await vaultSearch(vault, { query: "needle" });
    if (!result.ok) throw result.error;
    return result.value.hits.map((hit) => hit.path);
  }

  function indexedPaths(): string[] {
    const db = openIndexDb(vault, getProvider().dim);
    if (!db.ok) throw db.error;
    try {
      return allDocumentPaths(db.value);
    } finally {
      db.value.close();
    }
  }

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-ignore-tools-"));
    put("README.md", ROOT_README);
    put("Clippings/article.md", CLIPPING);
    put("notes/a.md", document("Note A", "notes"));
    put("notes/b.md", document("Note B", "notes"));
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    rmSync(vault, { recursive: true, force: true });
  });

  describe("acceptance", () => {
    it("reports them everywhere when nothing is ignored", async () => {
      configure("roles: {}\n");
      await reindex();

      const lint = await runLint(vault);
      if (!lint.ok) throw lint.error;
      const invalid = lint.value.checks.schemaInvalid.map((f) => f.path);
      expect(invalid).toEqual(expect.arrayContaining(["README.md", "Clippings/article.md"]));
      expect(await searchPaths()).toEqual(
        expect.arrayContaining(["README.md", "Clippings/article.md"]),
      );
    }, 60_000);

    it("removes them from status, lint and search when ignored", async () => {
      configure(IGNORE);
      await reindex();

      const status = await vaultStatus(vault);
      if (!status.ok) throw status.error;
      expect(status.value.fileCount).toBe(2);
      expect(status.value.collections).toEqual([{ collection: "notes", count: 2 }]);
      expect(status.value.invalidCount).toBe(0);

      const lint = await runLint(vault);
      if (!lint.ok) throw lint.error;
      for (const findings of Object.values(lint.value.checks)) {
        const paths = JSON.stringify(findings);
        expect(paths).not.toContain("README.md");
        expect(paths).not.toContain("Clippings/");
      }

      const hits = await searchPaths();
      expect(hits.sort()).toEqual(["notes/a.md", "notes/b.md"]);
      expect(indexedPaths()).toEqual(["notes/a.md", "notes/b.md"]);
    }, 60_000);

    it("keeps them out of vault_index and leaves them readable by path", async () => {
      configure(IGNORE);
      await reindex();

      const index = await vaultIndex(vault);
      if (!index.ok) throw index.error;
      expect(index.value.entries.map((e) => e.path)).toEqual(["notes/a.md", "notes/b.md"]);

      const read = await vaultRead(vault, "README.md");
      expect(read.ok).toBe(true);
    }, 60_000);
  });

  describe("index convergence", () => {
    it("marks the index stale when the list changes, and a reindex drops the rows", async () => {
      configure("roles: {}\n");
      await reindex();
      expect(await isIndexFresh(vault)).toBe(true);

      configure(IGNORE);
      expect(await isIndexFresh(vault)).toBe(false);

      await reindex();
      expect(await isIndexFresh(vault)).toBe(true);
      expect(indexedPaths()).toEqual(["notes/a.md", "notes/b.md"]);
    }, 60_000);

    it("indexDocument evicts a path the list newly covers", async () => {
      configure("roles: {}\n");
      await reindex();
      expect(indexedPaths()).toContain("Clippings/article.md");

      configure("ignore:\n  - Clippings\n");
      const result = await indexDocument(vault, "Clippings/article.md");
      expect(result.ok && result.value.chunkCount).toBe(0);
      expect(indexedPaths()).not.toContain("Clippings/article.md");
      expect(await searchPaths()).not.toContain("Clippings/article.md");
    }, 60_000);
  });

  describe("write tools", () => {
    const fields = {
      title: "Clip",
      domain: "accumulation",
      status: "draft",
      confidence: "high",
      created: "2026-09-01",
      updated: "2026-09-01",
      updated_by: AGENT,
      provenance: "direct",
      tags: [],
    };

    beforeEach(async () => {
      configure(IGNORE);
      await reindex();
    }, 60_000);

    it("vault_write refuses an ignored path before touching disk", async () => {
      const result = await vaultWrite(vault, {
        path: "Clippings/new.md",
        agent: AGENT,
        frontmatter: { ...fields, collection: "Clippings" },
        body: "New text.\n",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/'ignore' config/);
      expect((await vaultRead(vault, "Clippings/new.md")).ok).toBe(false);
    });

    it("vault_write still lands everywhere else", async () => {
      const result = await vaultWrite(vault, {
        path: "notes/new.md",
        agent: AGENT,
        frontmatter: { ...fields, collection: "notes" },
        body: "New text.\n",
      });
      expect(result.ok).toBe(true);
    }, 60_000);

    it("vault_supersede refuses an ignored successor, leaving the old doc alone", async () => {
      const result = await vaultSupersede(vault, {
        old_path: "notes/a.md",
        new_path: "Clippings/article.md",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/'ignore' config/);
      const old = await vaultRead(vault, "notes/a.md");
      expect(old.ok && old.value.frontmatter.status).toBe("draft");
    });

    it("vault_merge refuses when any of its three paths is ignored", async () => {
      const intoIgnored = await vaultMerge(vault, {
        path_a: "notes/a.md",
        path_b: "notes/b.md",
        target_path: "Clippings/merged.md",
        body: "Merged.\n",
        agent: AGENT,
      });
      expect(intoIgnored.ok).toBe(false);
      if (!intoIgnored.ok) expect(intoIgnored.error.message).toMatch(/'ignore' config/);

      const fromIgnored = await vaultMerge(vault, {
        path_a: "notes/a.md",
        path_b: "Clippings/article.md",
        target_path: "notes/merged.md",
        body: "Merged.\n",
        agent: AGENT,
      });
      expect(fromIgnored.ok).toBe(false);
      if (!fromIgnored.ok) expect(fromIgnored.error.message).toMatch(/'ignore' config/);
    });
  });

  describe("a root file is never a collection", () => {
    const wildcard: AccessContext = {
      user: AGENT,
      roleName: "admin",
      role: { read: ["*"], write: ["*"], promote: true, ratify: true },
    };
    const scoped: AccessContext = {
      user: AGENT,
      roleName: "reader",
      role: { read: ["notes"], write: [], promote: false, ratify: false },
    };
    const filenameGrant: AccessContext = {
      user: AGENT,
      roleName: "odd",
      role: { read: ["README.md"], write: [], promote: false, ratify: false },
    };

    it("leaves it out of collections but keeps it in fileCount", async () => {
      configure("roles: {}\n");
      const status = await vaultStatus(vault);
      if (!status.ok) throw status.error;
      expect(status.value.fileCount).toBe(4);
      expect(status.value.collections.map((c) => c.collection)).toEqual(["Clippings", "notes"]);
      expect(status.value.collections.map((c) => c.collection)).not.toContain("README.md");
    });

    it("honours a collection the root file declares itself", async () => {
      configure("roles: {}\n");
      put("root-note.md", document("Root note", "notes"));
      const status = await vaultStatus(vault);
      if (!status.ok) throw status.error;
      expect(status.value.collections).toContainEqual({ collection: "notes", count: 3 });
    });

    it("stores no collection for it in the index", async () => {
      configure("roles: {}\n");
      await reindex();
      const db = openIndexDb(vault, getProvider().dim);
      if (!db.ok) throw db.error;
      try {
        const row = db.value
          .prepare("SELECT collection FROM documents WHERE path = ?")
          .get("README.md") as { collection: string };
        expect(row.collection).toBe("");
      } finally {
        db.value.close();
      }
    }, 60_000);

    it("is readable by wildcard roles only", async () => {
      configure("roles: {}\n");
      expect((await vaultRead(vault, "README.md", wildcard)).ok).toBe(true);
      expect((await vaultRead(vault, "README.md", scoped)).ok).toBe(false);
      // A filename in a role's read list was never a real collection grant.
      expect((await vaultRead(vault, "README.md", filenameGrant)).ok).toBe(false);
    });

    it("does not surface to a scoped role through status or search", async () => {
      configure("roles: {}\n");
      await reindex();
      const status = await vaultStatus(vault, scoped);
      if (!status.ok) throw status.error;
      expect(status.value.fileCount).toBe(2);
      const result = await vaultSearch(vault, { query: "needle" }, scoped);
      if (!result.ok) throw result.error;
      expect(result.value.hits.map((hit) => hit.path)).not.toContain("README.md");
    }, 60_000);
  });
});
