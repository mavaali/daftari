// test/audit/audit.perf.test.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAudit } from "../../src/audit/index.js";

const RUN = process.env.RUN_PERF === "1";

describe.skipIf(!RUN)("audit perf — 4000 docs", () => {
  let tmp: string;
  let repo: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "daftari-audit-perf-"));
    repo = join(tmp, "r");
    mkdirSync(repo);
    mkdirSync(join(repo, "docs"));
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const links: string[] = [];
      for (let k = 0; k < 5; k++) {
        const target = (i + k * 37 + 1) % N;
        links.push(`- [doc-${target}](./doc-${target}.md)`);
      }
      writeFileSync(join(repo, "docs", `doc-${i}.md`), `# Doc ${i}\n\n${links.join("\n")}\n`);
    }
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"],
      { cwd: repo },
    );
  }, 120_000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("completes under 30s on 4000 docs", async () => {
    const t0 = Date.now();
    const code = await runAudit(["--repo", repo, "--output", join(tmp, "out.md")]);
    const elapsed = Date.now() - t0;
    expect([0, 1]).toContain(code);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});
