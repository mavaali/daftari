import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Generates the MAV-161 supersession bench corpus: a native-shape vault where
// every fact family has a v1→v2→v3 `superseded_by` chain and the STALE
// versions are lexically stronger for the query than the current head — the
// exact RB failure shape (the day-6 Condor estimate outranking the day-28
// revision). The RB journal has no superseded_by chains at all, so the
// suppression lever needs this surface to be measured deterministically.
//
// Construction (index-derived, no randomness):
//   - FAMILIES chains: v1 and v2 repeat the family's query token heavily and
//     carry the OLD value token; v3 (the head) mentions the query token once
//     and carries the CURRENT value token — ranked retrieval finds v1/v2
//     first, exactly the distractor-above-truth inversion the 2026-06-21
//     placebo showed is hallucinogenic.
//   - PLAIN unsuperseded doc pairs, with span queries over them — the guard
//     set: suppression must leave their recall untouched.
//
// queries.jsonl types:
//   stale-trap  — relevant = [the head]; distractors = v1, v2
//   span-guard  — relevant = the two plain docs of the pair

const OUT = process.env.SUPPRESS_OUT ?? "/tmp/suppression";
const VAULT = join(OUT, "vault");
const QFILE = join(OUT, "queries.jsonl");
const FAMILIES = 30;
const PLAIN_PAIRS = 10;
const CREATED = ["2026-02-01", "2026-03-01", "2026-04-01"]; // v1, v2, v3

const ix = (n) => String(n).padStart(3, "0");
const vPath = (i, v) => `corpus/fact-${ix(i)}-v${v}.md`;
const plainPath = (k, j) => `corpus/plain-${ix(k)}${j}.md`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(VAULT, "corpus"), { recursive: true });

const fm = (title, created, supersededBy) =>
  `---\n` +
  `title: "${title}"\n` +
  `domain: accumulation\n` +
  `collection: corpus\n` +
  `status: canonical\n` +
  `confidence: high\n` +
  `created: ${created}\n` +
  `updated: ${created}\n` +
  `updated_by: "agent:suppression-gen"\n` +
  `provenance: direct\n` +
  `sources: []\n` +
  `superseded_by: ${supersededBy === null ? "null" : supersededBy}\n` +
  `tags: [suppression]\n` +
  `---\n\n`;

for (let i = 0; i < FAMILIES; i++) {
  const q = `facttok${ix(i)}`;
  const oldVal = `oldval${ix(i)}`;
  const curVal = `curval${ix(i)}`;
  // v1/v2: the query token saturates the body (high BM25); old value inside.
  writeFileSync(
    join(VAULT, vPath(i, 1)),
    fm(`Initial ${q} estimate`, CREATED[0], vPath(i, 2)) +
      `First pass on ${q}: the working figure is ${oldVal}. The ${q} range was sketched ` +
      `from early inputs, and the team agreed to treat ${q} = ${oldVal} as provisional ` +
      `until diligence lands. Revisit ${q} next cycle.\n`,
  );
  writeFileSync(
    join(VAULT, vPath(i, 2)),
    fm(`Refined ${q} estimate`, CREATED[1], vPath(i, 3)) +
      `Second pass on ${q}: still carrying ${oldVal} for ${q} with minor adjustments. ` +
      `The ${q} assumptions were rechecked; ${q} holds at ${oldVal} pending final review.\n`,
  );
  // v3 head: current value, single weak mention — ranks below its ancestors.
  writeFileSync(
    join(VAULT, vPath(i, 3)),
    fm(`Final figure ${curVal}`, CREATED[2], null) +
      `After diligence the figure settled at ${curVal}, replacing the earlier ` +
      `provisional number (${q} thread closed).\n`,
  );
}
for (let k = 0; k < PLAIN_PAIRS; k++) {
  for (const j of [0, 1]) {
    const tok = `plaintok${ix(k)}${j}`;
    writeFileSync(
      join(VAULT, plainPath(k, j)),
      fm(`Note ${tok}`, "2026-03-15", null) +
        `Standalone observation ${tok} about topic plainshared${ix(k)}: recorded once, ` +
        `never revised, part of the ${`plainshared${ix(k)}`} pair.\n`,
    );
  }
}

const queries = [];
for (let i = 0; i < FAMILIES; i++) {
  queries.push({
    id: `stale-trap-${ix(i)}`,
    type: "stale-trap",
    query: `facttok${ix(i)} working figure estimate`,
    relevant: [vPath(i, 3)],
    distractors: [vPath(i, 1), vPath(i, 2)],
  });
}
for (let k = 0; k < PLAIN_PAIRS; k++) {
  queries.push({
    id: `span-guard-${ix(k)}`,
    type: "span-guard",
    query: `plainshared${ix(k)} observation`,
    relevant: [plainPath(k, 0), plainPath(k, 1)],
    distractors: [],
  });
}
writeFileSync(QFILE, queries.map((q) => JSON.stringify(q)).join("\n") + "\n");

const docCount = FAMILIES * 3 + PLAIN_PAIRS * 2;
console.log(
  `gen-supersession-vault: ${docCount} docs (${FAMILIES} chains, ${PLAIN_PAIRS} plain pairs), ` +
    `${queries.length} queries -> ${OUT}`,
);
