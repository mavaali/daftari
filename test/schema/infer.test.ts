import { describe, expect, it } from "vitest";
import { inferFromDocs, inferValueType } from "../../src/schema/infer.js";
import type { ScannedDoc } from "../../src/schema/types.js";

function doc(relPath: string, raw: Record<string, unknown>): ScannedDoc {
  return { relPath, scope: relPath.includes("/") ? relPath.split("/")[0]! : "", raw };
}

describe("inferValueType", () => {
  it("classifies primitives", () => {
    expect(inferValueType("hello")).toBe("string");
    expect(inferValueType(42)).toBe("number");
    expect(inferValueType(true)).toBe("boolean");
    expect(inferValueType(["a", "b"])).toBe("array");
    expect(inferValueType(null)).toBe("null");
    expect(inferValueType({ nested: true })).toBe("object");
  });

  it("classifies YYYY-MM-DD strings and Date objects as date", () => {
    expect(inferValueType("2026-07-01")).toBe("date");
    expect(inferValueType(new Date("2026-07-01"))).toBe("date");
    expect(inferValueType("2026-07")).toBe("string");
  });
});

describe("inferFromDocs", () => {
  it("counts occurrences and reports totalDocs", () => {
    const docs = [
      doc("notes/a.md", { title: "A", priority: "high" }),
      doc("notes/b.md", { title: "B", priority: "high" }),
      doc("notes/c.md", { title: "C" }),
    ];
    const report = inferFromDocs(docs);
    expect(report.totalDocs).toBe(3);
    const priority = report.fields.find((f) => f.field === "priority");
    expect(priority?.occurrences).toBe(2);
    const title = report.fields.find((f) => f.field === "title");
    expect(title?.occurrences).toBe(3);
  });

  it("excludes null/undefined values from occurrence counts", () => {
    const docs = [doc("a.md", { owner: null, title: "A" }), doc("b.md", { title: "B" })];
    const report = inferFromDocs(docs);
    expect(report.fields.find((f) => f.field === "owner")).toBeUndefined();
  });

  it("sorts fields by occurrence descending, then field name", () => {
    const docs = [
      doc("a.md", { zeta: 1, alpha: 1 }),
      doc("b.md", { zeta: 1 }),
    ];
    const report = inferFromDocs(docs);
    expect(report.fields.map((f) => f.field)).toEqual(["zeta", "alpha"]);
  });

  it("flags a small, repeated value set as enum-like", () => {
    const docs = [
      doc("a.md", { status: "open" }),
      doc("b.md", { status: "open" }),
      doc("c.md", { status: "closed" }),
    ];
    const report = inferFromDocs(docs);
    const status = report.fields.find((f) => f.field === "status");
    expect(status?.enumLike).toBe(true);
    expect(status?.distinctValues).toBe(2);
  });

  it("does not flag all-unique or single-occurrence values as enum-like", () => {
    const docs = [
      doc("a.md", { title: "Unique A", once: "x" }),
      doc("b.md", { title: "Unique B" }),
    ];
    const report = inferFromDocs(docs);
    expect(report.fields.find((f) => f.field === "title")?.enumLike).toBe(false);
    expect(report.fields.find((f) => f.field === "once")?.enumLike).toBe(false);
  });

  it("caps examples and marks distinct-value overflow", () => {
    const docs = Array.from({ length: 60 }, (_, i) => doc(`d${i}.md`, { id: `v${i}` }));
    const report = inferFromDocs(docs);
    const id = report.fields.find((f) => f.field === "id");
    expect(id?.examples.length).toBeLessThanOrEqual(5);
    expect(id?.distinctValuesCapped).toBe(true);
    expect(id?.enumLike).toBe(false);
  });

  it("carries through the scope and any skipped docs", () => {
    const report = inferFromDocs([], "notes", [{ path: "notes/bad.md", reason: "boom" }]);
    expect(report.scope).toBe("notes");
    expect(report.skipped).toEqual([{ path: "notes/bad.md", reason: "boom" }]);
  });
});
