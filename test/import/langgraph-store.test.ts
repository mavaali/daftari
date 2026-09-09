// Tests for the langgraph-store read adapter. The store side is exercised
// through the injected QueryRunner (no live Postgres needed); the vault side
// writes into a temp dir with a real git repo, mirroring how backfill's apply
// is tested.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyPlan,
  deriveNotes,
  type LanggraphImportOptions,
  prepareImportPlan,
  readStoreRows,
  renderPlan,
  type StoreRow,
  slugifyKey,
} from "../../src/import/langgraph-store.js";

function makeRow(overrides: Partial<StoreRow> = {}): StoreRow {
  return {
    prefix: "v1.pricing",
    key: "abc12345-dead-beef",
    value: {
      kind: "Memory",
      content: {
        content: "Pro tier is sold with a guaranteed 500 requests per second per workspace.",
      },
    },
    created_at: "2026-04-14 12:00:00+00",
    updated_at: "2026-04-14 12:00:00+00",
    ...overrides,
  };
}

function makeOpts(
  vaultRoot: string,
  overrides: Partial<LanggraphImportOptions> = {},
): LanggraphImportOptions {
  return {
    vaultRoot,
    dsn: "postgresql://daftari_ro:x@localhost:5433/memories",
    collection: "langgraph",
    agent: "agent:test-import",
    apply: false,
    yes: false,
    ...overrides,
  };
}

describe("deriveNotes", () => {
  it("derives one claim note per semantic memory with full store provenance", () => {
    const plan = deriveNotes([makeRow()], makeOpts("/tmp/nowhere"));
    expect(plan.notes).toHaveLength(1);
    const note = plan.notes[0];

    // provenance: the tension-graph node must trace back to the store row
    expect(note.sourceRef).toBe("langgraph-store:v1.pricing/abc12345-dead-beef");
    expect(note.session).toBe("pricing");
    expect(note.relPath).toMatch(/^langgraph\/pricing\/memory--[a-f0-9]{64}\.md$/);

    // frontmatter carries the metadata layer
    const fmText = note.body.split("---")[1];
    const fm = load(fmText) as Record<string, unknown>;
    expect(fm.collection).toBe("langgraph");
    expect(fm.status).toBe("draft");
    expect(fm.domain).toBe("accumulation");
    expect(fm.created).toBe("2026-04-14");
    expect(fm.sources).toEqual(["langgraph-store:v1.pricing/abc12345-dead-beef"]);
    expect(fm.tags).toEqual(["langgraph-import", "session:pricing"]);
    expect(fm.updated_by).toBe("agent:test-import");

    // body carries the claim text and a human-readable provenance section
    expect(note.body).toContain("guaranteed 500 requests per second");
    expect(note.body).toContain("## Provenance");
    expect(note.body).toContain("`v1.pricing`");
  });

  it("uses distinct, portable paths for full namespace and key identities", () => {
    const rows = [
      makeRow({ prefix: "org.team", key: "same1234-a" }),
      makeRow({ prefix: "org.team", key: "same1234-b" }),
      makeRow({ prefix: "other.team", key: "same1234-a" }),
      makeRow({ prefix: "org.team", key: "記憶/../一" }),
      makeRow({ prefix: "org.team", key: "記憶/../二" }),
    ];
    const notes = deriveNotes(rows, makeOpts("/tmp/nowhere")).notes;
    expect(new Set(notes.map((n) => n.relPath)).size).toBe(rows.length);
    for (const note of notes)
      expect(note.relPath).toMatch(/^langgraph\/team\/memory--[a-f0-9]{64}\.md$/);
  });

  it("keeps the same destination when source text changes", () => {
    const opts = makeOpts("/tmp/nowhere");
    const before = deriveNotes([makeRow()], opts).notes[0];
    const after = deriveNotes(
      [makeRow({ value: { content: "A completely revised claim." } })],
      opts,
    ).notes[0];
    expect(after.relPath).toBe(before.relPath);
  });

  it("skips episodic and procedural memories, counting them by kind", () => {
    const rows = [
      makeRow(),
      makeRow({ key: "ep1", value: { kind: "Episode", content: { content: "we talked" } } }),
      makeRow({ key: "pr1", value: { kind: "Procedural", content: { content: "always do X" } } }),
    ];
    const plan = deriveNotes(rows, makeOpts("/tmp/nowhere"));
    expect(plan.notes).toHaveLength(1);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { kind: "Episode", count: 1 },
        { kind: "Procedural", count: 1 },
      ]),
    );
  });

  it("skips rows with unrecognized shapes instead of guessing", () => {
    const rows = [makeRow({ key: "weird", value: { something: "else" } })];
    const plan = deriveNotes(rows, makeOpts("/tmp/nowhere"));
    expect(plan.notes).toHaveLength(0);
    expect(plan.skipped).toEqual([{ kind: "unknown", count: 1 }]);
  });

  it("accepts bare-string content values", () => {
    const rows = [makeRow({ value: { kind: "Memory", content: "plain string memory" } })];
    const plan = deriveNotes(rows, makeOpts("/tmp/nowhere"));
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0].body).toContain("plain string memory");
  });

  it("counts notes per namespace prefix for the plan summary", () => {
    const rows = [
      makeRow(),
      makeRow({ key: "k2", prefix: "v1.ops" }),
      makeRow({ key: "k3", prefix: "v1.ops" }),
    ];
    const plan = deriveNotes(rows, makeOpts("/tmp/nowhere"));
    expect(plan.byPrefix).toEqual({ "v1.pricing": 1, "v1.ops": 2 });
  });
});

describe("slugifyKey", () => {
  it("produces stable portable filenames", () => {
    expect(slugifyKey("Pro tier is sold with 500 req/s!")).toBe("pro-tier-is-sold-with-500-req-s");
    expect(slugifyKey("///")).toBe("memory");
  });
});

describe("readStoreRows", () => {
  it("filters by namespace prefix and its descendants, parameterized", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const runner = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [makeRow()];
    };
    const res = await readStoreRows(runner, "v1");
    expect(res.ok).toBe(true);
    expect(calls[0].sql).toContain("prefix = $1 OR prefix LIKE $2");
    expect(calls[0].params).toEqual(["v1", "v1.%"]);
  });

  it("reads everything when no namespace is given", async () => {
    const calls: { sql: string }[] = [];
    const runner = async (sql: string) => {
      calls.push({ sql });
      return [];
    };
    await readStoreRows(runner);
    expect(calls[0].sql).not.toContain("WHERE");
  });

  it("returns err instead of throwing when the query fails", async () => {
    const runner = async () => {
      throw new Error("permission denied for table store");
    };
    const res = await readStoreRows(runner);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("permission denied");
  });
});

describe("applyPlan", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeVault(): string {
    const dir = mkdtempSync(join(tmpdir(), "daftari-lg-import-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("writes notes and commits them in one commit authored by the agent", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault, { apply: true, yes: true, namespace: "v1" });
    const plan = deriveNotes([makeRow(), makeRow({ key: "k2", prefix: "v1.ops" })], opts);

    const res = await applyPlan(plan, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.written).toBe(2);
    expect(res.value.commit).toBeTruthy();

    // files landed where the plan said
    for (const note of plan.notes) {
      expect(existsSync(join(vault, note.relPath))).toBe(true);
      expect(readFileSync(join(vault, note.relPath), "utf-8")).toBe(note.body);
    }

    // one commit, authored by the agent identity, mentioning the namespace
    const log = execFileSync("git", ["-C", vault, "log", "--format=%aN|%s"], {
      encoding: "utf-8",
    }).trim();
    expect(log.split("\n")).toHaveLength(1);
    expect(log).toContain("agent:test-import");
    expect(log).toContain("import(langgraph-store): 2 memories from v1");
  });

  it("rejects duplicate destinations before writing any files", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault);
    const plan = deriveNotes([makeRow(), makeRow({ key: "other" })], opts);
    plan.notes[1].relPath = plan.notes[0].relPath;
    const result = await applyPlan(plan, opts);
    expect(result.ok).toBe(false);
    expect(existsSync(join(vault, plan.notes[0].relPath))).toBe(false);
    expect(existsSync(join(vault, ".git"))).toBe(false);
  });

  it("reuses a legacy imported path after the source title changes", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault);
    const original = deriveNotes([makeRow()], opts).notes[0];
    const legacyPath = "langgraph/pricing/original-title--abc12345.md";
    mkdirSync(dirname(join(vault, legacyPath)), { recursive: true });
    writeFileSync(join(vault, legacyPath), original.body);
    const plan = deriveNotes([makeRow({ value: { content: "Revised claim." } })], opts);
    const result = await applyPlan(plan, opts);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(vault, legacyPath), "utf8")).toContain("Revised claim.");
    expect(existsSync(join(vault, plan.notes[0].relPath))).toBe(false);
  });

  it("refuses to overwrite an unrelated document at a planned path", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault);
    const plan = deriveNotes([makeRow()], opts);
    const target = join(vault, plan.notes[0].relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "User-owned note.");
    const result = await applyPlan(plan, opts);
    expect(result.ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("User-owned note.");
    expect(existsSync(join(vault, ".git"))).toBe(false);
  });

  it("refuses ambiguous legacy provenance before writing", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault);
    const plan = deriveNotes([makeRow()], opts);
    mkdirSync(join(vault, "langgraph"));
    for (const name of ["a.md", "b.md"])
      writeFileSync(join(vault, "langgraph", name), plan.notes[0].body);
    const result = await applyPlan(plan, opts);
    expect(result.ok).toBe(false);
    expect(existsSync(join(vault, plan.notes[0].relPath))).toBe(false);
  });

  it("previews the same legacy destination that apply will use", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault);
    const note = deriveNotes([makeRow()], opts).notes[0];
    mkdirSync(join(vault, "langgraph"));
    writeFileSync(join(vault, "langgraph/legacy.md"), note.body);
    const plan = await prepareImportPlan(deriveNotes([makeRow()], opts), opts);
    expect(plan.ok && plan.value.notes[0].relPath).toBe("langgraph/legacy.md");
    expect(existsSync(join(vault, ".git"))).toBe(false);
  });

  it("does not confuse escaped references with another legacy source", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault);
    const legacy = deriveNotes([makeRow({ key: "%E8%A8%98" })], opts).notes[0];
    mkdirSync(join(vault, "langgraph"));
    writeFileSync(
      join(vault, "langgraph/legacy.md"),
      legacy.body.replace(legacy.sourceRef, legacy.legacySourceRef ?? ""),
    );
    const result = await applyPlan(deriveNotes([makeRow({ key: "記" })], opts), opts);
    expect(result.ok).toBe(false);
    expect(readFileSync(join(vault, "langgraph/legacy.md"), "utf8")).toContain("%E8%A8%98");
  });

  it("updates legacy Unicode references in place", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault);
    const row = makeRow({ key: "記憶", prefix: "org.團隊" });
    const note = deriveNotes([row], opts).notes[0];
    mkdirSync(join(vault, "langgraph"));
    writeFileSync(
      join(vault, "langgraph/legacy.md"),
      note.body.replace(note.sourceRef, note.legacySourceRef ?? ""),
    );
    const result = await applyPlan(
      deriveNotes([{ ...row, value: { content: "Changed memory." } }], opts),
      opts,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(vault, "langgraph/legacy.md"), "utf8")).toContain("Changed memory.");
    expect(existsSync(join(vault, note.relPath))).toBe(false);
  });

  it("preserves both memories that formerly collided and updates one in place", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault);
    const rows = [makeRow({ key: "same1234-a" }), makeRow({ key: "same1234-b" })];
    const plan = deriveNotes(rows, opts);
    expect((await applyPlan(plan, opts)).ok).toBe(true);
    for (const note of plan.notes)
      expect(readFileSync(join(vault, note.relPath), "utf8")).toBe(note.body);
    const changed = deriveNotes(
      [{ ...rows[0], value: { content: "Updated first memory." } }],
      opts,
    );
    expect((await applyPlan(changed, opts)).ok).toBe(true);
    expect(readFileSync(join(vault, plan.notes[0].relPath), "utf8")).toContain(
      "Updated first memory.",
    );
    expect(readFileSync(join(vault, plan.notes[1].relPath), "utf8")).toBe(plan.notes[1].body);
  });

  it("rejects a dangling destination alias before any writes", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault);
    const plan = deriveNotes([makeRow()], opts);
    mkdirSync(dirname(join(vault, plan.notes[0].relPath)), { recursive: true });
    const outside = join(makeVault(), "untouched.md");
    symlinkSync(outside, join(vault, plan.notes[0].relPath));
    expect((await applyPlan(plan, opts)).ok).toBe(false);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(vault, ".git"))).toBe(false);
  });

  it("no-ops cleanly on an empty plan", async () => {
    const vault = makeVault();
    const opts = makeOpts(vault, { apply: true, yes: true });
    const res = await applyPlan({ notes: [], skipped: [], byPrefix: {} }, opts);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ written: 0, commit: null });
  });
});

describe("renderPlan", () => {
  it("previews counts, skips, and the apply command without writing", () => {
    const opts = makeOpts("/tmp/nowhere", { namespace: "v1" });
    const plan = deriveNotes(
      [makeRow(), makeRow({ key: "ep1", value: { kind: "Episode", content: { content: "x" } } })],
      opts,
    );
    const out = renderPlan(plan, opts);
    expect(out).toContain("claim notes to create: 1");
    expect(out).toContain("v1.pricing: 1");
    expect(out).toContain("skipped (Episode): 1");
    expect(out).toContain("--namespace v1");
  });
});
