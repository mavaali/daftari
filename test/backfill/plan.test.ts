import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePlan, planPath, readPlan, scopeOf } from "../../src/backfill/plan.js";
import { loadConfig } from "../../src/utils/config.js";
import { buildFrontmatterLessVault, cleanupVault } from "../helpers/frontmatter-less-vault.js";

describe("scopeOf", () => {
  it("returns the first path component, or '' for a root file", () => {
    expect(scopeOf("specs/data-movement/foo.md")).toBe("specs");
    expect(scopeOf("notes/orphan.md")).toBe("notes");
    expect(scopeOf("readme.md")).toBe("");
  });
});

describe("generatePlan", () => {
  let vault: string;
  let identityMap: Record<string, string>;

  beforeEach(() => {
    vault = buildFrontmatterLessVault();
    const config = loadConfig(vault);
    if (!config.ok) throw config.error;
    identityMap = config.value.backfillIdentityMap;
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("classifies docs and writes a plan over the whole vault", async () => {
    const result = await generatePlan(vault, { identityMap, invoker: "human:tester" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { summary } = result.value;
    // foo, bar, orphan have no frontmatter.
    expect(summary.missing).toBe(3);
    // baz has partial frontmatter.
    expect(summary.partial).toBe(1);
    // setup is fully conformant.
    expect(summary.conformant).toBe(1);
    // readme.md sits at the vault root — no collection folder.
    expect(summary.rootSkipped).toBe(1);
    expect(summary.planned).toBe(4);
    expect(summary.byScope).toEqual({ specs: 3, notes: 1 });

    // The plan file exists and round-trips.
    expect(existsSync(planPath(vault))).toBe(true);
    const back = await readPlan(planPath(vault));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toHaveLength(4);
  });

  it("derives created/updated/updated_by from git and preserves present fields", async () => {
    const result = await generatePlan(vault, { identityMap, invoker: "human:tester" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byPath = new Map(result.value.entries.map((e) => [e.path, e]));

    const foo = byPath.get("specs/data-movement/foo.md");
    expect(foo).toBeDefined();
    expect(foo?.proposed.created).toBe("2025-04-12"); // first add commit
    expect(foo?.proposed.updated).toBe("2025-05-01"); // last commit
    expect(foo?.proposed.updated_by).toBe("human:mihir"); // identity_map
    expect(foo?.proposed.collection).toBe("specs");
    expect(foo?.proposed.questions_answered).toEqual(["How does data move from A to B?"]);
    expect(foo?.proposed.questions_raised).toEqual(["Does it scale to 1M events/sec?"]);

    const bar = byPath.get("specs/data-movement/bar.md");
    expect(bar?.proposed.title).toBe("Bar"); // no H1 → filename
    expect(bar?.proposed.updated_by).toBe("human:priya"); // identity_map

    const orphan = byPath.get("notes/orphan.md");
    expect(orphan?.proposed.updated_by).toBe("human:sam-rivers"); // fallback

    const baz = byPath.get("specs/pricing/baz.md");
    expect(baz?.proposed.title).toBe("Existing Baz Title"); // preserved
    expect(baz?.proposed.created).toBe("2024-12-01"); // preserved, not git
    expect(baz?.derivation.title).toBe("preserved");
    expect(baz?.derivation.created).toBe("preserved");
    expect(baz?.proposed.updated).toBe("2025-02-10"); // filled from git
  });

  it("scopes the walk when given a scope", async () => {
    const result = await generatePlan(vault, {
      scope: "notes",
      identityMap,
      invoker: "human:tester",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.planned).toBe(1);
    expect(result.value.entries.map((e) => e.path)).toEqual(["notes/orphan.md"]);
  });

  it("attaches collisions to a doc that reuses a built-in field name", async () => {
    writeFileSync(
      join(vault, "specs/data-movement/decision.md"),
      "---\nstatus: ACTIVE\n---\n# Decision\n",
    );
    const result = await generatePlan(vault, { identityMap, invoker: "human:migrator" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.entries.find((e) => e.path === "specs/data-movement/decision.md");
    expect(entry?.collisions).toEqual([
      { field: "status", value: "ACTIVE", expected: expect.arrayContaining(["canonical"]) },
    ]);
  });

  it("is idempotent — re-running overwrites the plan cleanly", async () => {
    await generatePlan(vault, { identityMap, invoker: "human:tester" });
    const first = readFileSync(planPath(vault), "utf-8");
    await generatePlan(vault, { identityMap, invoker: "human:tester" });
    const second = readFileSync(planPath(vault), "utf-8");
    expect(second).toBe(first);
  });
});

describe("generatePlan on a fully conformant vault", () => {
  it("writes an empty plan", async () => {
    const vault = buildFrontmatterLessVault();
    try {
      // First pass + apply every scope makes the vault conformant; simpler:
      // restrict to the guides scope, which is already conformant.
      const result = await generatePlan(vault, {
        scope: "guides",
        identityMap: {},
        invoker: "human:tester",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.planned).toBe(0);
      expect(result.value.summary.conformant).toBe(1);
      expect(readFileSync(join(vault, ".daftari", "backfill-plan.jsonl"), "utf-8")).toBe("");
    } finally {
      cleanupVault(vault);
    }
  });
});

describe("readPlan", () => {
  it("errors when no plan exists", async () => {
    const vault = buildFrontmatterLessVault();
    try {
      const result = await readPlan(planPath(vault));
      expect(result.ok).toBe(false);
    } finally {
      cleanupVault(vault);
    }
  });
});
