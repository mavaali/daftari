import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/utils/config.js";

function vaultWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cfg-ge-"));
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  writeFileSync(join(dir, ".daftari", "config.yaml"), yaml);
  return dir;
}

describe("search.graph_expand config", () => {
  it("defaults to disabled with sane defaults when absent", () => {
    const res = loadConfig(vaultWith("roles: {}\n"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.search.graphExpand).toEqual({
      enabled: false,
      cap: 10,
      tau: 0.3,
      subset: "trigger",
    });
  });

  it("parses an explicit block", () => {
    const res = loadConfig(
      vaultWith(
        "search:\n  graph_expand:\n    enabled: true\n    cap: 6\n    tau: 0.45\n    subset: all\n",
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.search.graphExpand).toEqual({
      enabled: true,
      cap: 6,
      tau: 0.45,
      subset: "all",
    });
  });

  it("rejects a malformed subset", () => {
    const res = loadConfig(vaultWith("search:\n  graph_expand:\n    subset: sideways\n"));
    expect(res.ok).toBe(false);
  });
});
