import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/utils/concurrency.js";

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("mapWithConcurrency", () => {
  it("returns results in input order even when completion order differs", async () => {
    const items = [30, 0, 20, 10, 0];
    const out = await mapWithConcurrency(items, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:0", "2:20", "3:10", "4:0"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      4,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        await tick();
        inFlight -= 1;
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // sanity: it actually ran concurrently
  });

  it("handles an empty input", async () => {
    const out = await mapWithConcurrency([], 8, async () => "x");
    expect(out).toEqual([]);
  });

  it("handles limit larger than the item count", async () => {
    const out = await mapWithConcurrency([1, 2], 16, async (n) => n * 2);
    expect(out).toEqual([2, 4]);
  });

  it("passes the item index to fn", async () => {
    const out = await mapWithConcurrency(["a", "b", "c"], 2, async (item, i) => `${i}${item}`);
    expect(out).toEqual(["0a", "1b", "2c"]);
  });

  it("propagates the first rejection and stops starting new work", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency(
        Array.from({ length: 20 }, (_, i) => i),
        2,
        async (i) => {
          started.push(i);
          await tick();
          if (i === 1) throw new Error("boom");
          return i;
        },
      ),
    ).rejects.toThrow("boom");
    // With limit 2, items 0 and 1 start; 1 throws after a tick; at most one
    // more item (picked up by the surviving worker before the failure flag
    // flips) may start — but nowhere near all 20.
    expect(started.length).toBeLessThan(6);
  });

  it("rejects a non-positive or non-integer limit", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], -1, async (n) => n)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 2.5, async (n) => n)).rejects.toThrow(RangeError);
  });
});
