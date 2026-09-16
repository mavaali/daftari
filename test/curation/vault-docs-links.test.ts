import { describe, expect, it } from "vitest";
import {
  buildPathIndexes,
  outgoingLinkTargets,
  resolveLink,
} from "../../src/curation/vault-docs.js";

function resolve(rawTarget: string, fromPath: string, paths: string[]): string | null {
  const indexes = buildPathIndexes(paths.map((path) => ({ path })));
  return resolveLink(rawTarget, fromPath, indexes.byPath, indexes.byBasename);
}

describe("resolveLink", () => {
  it("does not basename-fallback a qualified dangling reference", () => {
    expect(resolve("a/foo.md", "readers/consumer.md", ["b/foo.md"])).toBeNull();
  });

  it("does not choose arbitrarily when a bare basename is ambiguous", () => {
    expect(resolve("foo", "readers/consumer.md", ["a/foo.md", "b/foo.md"])).toBeNull();
  });

  it("resolves a unique bare basename", () => {
    expect(resolve("foo", "readers/consumer.md", ["a/foo.md"])).toBe("a/foo.md");
  });

  it("resolves a qualified path relative to the linking document", () => {
    expect(resolve("../a/foo", "readers/consumer.md", ["a/foo.md"])).toBe("a/foo.md");
  });

  it("does not materialize a backlink through a qualified dangling link", () => {
    const indexes = buildPathIndexes([{ path: "b/foo.md" }]);
    expect(
      outgoingLinkTargets("see [former target](a/foo.md)", "readers/consumer.md", indexes),
    ).toEqual([]);
  });
});
