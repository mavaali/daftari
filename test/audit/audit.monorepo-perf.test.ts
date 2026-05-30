// test/audit/audit.monorepo-perf.test.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAudit } from "../../src/audit/index.js";

const RUN = process.env.RUN_PERF === "1";

describe.skipIf(!RUN)("audit perf — monorepo history", () => {
  let tmp: string;
  let repo: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "daftari-audit-mp-"));
    repo = join(tmp, "r");
    mkdirSync(repo);
    mkdirSync(join(repo, "docs"));
    mkdirSync(join(repo, "src"));

    // Seed 4000 docs (one commit).
    for (let i = 0; i < 4000; i++) {
      writeFileSync(
        join(repo, "docs", `d${i}.md`),
        `# d${i}\nsee [d${(i + 1) % 4000}](./d${(i + 1) % 4000}.md)\n`,
      );
    }
    // Seed 16000 non-doc files.
    for (let i = 0; i < 16000; i++) {
      writeFileSync(join(repo, "src", `f${i}.txt`), `${i}\n`);
    }
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"],
      { cwd: repo },
    );
    // Add 1000 source-only commits to fatten history.
    for (let c = 0; c < 1000; c++) {
      writeFileSync(join(repo, "src", `f${c}.txt`), `${c}-${c}\n`);
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "src"], {
        cwd: repo,
      });
      execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `c${c}`],
        { cwd: repo },
      );
    }
  }, 300_000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("scoped git log keeps the audit under 30s with history fattened by 1000 unrelated commits", async () => {
    const t0 = Date.now();
    const code = await runAudit(["--repo", repo, "--output", join(tmp, "out.md")]);
    const elapsed = Date.now() - t0;
    expect([0, 1]).toContain(code);
    expect(elapsed).toBeLessThan(30_000);
  }, 90_000);
});
