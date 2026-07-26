import { describe, expect, it } from "vitest";
import { diffFromDocs } from "../../src/schema/diff.js";
import type { ScannedDoc } from "../../src/schema/types.js";
import type { SchemaExtension } from "../../src/utils/config.js";

function doc(relPath: string, raw: Record<string, unknown>): ScannedDoc {
  return { relPath, scope: relPath.includes("/") ? relPath.split("/")[0]! : "", raw };
}

const EXTENSIONS: SchemaExtension[] = [
  { field: "priority", type: "enum", required: false, enum: ["low", "medium", "high"] },
  { field: "due_date", type: "date", required: false },
  { field: "reviewed", type: "boolean", required: false },
];

const DOCS: ScannedDoc[] = [
  doc("a.md", { priority: "urgent", due_date: "2026-01-01", state: "open" }),
  doc("b.md", { priority: "high", state: "open" }),
  doc("c.md", { priority: "low", owner: "alice" }),
  doc("d.md", { due_date: "not-a-date" }),
];

describe("diffFromDocs", () => {
  it("reports undeclared keys in wide use, with a near-miss suggestion", () => {
    const report = diffFromDocs(DOCS, EXTENSIONS);
    const state = report.undeclared.find((u) => u.field === "state");
    expect(state).toBeDefined();
    expect(state?.occurrences).toBe(2);
    expect(state?.nearMiss).toBe("status");
  });

  it("omits undeclared keys below the min-occurrences threshold", () => {
    const report = diffFromDocs(DOCS, EXTENSIONS);
    expect(report.undeclared.find((u) => u.field === "owner")).toBeUndefined();
  });

  it("honors a custom --min-occurrences", () => {
    const report = diffFromDocs(DOCS, EXTENSIONS, null, { minOccurrences: 1 });
    expect(report.undeclared.find((u) => u.field === "owner")).toBeDefined();
  });

  it("reports declared extensions never observed", () => {
    const report = diffFromDocs(DOCS, EXTENSIONS);
    expect(report.unusedExtensions).toEqual([{ field: "reviewed", type: "boolean" }]);
  });

  it("reports enum drift with occurrence/offending counts and examples", () => {
    const report = diffFromDocs(DOCS, EXTENSIONS);
    const priority = report.drift.find((d) => d.field === "priority");
    expect(priority?.occurrences).toBe(3);
    expect(priority?.offending).toBe(1);
    expect(priority?.examples).toEqual(["urgent"]);
  });

  it("reports date-type drift", () => {
    const report = diffFromDocs(DOCS, EXTENSIONS);
    const dueDate = report.drift.find((d) => d.field === "due_date");
    expect(dueDate?.occurrences).toBe(2);
    expect(dueDate?.offending).toBe(1);
    expect(dueDate?.examples).toEqual(["not-a-date"]);
  });

  it("does not report drift for a field with no violations", () => {
    const report = diffFromDocs(
      [doc("a.md", { priority: "low" }), doc("b.md", { priority: "high" })],
      EXTENSIONS,
    );
    expect(report.drift).toEqual([]);
  });

  it("does not flag a missing required extension as drift, only as unused", () => {
    const required: SchemaExtension[] = [{ field: "reviewed", type: "boolean", required: true }];
    const report = diffFromDocs([doc("a.md", { title: "A" })], required);
    expect(report.drift).toEqual([]);
    expect(report.unusedExtensions).toEqual([{ field: "reviewed", type: "boolean" }]);
  });
});
