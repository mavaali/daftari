// `daftari eval prune` (#100): plan-level unit tests for the retention
// rules, plus CLI-level tests over real temp directories — dry-run,
// deletion, the at-least-one-rule gate, and the never-touched artifacts
// (history.json, questions/).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEval } from "../../src/eval/index.js";
import { type PruneCandidate, parseOlderThan, planPrune } from "../../src/eval/prune.js";

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

function c(name: string, ageDays: number, size = 10): PruneCandidate {
  return { name, mtimeMs: NOW - ageDays * DAY, size };
}

describe("planPrune", () => {
  it("--keep retains exactly the N most recent, ties broken deterministically", () => {
    const plan = planPrune(
      [c("old.json", 5), c("mid.json", 3), c("new.json", 1)],
      { keep: 2 },
      NOW,
    );
    expect(plan.kept.map((x) => x.name)).toEqual(["new.json", "mid.json"]);
    expect(plan.deleted.map((x) => x.name)).toEqual(["old.json"]);
  });

  it("--older-than retains files younger than the cutoff", () => {
    const plan = planPrune([c("old.json", 40), c("new.json", 10)], { maxAgeMs: 30 * DAY }, NOW);
    expect(plan.kept.map((x) => x.name)).toEqual(["new.json"]);
    expect(plan.deleted.map((x) => x.name)).toEqual(["old.json"]);
  });

  it("combined rules are least-destruction: a file survives if EITHER retains it", () => {
    // keep=1 retains only the newest; the 10-day file is outside keep-1 but
    // younger than 30d, so the age rule saves it. Only the 40-day file dies.
    const plan = planPrune(
      [c("ancient.json", 40), c("recent.json", 10), c("newest.json", 1)],
      { keep: 1, maxAgeMs: 30 * DAY },
      NOW,
    );
    expect(plan.deleted.map((x) => x.name)).toEqual(["ancient.json"]);
    expect(plan.kept.map((x) => x.name)).toEqual(["newest.json", "recent.json"]);
  });

  it("--keep 0 with no age rule deletes everything", () => {
    const plan = planPrune([c("a.json", 1), c("b.json", 2)], { keep: 0 }, NOW);
    expect(plan.kept).toEqual([]);
    expect(plan.deleted).toHaveLength(2);
  });
});

describe("parseOlderThan", () => {
  it("parses days and hours", () => {
    expect(parseOlderThan("30d")).toBe(30 * DAY);
    expect(parseOlderThan("12h")).toBe(12 * 3_600_000);
  });

  it("rejects malformed values", () => {
    for (const bad of ["30", "d30", "30w", "-5d", ""]) {
      expect(() => parseOlderThan(bad)).toThrow("--older-than");
    }
  });
});

describe("daftari eval prune CLI", () => {
  let dir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let outSpy: ReturnType<typeof vi.spyOn>;

  // Seeds results/ + scores/ with three aged artifacts each, plus the
  // never-touched neighbors (history.json, questions/).
  function seedArtifacts(): void {
    const evalDir = join(dir, ".daftari", "eval");
    for (const sub of ["results", "scores", "questions"]) {
      mkdirSync(join(evalDir, sub), { recursive: true });
    }
    writeFileSync(join(evalDir, "history.json"), '{"version":1,"runs":[]}');
    writeFileSync(join(evalDir, "questions", "qs.json"), "{}");
    for (const [name, ageDays] of [
      ["old-run.json", 40],
      ["mid-run.json", 10],
      ["new-run.json", 1],
    ] as const) {
      for (const sub of ["results", "scores"] as const) {
        const p = join(evalDir, sub, name);
        writeFileSync(p, "{}");
        const t = new Date(Date.now() - ageDays * DAY);
        utimesSync(p, t, t);
      }
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-prune-"));
    seedArtifacts();
    errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    errSpy.mockRestore();
    outSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function stdoutText(): string {
    return outSpy.mock.calls.map((x) => String(x[0])).join("");
  }

  it("requires at least one retention rule", async () => {
    const code = await runEval(["prune", "--vault", dir]);
    expect(code).toBe(2);
    expect(errSpy.mock.calls.join("")).toContain("at least one retention rule");
  });

  it("--dry-run lists deletions without deleting", async () => {
    const code = await runEval(["prune", "--vault", dir, "--keep", "1", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdoutText()).toContain("would delete 2 file(s)");
    expect(stdoutText()).toContain("old-run.json");
    // Nothing actually removed.
    expect(readdirSync(join(dir, ".daftari", "eval", "results"))).toHaveLength(3);
    expect(readdirSync(join(dir, ".daftari", "eval", "scores"))).toHaveLength(3);
  });

  it("deletes per the rules and never touches history.json or questions/", async () => {
    const code = await runEval(["prune", "--vault", dir, "--older-than", "30d"]);
    expect(code).toBe(0);
    for (const sub of ["results", "scores"] as const) {
      const names = readdirSync(join(dir, ".daftari", "eval", sub)).sort();
      expect(names).toEqual(["mid-run.json", "new-run.json"]);
    }
    expect(existsSync(join(dir, ".daftari", "eval", "history.json"))).toBe(true);
    expect(existsSync(join(dir, ".daftari", "eval", "questions", "qs.json"))).toBe(true);
    expect(stdoutText()).toContain("deleted 1 file(s)");
  });

  it("works without ANTHROPIC_API_KEY — prune is local-only", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const code = await runEval(["prune", "--vault", dir, "--keep", "3"]);
    expect(code).toBe(0);
  });

  it("treats a vault with no eval artifacts as an empty no-op", async () => {
    const empty = mkdtempSync(join(tmpdir(), "daftari-prune-empty-"));
    try {
      const code = await runEval(["prune", "--vault", empty, "--keep", "5"]);
      expect(code).toBe(0);
      expect(stdoutText()).toContain("kept 0");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("rejects a malformed --older-than with a config error", async () => {
    const code = await runEval(["prune", "--vault", dir, "--older-than", "fortnight"]);
    expect(code).toBe(2);
    expect(errSpy.mock.calls.join("")).toContain("--older-than must look like");
  });
});
