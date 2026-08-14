import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSleep } from "../../src/sleep/index.js";
import { listRuns } from "../../src/sleep/run-ledger.js";
import { runRuns } from "../../src/sleep/runs-cli.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("sleep → run ledger integration + `daftari runs` (slice B)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("a completed circadian pass appends exactly one circadian run record", async () => {
    const code = await runSleep(["--vault", vault, "--output", join(vault, "report.md")]);
    expect(code).toBe(0);
    const runs = listRuns(vault);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.kind).toBe("circadian");
    expect(runs[0]?.summary).toHaveProperty("staleness");
  });

  it("--no-ledger suppresses the append", async () => {
    const code = await runSleep([
      "--vault",
      vault,
      "--no-ledger",
      "--output",
      join(vault, "report.md"),
    ]);
    expect(code).toBe(0);
    expect(listRuns(vault)).toHaveLength(0);
  });

  it("`runs list` exits 0 on an empty ledger", async () => {
    expect(await runRuns(["--vault", vault])).toBe(0);
  });

  it("`runs show` on a missing id exits 4", async () => {
    expect(await runRuns(["show", "nope", "--vault", vault])).toBe(4);
  });

  it("`runs show` finds a recorded run by id prefix after a pass", async () => {
    await runSleep(["--vault", vault, "--output", join(vault, "report.md")]);
    const id = listRuns(vault)[0]?.id as string;
    expect(await runRuns(["show", id.slice(0, 10), "--vault", vault])).toBe(0);
  });

  it("rejects an unknown subcommand with exit 2", async () => {
    expect(await runRuns(["bogus", "--vault", vault])).toBe(2);
  });
});
