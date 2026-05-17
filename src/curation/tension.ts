// Tension log — the cross-domain-connection half of the curation engine.
//
// A "tension" is a recorded contradiction or pull between two documents: two
// sources that say things which sit uneasily together. Daftari records the
// tension; it never resolves it. Resolution is a human/curatorial act, so an
// entry just carries a Status the curator updates by hand.
//
// The log is a human-readable markdown file, .daftari/tensions.md — append-only
// from this module's side. Each entry is one `## ` block.

import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";

export const DEFAULT_TENSION_STATUS = "unresolved";

export interface TensionEntry {
  date: string; // YYYY-MM-DD
  title: string;
  sourceA: string; // file path
  claimA: string;
  sourceB: string; // file path
  claimB: string;
  status: string;
  loggedBy: string; // agent id
}

export type TensionInput = Omit<TensionEntry, "date" | "status"> & {
  date?: string;
  status?: string;
};

export function tensionsPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "tensions.md");
}

// Renders one entry in the canonical block format. The blank trailing line
// keeps consecutive entries visually separated in the file.
function renderEntry(entry: TensionEntry): string {
  return (
    `## ${entry.date} — ${entry.title}\n` +
    `- **Source A:** ${entry.sourceA} says ${entry.claimA}\n` +
    `- **Source B:** ${entry.sourceB} says ${entry.claimB}\n` +
    `- **Status:** ${entry.status}\n` +
    `- **Logged by:** ${entry.loggedBy}\n`
  );
}

// Appends a tension entry to .daftari/tensions.md. Date defaults to today and
// status to "unresolved" — a freshly logged tension is unresolved by
// definition.
export async function addTension(
  vaultRoot: string,
  input: TensionInput,
): Promise<Result<TensionEntry, Error>> {
  for (const field of ["title", "sourceA", "claimA", "sourceB", "claimB", "loggedBy"] as const) {
    if (typeof input[field] !== "string" || input[field].trim().length === 0) {
      return err(new Error(`addTension requires a non-empty '${field}'`));
    }
  }

  const entry: TensionEntry = {
    date: input.date ?? new Date().toISOString().slice(0, 10),
    title: input.title.trim(),
    sourceA: input.sourceA.trim(),
    claimA: input.claimA.trim(),
    sourceB: input.sourceB.trim(),
    claimB: input.claimB.trim(),
    status: input.status ?? DEFAULT_TENSION_STATUS,
    loggedBy: input.loggedBy.trim(),
  };

  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    // A leading blank line keeps this block separated from the previous one.
    await appendFile(tensionsPath(vaultRoot), `\n${renderEntry(entry)}`);
    return ok(entry);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot append to tension log: ${reason}`));
  }
}

// `- **Source A:** <path> says <claim>` → { path, claim }. The path is
// everything before the first " says "; the claim is the rest.
function parseSourceLine(value: string): { path: string; claim: string } {
  const marker = value.indexOf(" says ");
  if (marker === -1) return { path: value.trim(), claim: "" };
  return {
    path: value.slice(0, marker).trim(),
    claim: value.slice(marker + " says ".length).trim(),
  };
}

function parseBlock(block: string): TensionEntry | null {
  const lines = block.split("\n");
  const header = lines[0]?.replace(/^##\s+/, "") ?? "";
  const headerMatch = header.match(/^(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/);
  if (!headerMatch) return null;

  const entry: TensionEntry = {
    date: headerMatch[1] as string,
    title: (headerMatch[2] as string).trim(),
    sourceA: "",
    claimA: "",
    sourceB: "",
    claimB: "",
    status: DEFAULT_TENSION_STATUS,
    loggedBy: "",
  };

  for (const line of lines.slice(1)) {
    const m = line.match(/^-\s+\*\*(.+?):\*\*\s*(.*)$/);
    if (!m) continue;
    const label = (m[1] as string).toLowerCase();
    const value = m[2] as string;
    if (label === "source a") {
      const s = parseSourceLine(value);
      entry.sourceA = s.path;
      entry.claimA = s.claim;
    } else if (label === "source b") {
      const s = parseSourceLine(value);
      entry.sourceB = s.path;
      entry.claimB = s.claim;
    } else if (label === "status") {
      entry.status = value.trim();
    } else if (label === "logged by") {
      entry.loggedBy = value.trim();
    }
  }
  return entry;
}

// Reads back every logged tension, optionally filtered to one status. A
// missing log is not an error — it just means no tensions have been logged.
export async function listTensions(
  vaultRoot: string,
  status?: string,
): Promise<Result<TensionEntry[], Error>> {
  let raw: string;
  try {
    raw = await readFile(tensionsPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read tension log: ${reason}`));
  }

  const entries: TensionEntry[] = [];
  // Each entry starts at a line beginning with "## ".
  for (const block of raw.split(/(?=^## )/m)) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("## ")) continue;
    const entry = parseBlock(trimmed);
    if (entry) entries.push(entry);
  }

  return ok(status ? entries.filter((e) => e.status === status) : entries);
}
