import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan } from "../../src/backfill/apply.js";
import { generatePlan } from "../../src/backfill/plan.js";
import { parseDocument } from "../../src/frontmatter/parser.js";
import { validateFrontmatter } from "../../src/frontmatter/schema.js";
import { loadConfig } from "../../src/utils/config.js";
import { log } from "../../src/utils/git.js";
import { buildFrontmatterLessVault, cleanupVault } from "../helpers/frontmatter-less-vault.js";

describe("applyPlan", () => {
  let vault: string;
  let identityMap: Record<string, string>;

  beforeEach(async () => {
    vault = buildFrontmatterLessVault();
    const config = loadConfig(vault);
    if (!config.ok) throw config.error;
    identityMap = config.value.backfillIdentityMap;
    const plan = await generatePlan(vault, { identityMap, invoker: "human:migrator" });
    if (!plan.ok) throw plan.error;
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("writes only docs under the given scope", async () => {
    const result = await applyPlan(vault, "notes", "human:migrator");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.applied).toEqual(["notes/orphan.md"]);
    expect(result.value.commit).not.toBeNull();

    // specs docs untouched.
    const foo = readFileSync(join(vault, "specs/data-movement/foo.md"), "utf-8");
    expect(foo.startsWith("---")).toBe(false);
  });

  it("produces frontmatter that passes the validator", async () => {
    const result = await applyPlan(vault, "specs", "human:migrator");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied.sort()).toEqual([
      "specs/data-movement/bar.md",
      "specs/data-movement/foo.md",
      "specs/pricing/baz.md",
    ]);

    for (const rel of result.value.applied) {
      const text = readFileSync(join(vault, rel), "utf-8");
      const parsed = parseDocument(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const { report } = validateFrontmatter(parsed.value.raw);
      expect(report.valid).toBe(true);
    }
  });

  it("preserves the body and present frontmatter fields on apply", async () => {
    await applyPlan(vault, "specs", "human:migrator");
    const text = readFileSync(join(vault, "specs/pricing/baz.md"), "utf-8");
    const parsed = parseDocument(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frontmatter.title).toBe("Existing Baz Title");
    expect(parsed.value.frontmatter.created).toBe("2024-12-01");
    expect(parsed.value.content).toContain("Pricing content.");
  });

  it("commits under the scope with a backfill message authored by the agent", async () => {
    await applyPlan(vault, "notes", "human:migrator");
    const history = await log(vault, { limit: 1 });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value[0]?.subject).toBe(
      "vault_backfill: notes — 1 doc frontmatter backfilled by human:migrator",
    );
    expect(history.value[0]?.author).toBe("human:migrator");
  });

  it("is a no-op when re-applied to an already-applied folder", async () => {
    const first = await applyPlan(vault, "notes", "human:migrator");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.applied).toHaveLength(1);

    const second = await applyPlan(vault, "notes", "human:migrator");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.applied).toHaveLength(0);
    expect(second.value.unchanged).toEqual(["notes/orphan.md"]);
    expect(second.value.commit).toBeNull();
  });

  it("after apply, a fresh plan reports the folder conformant", async () => {
    await applyPlan(vault, "notes", "human:migrator");
    const replan = await generatePlan(vault, {
      scope: "notes",
      identityMap,
      invoker: "human:migrator",
    });
    expect(replan.ok).toBe(true);
    if (!replan.ok) return;
    expect(replan.value.summary.planned).toBe(0);
    expect(replan.value.summary.conformant).toBe(1);
  });

  it("skips a colliding doc with a rename-guidance reason, preserving its value", async () => {
    writeFileSync(
      join(vault, "specs/data-movement/decision.md"),
      "---\nstatus: ACTIVE\n---\n# Decision\n",
    );
    const plan = await generatePlan(vault, { identityMap, invoker: "human:migrator" });
    if (!plan.ok) throw plan.error;
    const result = await applyPlan(vault, "specs", "human:migrator");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const skip = result.value.skipped.find((s) => s.path === "specs/data-movement/decision.md");
    expect(skip).toBeDefined();
    expect(skip?.reason).toContain("collision");
    expect(skip?.reason).toContain("status");
    const text = readFileSync(join(vault, "specs/data-movement/decision.md"), "utf-8");
    expect(text).toContain("status: ACTIVE");
  });

  it("skips a non-collision invalid doc with the generic reason", async () => {
    writeFileSync(
      join(vault, "specs/data-movement/baddate.md"),
      "---\ncreated: not-a-date\n---\n# Bad\n",
    );
    const plan = await generatePlan(vault, { identityMap, invoker: "human:migrator" });
    if (!plan.ok) throw plan.error;
    const result = await applyPlan(vault, "specs", "human:migrator");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const skip = result.value.skipped.find((s) => s.path === "specs/data-movement/baddate.md");
    expect(skip?.reason).toContain("proposed frontmatter is invalid");
  });

  it("summarizes additional collisions with '(and N more)'", async () => {
    writeFileSync(
      join(vault, "specs/data-movement/multi.md"),
      "---\nstatus: ACTIVE\ndomain: Architecture\n---\n# Multi\n",
    );
    const plan = await generatePlan(vault, { identityMap, invoker: "human:migrator" });
    if (!plan.ok) throw plan.error;
    const result = await applyPlan(vault, "specs", "human:migrator");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const skip = result.value.skipped.find((s) => s.path === "specs/data-movement/multi.md");
    expect(skip?.reason).toContain("(and 1 more)");
  });
});
