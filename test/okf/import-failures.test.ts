import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err } from "../../src/frontmatter/types.js";
import { importBundle } from "../../src/okf/import.js";
import { runOkf } from "../../src/okf/index.js";
import { reindexVault } from "../../src/search/reindex.js";
import * as git from "../../src/utils/git.js";

vi.mock("../../src/search/reindex.js", () => ({ reindexVault: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: vi.fn(original.writeFile) };
});

describe("OKF import failure reporting and recovery", () => {
  let bundle: string;
  let vault: string;

  beforeEach(() => {
    vi.mocked(fs.writeFile).mockReset();
    bundle = mkdtempSync(join(tmpdir(), "okf-failure-bundle-"));
    vault = mkdtempSync(join(tmpdir(), "okf-failure-vault-"));
    writeFileSync(join(bundle, "a.md"), "---\ntype: Note\ntitle: A\n---\nBody.\n");
    vi.mocked(reindexVault).mockReset();
    vi.mocked(reindexVault).mockResolvedValue({
      ok: true,
      value: {
        documentCount: 1,
        chunkCount: 1,
        vectorEnabled: false,
        skipped: [],
        invalidFrontmatter: [],
        indexedAt: new Date().toISOString(),
        embeddedCount: 0,
        cacheHits: 0,
        orphansRemoved: 0,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(bundle, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  });

  it("reports a commit failure and retries it when bytes already match", async () => {
    const commit = vi
      .spyOn(git, "commit")
      .mockResolvedValueOnce(err(new Error("commit unavailable")));
    const failed = await importBundle(bundle, vault);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain("written but commit failed");
    expect(reindexVault).not.toHaveBeenCalled();
    expect(readFileSync(join(vault, "a.md"), "utf8")).toContain("Body.");
    const retry = await importBundle(bundle, vault);
    expect(retry.ok && retry.value.commit).toBeTruthy();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(reindexVault).toHaveBeenCalledTimes(1);
  });

  it("reports reindex failure after commit, then retries indexing without another commit", async () => {
    const commit = vi.spyOn(git, "commit");
    vi.mocked(reindexVault).mockResolvedValueOnce(err(new Error("index unavailable")));
    const failed = await importBundle(bundle, vault);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain("but reindex failed");
    const retry = await importBundle(bundle, vault);
    expect(retry.ok && retry.value.reindexed).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(reindexVault).toHaveBeenCalledTimes(2);
  });

  it("returns a Result for a mid-batch write failure and reports partial mutation", async () => {
    writeFileSync(join(bundle, "b.md"), "---\ntype: Note\ntitle: B\n---\nBody B.\n");
    const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"))
      .writeFile;
    vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
      if (args[0] === join(vault, "b.md")) throw new Error("disk full");
      return original(...args);
    });
    const commit = vi.spyOn(git, "commit");
    const failed = await importBundle(bundle, vault);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain("after 1 document(s) written");
    expect(commit).not.toHaveBeenCalled();
    expect(reindexVault).not.toHaveBeenCalled();
  });

  it("returns a Result when an indexing dependency throws", async () => {
    vi.mocked(reindexVault).mockRejectedValueOnce(new Error("unexpected index failure"));
    const failed = await importBundle(bundle, vault);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain("reindex failed");
  });

  it("does not report success when reindex skips an imported document", async () => {
    vi.mocked(reindexVault).mockResolvedValueOnce({
      ok: true,
      value: {
        documentCount: 0,
        chunkCount: 0,
        vectorEnabled: false,
        skipped: [{ path: "a.md", reason: "unreadable" }],
        invalidFrontmatter: [],
        indexedAt: new Date().toISOString(),
        embeddedCount: 0,
        cacheHits: 0,
        orphansRemoved: 0,
      },
    });
    const failed = await importBundle(bundle, vault);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain("reindex skipped imported documents");
  });

  it("returns a nonzero CLI status without printing success after commit failure", async () => {
    vi.spyOn(git, "commit").mockResolvedValueOnce(err(new Error("commit unavailable")));
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runOkf(["import", bundle, "--into", vault])).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("import incomplete"));
  });
});
