import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConsolidate } from "../../src/consolidate/index.js";
import { readConsolidateState, writeConsolidateState } from "../../src/consolidate/state.js";
import { commit } from "../../src/utils/git.js";

function silenceStdout(): void {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daftari-consol-"));
  mkdirSync(join(dir, ".daftari"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runConsolidate", () => {
  it("on a fresh vault, lists every doc in the birth queue and exits 0", async () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    writeFileSync(join(dir, "b.md"), "# b\n");
    await commit(dir, ["."], "init", "agent:test");

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });

    const code = await runConsolidate(["--vault", dir]);
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("birth");
    expect(text).toContain("a.md");
    expect(text).toContain("b.md");
  });

  it("exits 2 when no vault resolves", async () => {
    const code = await runConsolidate(["--vault", join(dir, "does-not-exist")]);
    expect(code).toBe(2);
  });

  it("exits 2 on a non-numeric budget", async () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    await commit(dir, ["."], "init", "agent:test");
    const code = await runConsolidate(["--vault", dir, "--budget", "nope"]);
    expect(code).toBe(2);
  });

  it("advances the baseline commit on each run (steady state)", async () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    await commit(dir, ["."], "init", "agent:test");
    silenceStdout();

    expect(readConsolidateState(dir).lastConsolidationCommit).toBeNull();
    await runConsolidate(["--vault", dir]);
    const first = readConsolidateState(dir).lastConsolidationCommit;
    expect(first).not.toBeNull();

    writeFileSync(join(dir, "a.md"), "# a v2\n");
    await commit(dir, ["."], "edit", "agent:test");
    await runConsolidate(["--vault", dir]);
    const second = readConsolidateState(dir).lastConsolidationCommit;
    expect(second).not.toBe(first); // baseline moved to the new HEAD
  });

  it("does NOT advance birthProcessed in Stage 1 (no births executed)", async () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    await commit(dir, ["."], "init", "agent:test");
    silenceStdout();
    await runConsolidate(["--vault", dir]);
    expect(readConsolidateState(dir).birthProcessed).toEqual({});
  });

  it("degrades (not crash) on a stale/invalid baseline commit", async () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    await commit(dir, ["."], "init", "agent:test");
    writeConsolidateState(dir, {
      lastConsolidationCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      birthProcessed: {},
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    const code = await runConsolidate(["--vault", dir]);
    expect(code).toBe(0); // skips the event clock, still reports
    expect(out.join("")).toContain("consolidate @");
  });
});
