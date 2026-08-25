import { configDefaults, defineConfig } from "vitest/config";

// Git worktrees are created under .claude/worktrees/ and .worktrees/. Each is a
// full repo copy with its own test/ tree, so without this exclude vitest would
// recurse into every worktree and run its suite alongside the current one —
// inflating and cross-contaminating results.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/.worktrees/**"],
    // Index-heavy suites (backlinks, read-consumes-positions, merge-reader,
    // doc-view, …) build a real .daftari SQLite index and query it. Under
    // concurrent build load on a shared host they are correct but slow, and the
    // default 5000ms per-test deadline flips green→red purely on scheduling
    // latency — a false-red (measured: 0.708 false-red rate under 2× load, 92%
    // of it timeouts). A longer deadline makes pass/fail depend on correctness,
    // not wall-clock: a broken test still fails its assertion; a genuinely hung
    // test just takes longer to surface (bounded by the CI job timeout).
    // hookTimeout covers the afterEach cleanup, whose bounded rmSync-retry loop
    // can itself exceed 5s on a loaded runner. See work/mpn1-concurrency-measure.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
