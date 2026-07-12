// Top-level entry for `daftari court` — the Tension Court.
//
//   daftari court                 print the docket (open tensions, briefed
//                                 and ranked, with precedents)
//   daftari court --tension <id>  one case's full brief
//   daftari court rule <id> …     record a ruling (wraps the same
//                                 resolveTension write path as
//                                 vault_tension_resolve)
//
// The docket is read-only. `rule` is the one write, and it is the human act
// the whole curation design funnels toward: the loop proposes, lint nags,
// the docket briefs — a person rules. Rulings become precedent for future
// dockets automatically, because a precedent IS a resolved tension.
//
// Exit codes (the audit convention):
//   0 — report produced / ruling recorded
//   2 — config/usage error (unknown id, bad kind, missing args)
//   3 — runtime error (IO failure)

import { writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import {
  RESOLUTION_KINDS,
  type ResolutionKind,
  resolveTension,
  type TensionResolution,
} from "../curation/tension.js";
import { buildDocket } from "./docket.js";
import { type CourtReport, renderJson, renderMarkdown } from "./report.js";

const HELP = `daftari court — the docket of open tensions, and the bench to rule on them.

Usage:
  daftari court [--vault <path>] [--tension <id>] [--output <md>] [--output-json <json>]
  daftari court rule <id> --kind <kind> [--rationale <text>] [--references <a,b>] [--by <identity>]
  daftari court --help

The docket briefs every open tension in priority order (stale first, then by
blast radius): both sides' claims and the present state of their documents,
the downstream stakes, cluster membership, and precedents — past rulings on
disputes that shared a document, a collection pair, or a kind. The court
retrieves precedent; it never decides.

Ruling:
  daftari court rule <id> --kind superseded|corrected|accepted|invalid
    --kind        How the dispute closed. superseded/corrected: one side won
                  by discovery. accepted: both stand, disagreement is a
                  stable feature. invalid: mis-logged.
    --rationale   Why — recorded verbatim, quoted by future dockets as
                  precedent. Strongly encouraged.
    --references  Comma-separated supporting paths/ids.
    --by          Identity recorded as resolved_by
                  (default: human:<os username>).

A ruling never edits the disputed documents. It records the closure in the
tension log; acting on it (deprecate, supersede) remains a separate,
deliberate write.

Exit codes:
  0 — report produced / ruling recorded
  2 — config/usage error (unknown id, bad kind, missing args)
  3 — runtime error (IO failure)
`;

function readStringArg(argv: string[], flag: string): string | undefined {
  const raw = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (raw === undefined) return undefined;
  const idx = argv.indexOf(raw);
  return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : argv[idx + 1];
}

const VALUE_FLAGS = [
  "--vault",
  "--tension",
  "--output",
  "--output-json",
  "--kind",
  "--rationale",
  "--references",
  "--by",
];

function findPositionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) continue;
    const prev = i > 0 ? argv[i - 1] : undefined;
    if (prev !== undefined && VALUE_FLAGS.includes(prev)) continue;
    out.push(a);
  }
  return out;
}

async function runRule(argv: string[], vaultRoot: string): Promise<number> {
  const positionals = findPositionals(argv);
  // positionals[0] is "rule" itself.
  const id = positionals[1];
  if (!id) {
    process.stderr.write("daftari court: rule requires a tension id\n");
    return 2;
  }

  const kind = readStringArg(argv, "--kind");
  if (!kind || !(RESOLUTION_KINDS as readonly string[]).includes(kind)) {
    process.stderr.write(
      `daftari court: rule requires --kind, one of: ${RESOLUTION_KINDS.join(", ")}\n`,
    );
    return 2;
  }

  const resolution: TensionResolution = {
    resolved_at: new Date().toISOString(),
    resolved_by: readStringArg(argv, "--by") ?? `human:${userInfo().username}`,
    kind: kind as ResolutionKind,
  };
  const rationale = readStringArg(argv, "--rationale")?.trim();
  if (rationale) resolution.rationale = rationale;
  const references = readStringArg(argv, "--references")
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (references && references.length > 0) resolution.references = references;

  const ruled = await resolveTension(vaultRoot, id, resolution);
  if (!ruled.ok) {
    process.stderr.write(`daftari court: ${ruled.error.message}\n`);
    return 2;
  }

  process.stdout.write(
    `Ruled: “${ruled.value.title}” → ${kind} (by ${resolution.resolved_by})\n` +
      `The ruling is now precedent — future dockets on similar disputes will cite it.\n` +
      (rationale
        ? ""
        : `No --rationale was recorded. Precedent without reasoning is hard to follow; consider including one next time.\n`),
  );
  return 0;
}

export async function runCourt(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const vaultRoot = resolve(readStringArg(argv, "--vault") ?? ".");

  if (findPositionals(argv)[0] === "rule") {
    return runRule(argv, vaultRoot);
  }

  const docket = await buildDocket(vaultRoot);
  if (!docket.ok) {
    process.stderr.write(`daftari court: ${docket.error.message}\n`);
    return 3;
  }

  const briefId = readStringArg(argv, "--tension") ?? null;
  const report: CourtReport = {
    generatedAt: new Date().toISOString(),
    vault: vaultRoot,
    docket: docket.value,
    briefId,
  };

  const md = renderMarkdown(report);
  const outputMd = readStringArg(argv, "--output");
  const outputJson = readStringArg(argv, "--output-json");
  try {
    if (outputMd) {
      await writeFile(resolve(outputMd), md, "utf-8");
    } else {
      process.stdout.write(md);
    }
    if (outputJson) {
      await writeFile(resolve(outputJson), renderJson(report), "utf-8");
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`daftari court: write failed: ${reason}\n`);
    return 3;
  }

  return 0;
}
