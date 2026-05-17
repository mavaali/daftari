import { configDefaults, defineConfig } from "vitest/config";

// Git worktrees are created under .claude/worktrees/. Each is a full repo copy
// with its own test/ tree, so without this exclude vitest would recurse into
// every worktree and run its suite alongside the current one — inflating and
// cross-contaminating results.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
