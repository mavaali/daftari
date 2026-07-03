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

  describe("shadow_mode safety gate (S5)", () => {
    // A live loop that writes edges without the operator ever choosing to is a
    // surprising, money- and state-touching default. Require an explicit choice.
    function withoutApiKeys(run: () => Promise<void>): Promise<void> {
      const a = process.env.ANTHROPIC_API_KEY;
      const o = process.env.OPENROUTER_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      return run().finally(() => {
        if (a !== undefined) process.env.ANTHROPIC_API_KEY = a;
        if (o !== undefined) process.env.OPENROUTER_API_KEY = o;
      });
    }

    it("refuses mode != scan when shadow_mode is not set in config", async () => {
      writeFileSync(join(dir, "a.md"), "# a\n");
      await commit(dir, ["."], "init", "agent:test");
      silenceStdout();
      const errs: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((s) => {
        errs.push(String(s));
        return true;
      });
      await withoutApiKeys(async () => {
        const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
        expect(code).toBe(2);
        expect(errs.join("")).toContain("shadow_mode");
        expect(errs.join("")).toContain("refus");
      });
    });

    it("does NOT refuse when shadow_mode is explicitly set", async () => {
      writeFileSync(join(dir, "a.md"), "# a\n");
      writeFileSync(
        join(dir, ".daftari", "config.yaml"),
        "version: 1\nvault_name: v\nshadow_mode: true\n",
      );
      await commit(dir, ["."], "init", "agent:test");
      silenceStdout();
      const errs: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((s) => {
        errs.push(String(s));
        return true;
      });
      await withoutApiKeys(async () => {
        // Proceeds past the gate (may still exit for a missing API key), but the
        // shadow_mode refusal must never appear.
        await runConsolidate(["--vault", dir, "--mode", "birth"]);
        expect(errs.join("")).not.toContain("refus");
      });
    });

    it("does NOT refuse in scan mode (no writes possible)", async () => {
      writeFileSync(join(dir, "a.md"), "# a\n");
      await commit(dir, ["."], "init", "agent:test");
      silenceStdout();
      const code = await runConsolidate(["--vault", dir, "--mode", "scan"]);
      expect(code).toBe(0);
    });
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
    // Degrades (not crash) but signals: the event clock was skipped and the
    // baseline re-based to HEAD, so the gap is not event-examined → exit 7
    // (cron-alertable) rather than a silent exit 0.
    expect(code).toBe(7);
    expect(out.join("")).toContain("consolidate @");
    // And it must re-baseline so it doesn't loop on the same dead commit.
    expect(readConsolidateState(dir).lastConsolidationCommit).not.toBe(
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
  });
});
