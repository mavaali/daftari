import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readReadLog, readsForRun, recordRead, recordReads } from "../../src/curation/read-log.js";

describe("read log (#233)", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-readlog-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("returns an empty log when nothing has been recorded", async () => {
    const log = await readReadLog(vault);
    expect(log.ok && log.value).toEqual([]);
  });

  it("appends entries and reads them back in order, timestamp stamped", async () => {
    const first = await recordRead(vault, {
      tool: "vault_read",
      file: "pricing/a.md",
      run_id: "run-1",
      principal: "agent:alpha",
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.timestamp).toBeTruthy();

    await recordRead(vault, { tool: "vault_read", file: "pricing/b.md", run_id: "run-1" });

    const log = await readReadLog(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value.map((e) => e.file)).toEqual(["pricing/a.md", "pricing/b.md"]);
    expect(log.value[0]?.principal).toBe("agent:alpha");
    expect(log.value[1]?.principal).toBeUndefined();
  });

  it("serve entries without a run_id are kept, with broken_upstream intact (#234)", async () => {
    await recordRead(vault, { tool: "vault_read", file: "pricing/a.md", broken_upstream: 2 });
    await recordRead(vault, { tool: "vault_search", file: "pricing/b.md", broken_upstream: 0 });

    const log = await readReadLog(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value).toHaveLength(2);
    expect(log.value[0]?.run_id).toBeUndefined();
    expect(log.value[0]?.broken_upstream).toBe(2);
    expect(log.value[1]?.tool).toBe("vault_search");
    // A run-scoped join never picks up run-less serves.
    expect(readsForRun(log.value, "run-1")).toEqual([]);
  });

  it("recordReads appends a whole batch in one call (#234 search serves)", async () => {
    const batch = await recordReads(vault, [
      { tool: "vault_search", file: "pricing/a.md", broken_upstream: 1 },
      { tool: "vault_search", file: "pricing/b.md", broken_upstream: 0, principal: "h:x" },
    ]);
    expect(batch.ok).toBe(true);
    const emptyBatch = await recordReads(vault, []);
    expect(emptyBatch.ok && emptyBatch.value).toEqual([]);

    const log = await readReadLog(vault);
    if (!log.ok) throw log.error;
    expect(log.value.map((e) => [e.file, e.broken_upstream])).toEqual([
      ["pricing/a.md", 1],
      ["pricing/b.md", 0],
    ]);
    expect(log.value[1]?.principal).toBe("h:x");
  });

  it("readsForRun returns unique paths for one run, first-read order", async () => {
    await recordRead(vault, { tool: "vault_read", file: "pricing/a.md", run_id: "run-1" });
    await recordRead(vault, { tool: "vault_read", file: "pricing/b.md", run_id: "run-1" });
    await recordRead(vault, { tool: "vault_read", file: "pricing/a.md", run_id: "run-1" });
    await recordRead(vault, { tool: "vault_read", file: "pricing/c.md", run_id: "run-2" });

    const log = await readReadLog(vault);
    if (!log.ok) throw log.error;
    expect(readsForRun(log.value, "run-1")).toEqual(["pricing/a.md", "pricing/b.md"]);
    expect(readsForRun(log.value, "run-2")).toEqual(["pricing/c.md"]);
    expect(readsForRun(log.value, "run-3")).toEqual([]);
  });
});
