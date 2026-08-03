// Read-heat aggregator (Tension Triage Card, Story 2): per-document read
// frequency + recency over the read log, with an `instrumented` flag that
// distinguishes a genuinely cold doc (0 reads, created after the log began)
// from one whose 0 may be an artifact of predating the log.

import { describe, expect, it } from "vitest";
import { computeReadHeat } from "../../src/curation/read-heat.js";
import type { ReadLogEntry } from "../../src/curation/read-log.js";

const NOW = new Date("2026-06-01T00:00:00Z");

// day offset from NOW → ISO timestamp
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const read = (file: string, n: number): ReadLogEntry => ({
  timestamp: daysAgo(n),
  tool: "vault_read",
  file,
});

describe("computeReadHeat", () => {
  it("counts reads within the window and excludes reads older than it", () => {
    const entries = [
      read("a.md", 1),
      read("a.md", 10),
      read("a.md", 40), // outside the 30-day window
    ];
    const heat = computeReadHeat(entries, [{ file: "a.md", created: "2026-01-01" }], {
      now: NOW,
      windowDays: 30,
    });
    expect(heat.get("a.md")?.count).toBe(2);
  });

  it("reports last_read as the most recent in-window timestamp", () => {
    const entries = [read("a.md", 5), read("a.md", 2), read("a.md", 9)];
    const heat = computeReadHeat(entries, [{ file: "a.md", created: "2026-01-01" }], {
      now: NOW,
      windowDays: 30,
    });
    expect(heat.get("a.md")?.last_read).toBe(daysAgo(2));
  });

  it("returns count 0 and last_read null for a doc with no reads", () => {
    const heat = computeReadHeat([read("other.md", 1)], [{ file: "a.md", created: "2026-01-01" }], {
      now: NOW,
      windowDays: 30,
    });
    expect(heat.get("a.md")?.count).toBe(0);
    expect(heat.get("a.md")?.last_read).toBeNull();
  });

  it("counts both vault_read and vault_search serve entries", () => {
    const entries: ReadLogEntry[] = [
      { timestamp: daysAgo(1), tool: "vault_read", file: "a.md" },
      { timestamp: daysAgo(2), tool: "vault_search", file: "a.md" },
    ];
    const heat = computeReadHeat(entries, [{ file: "a.md", created: "2026-01-01" }], {
      now: NOW,
      windowDays: 30,
    });
    expect(heat.get("a.md")?.count).toBe(2);
  });

  it("marks a doc instrumented when it was created on/after the log began", () => {
    // earliest log entry is 20 days ago; doc created 5 days ago → fully covered
    const entries = [read("old.md", 20), read("a.md", 5)];
    const heat = computeReadHeat(entries, [{ file: "a.md", created: daysAgo(5).slice(0, 10) }], {
      now: NOW,
      windowDays: 30,
    });
    expect(heat.get("a.md")?.instrumented).toBe(true);
  });

  it("marks a doc uninstrumented when it predates the log's earliest entry", () => {
    // earliest log entry is 20 days ago; doc created 100 days ago → its 0 is suspect
    const entries = [read("old.md", 20)];
    const heat = computeReadHeat(
      entries,
      [{ file: "cold.md", created: daysAgo(100).slice(0, 10) }],
      {
        now: NOW,
        windowDays: 30,
      },
    );
    const h = heat.get("cold.md");
    expect(h?.count).toBe(0);
    expect(h?.instrumented).toBe(false);
  });

  it("marks a doc uninstrumented when the log is empty (captured nothing)", () => {
    const heat = computeReadHeat([], [{ file: "a.md", created: "2026-01-01" }], {
      now: NOW,
      windowDays: 30,
    });
    expect(heat.get("a.md")?.instrumented).toBe(false);
  });

  it("treats a doc with unknown creation date as uninstrumented (conservative)", () => {
    const entries = [read("old.md", 20)];
    const heat = computeReadHeat(entries, [{ file: "a.md" }], { now: NOW, windowDays: 30 });
    expect(heat.get("a.md")?.instrumented).toBe(false);
  });

  it("defaults to a 30-day window when none is given", () => {
    const entries = [read("a.md", 10), read("a.md", 40)];
    const heat = computeReadHeat(entries, [{ file: "a.md", created: "2026-01-01" }], { now: NOW });
    expect(heat.get("a.md")?.count).toBe(1);
  });

  it("returns a result for every requested doc, one heat per doc", () => {
    const entries = [read("a.md", 1), read("b.md", 2)];
    const heat = computeReadHeat(
      entries,
      [
        { file: "a.md", created: "2026-01-01" },
        { file: "b.md", created: "2026-01-01" },
      ],
      { now: NOW, windowDays: 30 },
    );
    expect(heat.size).toBe(2);
    expect(heat.get("a.md")?.count).toBe(1);
    expect(heat.get("b.md")?.count).toBe(1);
  });
});
