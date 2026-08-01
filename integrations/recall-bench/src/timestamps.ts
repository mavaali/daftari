// Date-scrubbing for the recall-bench `timestamps` axis.
//
// When an arm runs with timestamps OFF, the answerer must not see calendar
// dates in the tool output it reads. scrubDateTokens removes recognizable
// date tokens from a string, replacing each with a neutral `[date]` marker so
// sentence structure survives while the calendar value is gone.

// An ISO 8601 calendar date, optionally followed by a time part (T- or
// space-separated). The time group requires `HH:MM` so a bare date followed by
// prose ("2026-07-31 downtown") does not over-consume the following words.
const ISO_DATE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?/g;

export function scrubDateTokens(text: string): string {
  return text.replace(ISO_DATE, "[date]");
}

// Recursively scrub date tokens from every string in a JSON-like value
// (strings, arrays, plain objects). Non-string leaves pass through untouched.
// Used to strip dates from tool output before the answerer sees it.
export function scrubDatesDeep(value: unknown): unknown {
  if (typeof value === "string") return scrubDateTokens(value);
  if (Array.isArray(value)) return value.map(scrubDatesDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDatesDeep(v);
    return out;
  }
  return value;
}

type ToolHandler = (name: string, input: unknown) => Promise<unknown>;

// Wraps a tool handler so that, when the timestamps axis is "off", every tool
// output has its date tokens scrubbed before the answerer sees it. When "on",
// the handler is returned untouched (production-faithful, zero overhead).
export function wrapHandlerWithDateScrub(
  handler: ToolHandler,
  timestamps: "on" | "off",
): ToolHandler {
  if (timestamps === "on") return handler;
  return async (name: string, input: unknown): Promise<unknown> =>
    scrubDatesDeep(await handler(name, input));
}
