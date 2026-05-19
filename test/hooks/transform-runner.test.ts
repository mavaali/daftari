import { describe, expect, it } from "vitest";
import { runPreWriteTransformHooks } from "../../src/hooks/runner.js";
import type { LoadedTransformHook, PreWriteTransformHook } from "../../src/hooks/types.js";

function makeHook(path: string, fn: PreWriteTransformHook): LoadedTransformHook {
  return { declaration: { path }, hook: fn };
}

const CTX = { path: "decisions/test.md", operation: "create" as const };

describe("runPreWriteTransformHooks", () => {
  it("returns a copy of the input and no issues when no hooks are registered", () => {
    const input = { title: "x" };
    const result = runPreWriteTransformHooks([], input, CTX);
    expect(result.issues).toEqual([]);
    expect(result.merged).toEqual({ title: "x" });
    expect(result.merged).not.toBe(input);
  });

  it("merges a single hook's partial into the frontmatter", () => {
    const hooks = [makeHook("derive.mjs", () => ({ status: "canonical" }))];
    const result = runPreWriteTransformHooks(hooks, { title: "x" }, CTX);
    expect(result.issues).toEqual([]);
    expect(result.merged).toEqual({ title: "x", status: "canonical" });
  });

  it("merges hooks in declaration order — last writer wins on a shared field", () => {
    const hooks = [
      makeHook("a.mjs", () => ({ status: "canonical" })),
      makeHook("b.mjs", () => ({ status: "draft" })),
    ];
    const result = runPreWriteTransformHooks(hooks, {}, CTX);
    expect(result.merged.status).toBe("draft");
  });

  it("hands each hook the prior hook's merged output", () => {
    const hooks = [
      makeHook("first.mjs", () => ({ status: "draft" })),
      makeHook("second.mjs", (fm) => (fm.status === "draft" ? { status: "canonical" } : {})),
    ];
    const result = runPreWriteTransformHooks(hooks, {}, CTX);
    expect(result.merged.status).toBe("canonical");
  });

  it("merges arrays whole — replace, not append", () => {
    const hooks = [makeHook("tags.mjs", () => ({ tags: ["b"] }))];
    const result = runPreWriteTransformHooks(hooks, { tags: ["a"] }, CTX);
    expect(result.merged.tags).toEqual(["b"]);
  });

  it("converts a thrown error into a synthetic issue tagged with the hook path", () => {
    const hooks = [
      makeHook("ok.mjs", () => ({ status: "draft" })),
      makeHook("broken.mjs", () => {
        throw new Error("kaboom");
      }),
      makeHook("after.mjs", () => ({ confidence: "high" })),
    ];
    const result = runPreWriteTransformHooks(hooks, {}, CTX);
    expect(result.issues).toEqual([
      { field: "broken.mjs", message: "transform hook threw: kaboom" },
    ]);
    // The thrown hook contributes nothing; siblings on both sides still merge.
    expect(result.merged).toEqual({ status: "draft", confidence: "high" });
  });

  it("flags a hook that returns null", () => {
    const hooks = [makeHook("bad.mjs", (() => null) as unknown as PreWriteTransformHook)];
    const result = runPreWriteTransformHooks(hooks, {}, CTX);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.field).toBe("bad.mjs");
    expect(result.issues[0]?.message).toContain("non-object (got null)");
  });

  it("flags a hook that returns an array", () => {
    const hooks = [makeHook("bad.mjs", (() => [1, 2]) as unknown as PreWriteTransformHook)];
    const result = runPreWriteTransformHooks(hooks, {}, CTX);
    expect(result.issues[0]?.message).toContain("non-object (got array)");
  });

  it("flags a hook that returns a primitive", () => {
    const hooks = [makeHook("bad.mjs", (() => "nope") as unknown as PreWriteTransformHook)];
    const result = runPreWriteTransformHooks(hooks, {}, CTX);
    expect(result.issues[0]?.message).toContain("non-object (got string)");
  });

  it("gives each hook a fresh copy — in-place mutation of the snapshot does not leak", () => {
    let seenBySecond: Record<string, unknown> | null = null;
    const hooks = [
      makeHook("mutator.mjs", ((fm: Record<string, unknown>) => {
        fm.injected = "leak";
        return {};
      }) as unknown as PreWriteTransformHook),
      makeHook("observer.mjs", (fm) => {
        seenBySecond = { ...fm };
        return {};
      }),
    ];
    const result = runPreWriteTransformHooks(hooks, { title: "x" }, CTX);
    expect(seenBySecond).toEqual({ title: "x" });
    expect(result.merged).toEqual({ title: "x" });
  });

  it("passes the hook context through unchanged", () => {
    let seenCtx: { path: string; operation: string } | null = null;
    const hooks = [
      makeHook("cap.mjs", (_fm, ctx) => {
        seenCtx = ctx;
        return {};
      }),
    ];
    runPreWriteTransformHooks(hooks, {}, { path: "x/y.md", operation: "append" });
    expect(seenCtx).toEqual({ path: "x/y.md", operation: "append" });
  });
});
