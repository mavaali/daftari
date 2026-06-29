import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DERIVATION_SYSTEM, derivationUserBody } from "./consensus-cb4-derivation.js";

// The real cortex prompt lives outside the bench's rootDir, so we cannot IMPORT
// it (tsc), but we can READ it as a file at test time to assert our vendored copy
// has not drifted. If daftari edits the prompt, these phrase checks fail -> resync.
const SRC = readFileSync(
  fileURLToPath(new URL("../../../src/consolidate/derivation-prompt.ts", import.meta.url)),
  "utf8",
);

describe("derivation prompt drift-guard", () => {
  // NB: src defines the prompt via multi-line string CONCATENATION ("..." + "..."),
  // so the joined runtime string is NOT a substring of the file — a whole-string
  // SRC.includes(DERIVATION_SYSTEM) is infeasible. Sample enough distinctive phrases
  // (incl. the middle clause) that any wording change trips at least one.
  const SYS_PHRASES = [
    "You assess whether one document's central claim is a load-bearing derivation of",
    "a premise it could not stand without — not a",
    "passing reference, a citation, or mere co-occurrence",
    "Be conservative: when the",
  ];
  const BODY_PHRASES = [
    "is there a load-bearing dependency between these two central claims",
    'Answer "A" ',
    'answer "symmetric".',
  ];

  test("vendored DERIVATION_SYSTEM matches the phrases in the real src", () => {
    for (const p of SYS_PHRASES) {
      expect(SRC).toContain(p);
      expect(DERIVATION_SYSTEM).toContain(p);
    }
  });

  test("vendored derivationUserBody matches the phrases in the real src", () => {
    const body = derivationUserBody("a", "AC", "b", "BC");
    for (const p of BODY_PHRASES) {
      expect(SRC).toContain(p);
      expect(body).toContain(p);
    }
    expect(body).toContain("DOC A (path: a)");
    expect(body).toContain("AC");
  });
});
