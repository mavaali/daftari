// Tension log — the cross-domain-connection half of the curation engine.
//
// A "tension" is a recorded contradiction or pull between two documents: two
// sources that say things which sit uneasily together. Daftari records the
// tension; it never resolves it automatically — resolution is a deliberate
// curatorial act recorded through `vault_tension_resolve`.
//
// The log is a human-readable markdown file, .daftari/tensions.md. Each entry
// is one `## ` block. Phase 1 (2026-05-31) added two structural fields to
// each entry:
//
//   - `kind` (temporal | factual | interpretive | unspecified): the taxonomy
//     of the disagreement. `unspecified` is reserved for legacy entries logged
//     before Phase 1; new entries must declare one of the other three.
//   - a `resolution` block: present iff the tension has been closed.
//
// Legacy entries without a `kind` or `id` are read as `kind: "unspecified"`
// and have no id — they cannot be resolved through the tool. They can still
// be edited or re-logged.

import { mkdirSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";

export const DEFAULT_TENSION_STATUS = "unresolved";
export const RESOLVED_TENSION_STATUS = "resolved";

export const TENSION_KINDS = ["temporal", "factual", "interpretive", "unspecified"] as const;
export type TensionKind = (typeof TENSION_KINDS)[number];

// `unspecified` is for legacy entries only — never accepted on a new log.
export const LOGGABLE_TENSION_KINDS = ["temporal", "factual", "interpretive"] as const;
export type LoggableTensionKind = (typeof LOGGABLE_TENSION_KINDS)[number];

export const RESOLUTION_KINDS = ["superseded", "corrected", "accepted", "invalid"] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

export interface TensionResolution {
  resolved_at: string; // ISO 8601
  resolved_by: string; // agent or human identifier
  kind: ResolutionKind;
  rationale?: string;
  references?: string[];
}

export interface TensionEntry {
  id?: string; // assigned at log time; absent for legacy entries
  date: string; // YYYY-MM-DD
  title: string;
  kind: TensionKind;
  sourceA: string;
  claimA: string;
  sourceB: string;
  claimB: string;
  status: string;
  loggedBy: string;
  resolved: boolean;
  resolution?: TensionResolution;
}

export type TensionInput = Omit<
  TensionEntry,
  "date" | "status" | "kind" | "id" | "resolved" | "resolution"
> & {
  date?: string;
  status?: string;
  kind: LoggableTensionKind;
};

export function tensionsPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "tensions.md");
}

function renderResolution(resolution: TensionResolution): string {
  const lines = [
    `- **Resolved at:** ${resolution.resolved_at}`,
    `- **Resolved by:** ${resolution.resolved_by}`,
    `- **Resolution kind:** ${resolution.kind}`,
  ];
  if (resolution.rationale !== undefined && resolution.rationale.length > 0) {
    lines.push(`- **Rationale:** ${resolution.rationale}`);
  }
  if (resolution.references !== undefined && resolution.references.length > 0) {
    lines.push(`- **References:** ${resolution.references.join(", ")}`);
  }
  return lines.join("\n");
}

// Renders one entry in the canonical block format. The blank trailing line
// keeps consecutive entries visually separated in the file. `kind` and `id`
// are written only when set, to preserve legacy entries untouched on read /
// re-render.
function renderEntry(entry: TensionEntry): string {
  const lines = [`## ${entry.date} — ${entry.title}`];
  if (entry.id !== undefined) lines.push(`- **Id:** ${entry.id}`);
  if (entry.kind !== "unspecified") lines.push(`- **Kind:** ${entry.kind}`);
  lines.push(`- **Source A:** ${entry.sourceA} says ${entry.claimA}`);
  lines.push(`- **Source B:** ${entry.sourceB} says ${entry.claimB}`);
  lines.push(`- **Status:** ${entry.status}`);
  lines.push(`- **Logged by:** ${entry.loggedBy}`);
  if (entry.resolution !== undefined) {
    lines.push(renderResolution(entry.resolution));
  }
  return `${lines.join("\n")}\n`;
}

// Assigns the next sequential `tension-NNN` id. Scans existing entries for
// the highest numeric suffix and increments. Legacy entries without an id are
// skipped — their absence is OK; new entries simply pick up after the last
// numbered id ever seen.
function nextTensionId(existing: TensionEntry[]): string {
  let max = 0;
  for (const e of existing) {
    if (e.id === undefined) continue;
    const m = e.id.match(/^tension-(\d+)$/);
    if (!m) continue;
    const n = Number.parseInt(m[1] as string, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const next = max + 1;
  return `tension-${String(next).padStart(3, "0")}`;
}

// Appends a tension entry to .daftari/tensions.md. Auto-assigns an `id` if
// the caller doesn't supply one (the normal path).
export async function addTension(
  vaultRoot: string,
  input: TensionInput,
): Promise<Result<TensionEntry, Error>> {
  for (const field of ["title", "sourceA", "claimA", "sourceB", "claimB", "loggedBy"] as const) {
    if (typeof input[field] !== "string" || input[field].trim().length === 0) {
      return err(new Error(`addTension requires a non-empty '${field}'`));
    }
  }
  if (!(LOGGABLE_TENSION_KINDS as readonly string[]).includes(input.kind)) {
    return err(
      new Error(
        `addTension 'kind' must be one of: ${LOGGABLE_TENSION_KINDS.join(", ")} ` +
          `(unspecified is for legacy entries only)`,
      ),
    );
  }

  const existing = await listTensions(vaultRoot);
  if (!existing.ok) return existing;

  const entry: TensionEntry = {
    id: nextTensionId(existing.value),
    date: input.date ?? new Date().toISOString().slice(0, 10),
    title: input.title.trim(),
    kind: input.kind,
    sourceA: input.sourceA.trim(),
    claimA: input.claimA.trim(),
    sourceB: input.sourceB.trim(),
    claimB: input.claimB.trim(),
    status: input.status ?? DEFAULT_TENSION_STATUS,
    loggedBy: input.loggedBy.trim(),
    resolved: false,
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

function parseReferences(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBlock(block: string): TensionEntry | null {
  const lines = block.split("\n");
  const header = lines[0]?.replace(/^##\s+/, "") ?? "";
  const headerMatch = header.match(/^(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/);
  if (!headerMatch) return null;

  const entry: TensionEntry = {
    date: headerMatch[1] as string,
    title: (headerMatch[2] as string).trim(),
    kind: "unspecified",
    sourceA: "",
    claimA: "",
    sourceB: "",
    claimB: "",
    status: DEFAULT_TENSION_STATUS,
    loggedBy: "",
    resolved: false,
  };

  // Resolution fields are accumulated separately so the block can be assembled
  // (or skipped) in one place at the end.
  let resolvedAt: string | undefined;
  let resolvedBy: string | undefined;
  let resolutionKind: ResolutionKind | undefined;
  let rationale: string | undefined;
  let references: string[] | undefined;

  for (const line of lines.slice(1)) {
    const m = line.match(/^-\s+\*\*(.+?):\*\*\s*(.*)$/);
    if (!m) continue;
    const label = (m[1] as string).toLowerCase();
    const value = m[2] as string;
    if (label === "id") {
      entry.id = value.trim();
    } else if (label === "kind") {
      const k = value.trim();
      if ((TENSION_KINDS as readonly string[]).includes(k)) {
        entry.kind = k as TensionKind;
      }
    } else if (label === "source a") {
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
    } else if (label === "resolved at") {
      resolvedAt = value.trim();
    } else if (label === "resolved by") {
      resolvedBy = value.trim();
    } else if (label === "resolution kind") {
      const rk = value.trim();
      if ((RESOLUTION_KINDS as readonly string[]).includes(rk)) {
        resolutionKind = rk as ResolutionKind;
      }
    } else if (label === "rationale") {
      rationale = value.trim();
    } else if (label === "references") {
      references = parseReferences(value);
    }
  }

  if (resolvedAt !== undefined && resolvedBy !== undefined && resolutionKind !== undefined) {
    const resolution: TensionResolution = {
      resolved_at: resolvedAt,
      resolved_by: resolvedBy,
      kind: resolutionKind,
    };
    if (rationale !== undefined && rationale.length > 0) resolution.rationale = rationale;
    if (references !== undefined && references.length > 0) resolution.references = references;
    entry.resolution = resolution;
    entry.resolved = true;
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

// Records a resolution on an existing tension. Errors if the id isn't found,
// or if the tension is already resolved. The whole tensions.md file is read,
// the matched entry is updated, and the file is rewritten in place. The
// leading-blank-line convention of the append path is preserved.
export async function resolveTension(
  vaultRoot: string,
  id: string,
  resolution: TensionResolution,
): Promise<Result<TensionEntry, Error>> {
  let raw: string;
  try {
    raw = await readFile(tensionsPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return err(new Error(`tension not found: ${id}`));
    }
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read tension log: ${reason}`));
  }

  // Split the file into a leading preamble (anything before the first
  // entry) plus a list of entry blocks. Reassembled the same way.
  const segments = raw.split(/(?=^## )/m);
  const preamble = segments[0]?.startsWith("## ") ? "" : (segments[0] ?? "");
  const blocks = segments.filter((s) => s.startsWith("## "));

  let matched: TensionEntry | null = null;
  let matchIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    const entry = parseBlock((blocks[i] as string).trim());
    if (!entry || entry.id !== id) continue;
    matched = entry;
    matchIdx = i;
    break;
  }

  if (!matched || matchIdx === -1) {
    return err(new Error(`tension not found: ${id}`));
  }
  if (matched.resolved) {
    return err(new Error(`tension is already resolved: ${id}`));
  }

  const updated: TensionEntry = {
    ...matched,
    status: RESOLVED_TENSION_STATUS,
    resolved: true,
    resolution,
  };

  // Preserve the leading blank line of the original block: every block in the
  // file (except possibly the first) is preceded by one blank line. The split
  // captures the "## " marker at the start of each block, so we re-add the
  // blank-line prefix on rewrite.
  const rewritten = blocks.map((b, i) => {
    if (i !== matchIdx) return b;
    // The new block content includes its trailing newline.
    const rendered = renderEntry(updated);
    // Preserve the same separator the original block had: count leading
    // newlines on the original to keep the file's spacing stable.
    const leading = (b.match(/^\n*/)?.[0] ?? "").length;
    return `${"\n".repeat(leading)}${rendered}`;
  });

  const next = preamble + rewritten.join("");

  try {
    await writeFile(tensionsPath(vaultRoot), next);
    return ok(updated);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot write tension log: ${reason}`));
  }
}
