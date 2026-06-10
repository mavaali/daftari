// test/audit/semantic-tension.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SemanticFinding } from "../../src/audit/semantic.js";
import { logSemanticTensions } from "../../src/audit/semantic.js";
import { listTensions } from "../../src/curation/tension.js";

const finding = (over: Partial<SemanticFinding>): SemanticFinding => ({
  source: { repo: "docs", path: "a.md" },
  target: { repo: "svc", path: "src/login.ts", symbol: null },
  raw: "svc:src/login.ts",
  verdict: "drifted",
  contradictions: ["doc says email+password, code takes a token"],
  ...over,
});

describe("logSemanticTensions", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-sem-tension-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("logs a tension only for drifted and contradicted verdicts", async () => {
    const findings = [
      finding({ verdict: "coherent", contradictions: [] }),
      finding({ verdict: "drifted" }),
      finding({ verdict: "contradicted", target: { repo: "svc", path: "src/x.ts", symbol: null } }),
      finding({ verdict: "skipped", contradictions: [], reason: "binary" }),
    ];
    const result = await logSemanticTensions(findings, vault, "agent:daftari-audit");
    expect(result.logged).toBe(2);

    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    expect(tensions.value).toHaveLength(2);
    const t = tensions.value[0];
    expect(t?.kind).toBe("factual");
    expect(t?.sourceA).toBe("a.md");
    expect(t?.sourceB).toBe("svc/src/login.ts");
    expect(t?.loggedBy).toBe("agent:daftari-audit");
  });

  it("logs nothing when no finding drifted", async () => {
    const result = await logSemanticTensions(
      [finding({ verdict: "coherent", contradictions: [] })],
      vault,
      "agent:daftari-audit",
    );
    expect(result.logged).toBe(0);
    const tensions = await listTensions(vault);
    expect(tensions.ok && tensions.value).toEqual([]);
  });
});
