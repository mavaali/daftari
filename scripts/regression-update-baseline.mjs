// Regenerate test/regression/baselines/*.json from current behavior.
// Refuses to run on a dirty tree so the baseline delta is attributable to the
// committed change that caused it and travels alone in the next commit
// (docs/superpowers/specs/2026-07-07-regression-suite-design.md).
import { execFileSync, spawnSync } from "node:child_process";

const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (dirty !== "") {
  console.error("regression:update-baseline: working tree is dirty — commit or stash first.");
  console.error("The baseline delta must be the only change, attributable to the last commit.");
  console.error(dirty);
  process.exit(1);
}

const run = spawnSync("npx", ["vitest", "run", "test/regression"], {
  stdio: "inherit",
  env: { ...process.env, REGRESSION_UPDATE: "1" },
});
if (run.status !== 0) process.exit(run.status ?? 1);

const changed = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (changed === "") {
  console.log("Baselines unchanged — current behavior already matches the committed goldens.");
} else {
  console.log("Updated baselines (review and commit with your PR):");
  console.log(changed);
}
