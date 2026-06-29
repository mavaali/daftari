import { describe, expect, test } from "vitest";
import { formatInstanceDump } from "./consensus-dump.js";
import type { LabeledInstance } from "./consensus-instances.js";

const inst: LabeledInstance[] = [
  { revid: 1002, parentid: 1001, timestamp: "2025-09-02T11:00:00Z", user: "EditorB", comment: "manual rv per consensus 70", citedNum: 70, resolved: true, governingNum: 70, chain: [70] },
  { revid: 1006, parentid: 1005, timestamp: "2025-09-06T15:00:00Z", user: "EditorF", comment: "Undid revision 1005 — see consensus 999", citedNum: 999, resolved: false, governingNum: undefined, chain: [] },
];

describe("formatInstanceDump", () => {
  test("renders one line per instance with cited->governing", () => {
    const dump = formatInstanceDump(inst);
    const lines = dump.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("rev 1002");
    expect(lines[0]).toContain("#70 -> #70");
  });

  test("flags an unresolved anomaly", () => {
    const dump = formatInstanceDump(inst);
    expect(dump).toContain("ANOMALY");
    expect(dump).toContain("#999");
  });
});
