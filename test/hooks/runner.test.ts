import { describe, expect, it } from "vitest";
import { runPreWriteHooks } from "../../src/hooks/runner.js";
import type { LoadedHook, PreWriteHook } from "../../src/hooks/types.js";

function makeHook(path: string, fn: PreWriteHook): LoadedHook {
  return { declaration: { path }, hook: fn };
}

const CTX = { path: "decisions/test.md", operation: "create" as const };

describe("runPreWriteHooks", () => {
  it("returns no issues when no hooks are registered", () => {
    expect(runPreWriteHooks([], {}, CTX)).toEqual([]);
  });

  it("returns no issues when every hook reports clean", () => {
    const hooks = [makeHook("a.mjs", () => []), makeHook("b.mjs", () => [])];
    expect(runPreWriteHooks(hooks, { title: "x" }, CTX)).toEqual([]);
  });

  it("collects issues from every hook (no fail-fast)", () => {
    const hooks = [
      makeHook("a.mjs", () => [{ field: "x", message: "from a" }]),
      makeHook("b.mjs", () => [{ field: "y", message: "from b" }]),
    ];
    const issues = runPreWriteHooks(hooks, {}, CTX);
    expect(issues).toEqual([
      { field: "x", message: "from a" },
      { field: "y", message: "from b" },
    ]);
  });

  it("converts a thrown error into a synthetic issue tagged with the hook path", () => {
    const hooks = [
      makeHook("ok.mjs", () => [{ field: "first", message: "still runs" }]),
      makeHook("broken.mjs", () => {
        throw new Error("kaboom");
      }),
      makeHook("after.mjs", () => [{ field: "third", message: "also still runs" }]),
    ];
    const issues = runPreWriteHooks(hooks, {}, CTX);
    expect(issues).toEqual([
      { field: "first", message: "still runs" },
      { field: "broken.mjs", message: "hook threw: kaboom" },
      { field: "third", message: "also still runs" },
    ]);
  });

  it("preserves hook declaration order in the output", () => {
    const hooks = [
      makeHook("first.mjs", () => [{ field: "f1", message: "1" }]),
      makeHook("second.mjs", () => [{ field: "f2", message: "2" }]),
      makeHook("third.mjs", () => [{ field: "f3", message: "3" }]),
    ];
    const issues = runPreWriteHooks(hooks, {}, CTX);
    expect(issues.map((i) => i.field)).toEqual(["f1", "f2", "f3"]);
  });

  it("flags a hook that returns a non-array", () => {
    const hooks = [makeHook("bad.mjs", (() => "not-an-array") as unknown as PreWriteHook)];
    const issues = runPreWriteHooks(hooks, {}, CTX);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("bad.mjs");
    expect(issues[0]?.message).toContain("non-array");
  });

  it("flags a hook that returns malformed issue objects but keeps well-formed siblings", () => {
    const hooks = [
      makeHook("mixed.mjs", (() => [
        { field: "ok", message: "fine" },
        { wrong: "shape" },
        null,
        { field: "also-ok", message: "fine too" },
      ]) as unknown as PreWriteHook),
    ];
    const issues = runPreWriteHooks(hooks, {}, CTX);
    expect(issues).toHaveLength(4);
    expect(issues[0]).toEqual({ field: "ok", message: "fine" });
    expect(issues[1]?.field).toBe("mixed.mjs");
    expect(issues[1]?.message).toContain("malformed issue");
    expect(issues[2]?.field).toBe("mixed.mjs");
    expect(issues[3]).toEqual({ field: "also-ok", message: "fine too" });
  });

  it("hands each hook the same frontmatter — no hook sees another's issues", () => {
    let seenByB: Record<string, unknown> | null = null;
    const hooks = [
      makeHook("a.mjs", () => [{ field: "from-a", message: "noise" }]),
      makeHook("b.mjs", (fm) => {
        seenByB = fm;
        return [];
      }),
    ];
    runPreWriteHooks(hooks, { title: "x" }, CTX);
    expect(seenByB).toEqual({ title: "x" });
  });

  it("passes the hook context through unchanged", () => {
    let seenCtx: { path: string; operation: string } | null = null;
    const hooks = [
      makeHook("cap.mjs", (_fm, ctx) => {
        seenCtx = ctx;
        return [];
      }),
    ];
    runPreWriteHooks(hooks, {}, { path: "x/y.md", operation: "append" });
    expect(seenCtx).toEqual({ path: "x/y.md", operation: "append" });
  });
});
