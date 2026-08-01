import { describe, it, expect } from "vitest";
import { scrubDateTokens, scrubDatesDeep, wrapHandlerWithDateScrub } from "./timestamps.js";

describe("scrubDateTokens", () => {
  it("replaces an ISO calendar date with a neutral placeholder", () => {
    expect(scrubDateTokens("we met on 2026-07-31 downtown")).toBe("we met on [date] downtown");
  });

  it("scrubs a full ISO datetime, including the time portion", () => {
    expect(scrubDateTokens("logged 2026-07-31T09:30:00Z ok")).toBe("logged [date] ok");
  });
});

describe("scrubDatesDeep", () => {
  it("scrubs date tokens in strings nested in objects and arrays", () => {
    const input = {
      hits: [
        { path: "persona/day-0004.md", snippet: "we met on 2026-07-31 downtown", score: 0.9 },
      ],
      created: "2026-01-02",
    };
    expect(scrubDatesDeep(input)).toEqual({
      hits: [{ path: "persona/day-0004.md", snippet: "we met on [date] downtown", score: 0.9 }],
      created: "[date]",
    });
  });
});

describe("wrapHandlerWithDateScrub", () => {
  const handler = async (_name: string, _input: unknown) => ({ snippet: "on 2026-07-31" });

  it("scrubs dates from tool output when timestamps are off", async () => {
    const wrapped = wrapHandlerWithDateScrub(handler, "off");
    expect(await wrapped("vault_search", {})).toEqual({ snippet: "on [date]" });
  });

  it("passes tool output through unchanged when timestamps are on", async () => {
    const wrapped = wrapHandlerWithDateScrub(handler, "on");
    expect(await wrapped("vault_search", {})).toEqual({ snippet: "on 2026-07-31" });
  });
});
