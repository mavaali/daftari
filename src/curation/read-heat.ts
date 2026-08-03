// Read-heat aggregator (Tension Triage Card, Story 2). A pure reduce over the
// read log giving per-document read frequency + recency, so a tension on a hot
// doc can be told from one in a dead corner.
//
// The `instrumented` flag guards against a false-cold reading: a doc that
// predates the read log's earliest entry may have been read before logging
// existed, so its count of 0 is NOT evidence it is untouched. Consumers must
// not read `instrumented: false` as "never read". Same discipline as the read
// log itself (absent telemetry is uninstrumented, not zero).

import type { ReadLogEntry } from "./read-log.js";

export interface ReadHeat {
  // Reads served within the window.
  count: number;
  // ISO timestamp of the most recent in-window read, or null if none.
  last_read: string | null;
  // false when the doc may predate the read log — its count is not trustworthy
  // as a signal of coldness.
  instrumented: boolean;
}

export interface ReadHeatDoc {
  file: string;
  // Earliest-known date of the doc (frontmatter `created`, else provenance).
  // Omitted when unknown, which is treated conservatively (uninstrumented).
  created?: string;
}

export interface ReadHeatOptions {
  now?: Date;
  windowDays?: number;
}

const DEFAULT_WINDOW_DAYS = 30;

// Per requested doc, its read heat over the window. Docs with no reads still
// appear (count 0); a doc absent from the log cannot be derived from entries
// alone, which is why the caller passes the doc list.
export function computeReadHeat(
  entries: ReadLogEntry[],
  docs: ReadHeatDoc[],
  options: ReadHeatOptions = {},
): Map<string, ReadHeat> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cutoffMs = now.getTime() - windowDays * 86_400_000;

  // Earliest served read across the whole log — the instant logging began.
  // Undefined when the log is empty, in which case nothing was captured.
  let logEarliestMs: number | undefined;
  for (const e of entries) {
    const ms = Date.parse(e.timestamp);
    if (Number.isNaN(ms)) continue;
    if (logEarliestMs === undefined || ms < logEarliestMs) logEarliestMs = ms;
  }

  const result = new Map<string, ReadHeat>();
  for (const doc of docs) {
    let count = 0;
    let lastReadMs = -Infinity;
    let lastRead: string | null = null;
    for (const e of entries) {
      if (e.file !== doc.file) continue;
      const ms = Date.parse(e.timestamp);
      if (Number.isNaN(ms) || ms < cutoffMs) continue;
      count += 1;
      if (ms > lastReadMs) {
        lastReadMs = ms;
        lastRead = e.timestamp;
      }
    }

    const instrumented =
      logEarliestMs !== undefined &&
      doc.created !== undefined &&
      Date.parse(doc.created) >= logEarliestMs;

    result.set(doc.file, { count, last_read: lastRead, instrumented });
  }
  return result;
}
