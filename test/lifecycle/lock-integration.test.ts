// Spawns two real daftari processes against the same vault. Asserts that the
// first one exits within the SIGTERM grace window and that the second is
// still running. End-to-end check that issue #52 is fixed.
//
// Requires `npm run build` to have run — the test executes dist/index.js.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FIXTURE = resolve("test/fixtures/sample-vault");

describe("two daftari processes against one vault", () => {
  let vault: string;

  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-lockint-"));
    cpSync(FIXTURE, vault, {
      recursive: true,
      filter: (src) => !src.includes(".daftari"),
    });
  });

  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("second instance takes over from the first", async () => {
    const entry = resolve("dist/index.js");
    expect(existsSync(entry)).toBe(true);

    const procA = spawn("node", [entry, "--vault", vault], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Give A time to acquire the lock and open the transport.
    await new Promise((r) => setTimeout(r, 1500));

    const procB = spawn("node", [entry, "--vault", vault], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    // A should exit within SIGTERM grace (3s) + slack.
    const aExited = await new Promise<boolean>((resolveExit) => {
      const timer = setTimeout(() => resolveExit(false), 6000);
      procA.once("exit", () => {
        clearTimeout(timer);
        resolveExit(true);
      });
    });

    expect(aExited).toBe(true);
    expect(procB.killed).toBe(false);
    expect(procB.exitCode).toBeNull();

    procB.kill("SIGTERM");
    await new Promise((r) => procB.once("exit", r));
  }, 15_000);
});
