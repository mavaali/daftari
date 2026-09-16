// identity.test.ts — TDD test suite for U2: Identity + fingerprint core.
//
// All scenarios from the plan are covered below. Run with:
//   npx vitest run src/board/identity.test.ts

import { describe, expect, it } from "vitest";
import { deriveIdentity, fingerprint, IDENTITY_SCHEME_VERSION } from "./identity.js";
import type {
  FindingSource,
  FindingTarget,
  LintTarget,
  StagedTarget,
  StalenessTarget,
  TensionTarget,
  Tier2Target,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lintTarget(path: string): LintTarget {
  return { kind: "lint", path };
}

function stalenessTarget(path: string): StalenessTarget {
  return { kind: "staleness", path };
}

function tensionTarget(id: string): TensionTarget {
  return { kind: "tension", tensionId: id };
}

function stagedTarget(id: string): StagedTarget {
  return { kind: "staged", stagedActionId: id };
}

function tier2Target(artifact: string, unit: string, edgeClass: string): Tier2Target {
  return { kind: "tier2", artifact, unit, edgeClass };
}

// ---------------------------------------------------------------------------
// 1. IDENTITY_SCHEME_VERSION is exported and non-empty
// ---------------------------------------------------------------------------

describe("IDENTITY_SCHEME_VERSION", () => {
  it("is exported as a non-empty string", () => {
    expect(typeof IDENTITY_SCHEME_VERSION).toBe("string");
    expect(IDENTITY_SCHEME_VERSION.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. deriveIdentity — determinism (R4)
// ---------------------------------------------------------------------------

describe("deriveIdentity — determinism", () => {
  it("same (source, check, target) twice → identical key", () => {
    const source: FindingSource = "lint";
    const check = "staleFiles";
    const target: FindingTarget = lintTarget("notes/foo.md");

    const key1 = deriveIdentity(source, check, target);
    const key2 = deriveIdentity(source, check, target);

    expect(key1).toBe(key2);
  });

  it("staleness target: same inputs twice → identical key", () => {
    const key1 = deriveIdentity("staleness", "orphanFiles", stalenessTarget("notes/bar.md"));
    const key2 = deriveIdentity("staleness", "orphanFiles", stalenessTarget("notes/bar.md"));
    expect(key1).toBe(key2);
  });

  it("tier2 target: same inputs twice → identical key", () => {
    const t = tier2Target("docs/a.md", "core/b.md", "CONSUMES");
    const key1 = deriveIdentity("tier2", "compat", t);
    const key2 = deriveIdentity("tier2", "compat", t);
    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// 3. deriveIdentity — discriminator separates otherwise-identical findings
// ---------------------------------------------------------------------------

describe("deriveIdentity — discriminator", () => {
  it("two findings with same (source, check, target) but different discriminator → distinct keys", () => {
    const source: FindingSource = "lint";
    const check = "brokenRef";
    const target: FindingTarget = lintTarget("notes/foo.md");

    const key1 = deriveIdentity(source, check, target, "ref-A");
    const key2 = deriveIdentity(source, check, target, "ref-B");

    expect(key1).not.toBe(key2);
  });

  it("discriminator present vs absent → distinct keys", () => {
    const source: FindingSource = "lint";
    const check = "brokenRef";
    const target: FindingTarget = lintTarget("notes/foo.md");

    const withDisc = deriveIdentity(source, check, target, "ref-A");
    const withoutDisc = deriveIdentity(source, check, target);

    expect(withDisc).not.toBe(withoutDisc);
  });

  it("same discriminator is deterministic across calls", () => {
    const source: FindingSource = "lint";
    const check = "brokenRef";
    const target: FindingTarget = lintTarget("notes/foo.md");

    const key1 = deriveIdentity(source, check, target, "ref-A");
    const key2 = deriveIdentity(source, check, target, "ref-A");

    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// 4. deriveIdentity — native-id sources (tension / staged)
// ---------------------------------------------------------------------------

describe("deriveIdentity — native-id path (tension)", () => {
  it("tension target → key is 'tension:<tensionId>'", () => {
    const target = tensionTarget("tension-007");
    const key = deriveIdentity("tension", "anyCheck", target);
    expect(key).toBe("tension:tension-007");
  });

  it("tension key stable regardless of check value", () => {
    const target = tensionTarget("tension-007");
    const key1 = deriveIdentity("tension", "checkA", target);
    const key2 = deriveIdentity("tension", "checkB", target);
    expect(key1).toBe(key2);
    expect(key1).toBe("tension:tension-007");
  });

  it("tension key stable regardless of discriminator", () => {
    const target = tensionTarget("tension-007");
    const key1 = deriveIdentity("tension", "check", target);
    const key2 = deriveIdentity("tension", "check", target, "extra");
    // Both should resolve to the native id path, ignoring discriminator
    expect(key1).toBe("tension:tension-007");
    expect(key2).toBe("tension:tension-007");
  });

  it("different tension ids → different keys", () => {
    const key1 = deriveIdentity("tension", "check", tensionTarget("tension-001"));
    const key2 = deriveIdentity("tension", "check", tensionTarget("tension-002"));
    expect(key1).toBe("tension:tension-001");
    expect(key2).toBe("tension:tension-002");
    expect(key1).not.toBe(key2);
  });
});

describe("deriveIdentity — native-id path (staged)", () => {
  it("staged target → key is 'staged:<stagedActionId>'", () => {
    const target = stagedTarget("stage-042");
    const key = deriveIdentity("staged", "pending", target);
    expect(key).toBe("staged:stage-042");
  });

  it("staged key stable regardless of check value", () => {
    const target = stagedTarget("stage-042");
    const key1 = deriveIdentity("staged", "pending", target);
    const key2 = deriveIdentity("staged", "approved", target);
    expect(key1).toBe(key2);
    expect(key1).toBe("staged:stage-042");
  });
});

// ---------------------------------------------------------------------------
// 5. fingerprint vs identity separation (R3)
//
// Changing a volatile field changes the fingerprint but must NOT change
// the identity key. Same target, drifted score → same key, different fp.
// ---------------------------------------------------------------------------

describe("fingerprint vs identity separation (R3)", () => {
  it("same target + drifted score → same identity key, different fingerprint", () => {
    const source: FindingSource = "staleness";
    const check = "ageDays";
    const target: FindingTarget = stalenessTarget("notes/old.md");

    const evidenceV1 = { path: "notes/old.md", ageDays: 10, score: 0.4 };
    const evidenceV2 = { path: "notes/old.md", ageDays: 10, score: 0.9 };

    const key1 = deriveIdentity(source, check, target);
    const key2 = deriveIdentity(source, check, target);
    const fp1 = fingerprint(evidenceV1);
    const fp2 = fingerprint(evidenceV2);

    expect(key1).toBe(key2); // identity unchanged
    expect(fp1).not.toBe(fp2); // fingerprint drifted
  });

  it("evidence changes do not affect identity key (lint source)", () => {
    const source: FindingSource = "lint";
    const check = "staleFiles";
    const target: FindingTarget = lintTarget("notes/a.md");

    const key = deriveIdentity(source, check, target);
    const fp1 = fingerprint({ path: "notes/a.md", extra: "v1" });
    const fp2 = fingerprint({ path: "notes/a.md", extra: "v2" });

    expect(fp1).not.toBe(fp2);
    // key is only derived from (source, check, target) — no evidence involved
    expect(key).toBe(deriveIdentity(source, check, target));
  });
});

// ---------------------------------------------------------------------------
// 6. fingerprint — canonicalization: reordered keys → identical fingerprint
// ---------------------------------------------------------------------------

describe("fingerprint — canonicalization", () => {
  it("evidence objects with reordered keys produce identical fingerprint", () => {
    const ev1 = { path: "notes/a.md", ageDays: 5, score: 0.7 };
    const ev2 = { score: 0.7, ageDays: 5, path: "notes/a.md" };
    const ev3 = { ageDays: 5, path: "notes/a.md", score: 0.7 };

    expect(fingerprint(ev1)).toBe(fingerprint(ev2));
    expect(fingerprint(ev2)).toBe(fingerprint(ev3));
  });

  it("same evidence with identical key order → identical fingerprint (deterministic)", () => {
    const ev = { a: 1, b: "two", c: true };
    expect(fingerprint(ev)).toBe(fingerprint(ev));
  });

  it("different evidence values → different fingerprints", () => {
    const ev1 = { path: "notes/a.md", score: 0.1 };
    const ev2 = { path: "notes/a.md", score: 0.2 };
    expect(fingerprint(ev1)).not.toBe(fingerprint(ev2));
  });

  it("nested evidence with reordered keys → identical fingerprint", () => {
    const ev1 = { outer: { z: 1, a: 2 }, top: "x" };
    const ev2 = { top: "x", outer: { a: 2, z: 1 } };
    expect(fingerprint(ev1)).toBe(fingerprint(ev2));
  });

  it("empty evidence object fingerprint is stable", () => {
    expect(fingerprint({})).toBe(fingerprint({}));
  });
});

// ---------------------------------------------------------------------------
// 7. deriveIdentity — check change alters key (hash-path sources)
// ---------------------------------------------------------------------------

describe("deriveIdentity — check participates in key", () => {
  it("different check values → different keys for lint source", () => {
    const target = lintTarget("notes/foo.md");
    const key1 = deriveIdentity("lint", "staleFiles", target);
    const key2 = deriveIdentity("lint", "orphanFiles", target);
    expect(key1).not.toBe(key2);
  });

  it("different source values → different keys", () => {
    // lint and staleness both use path targets — same path, different source
    const key1 = deriveIdentity("lint", "check", lintTarget("notes/foo.md"));
    const key2 = deriveIdentity("staleness", "check", stalenessTarget("notes/foo.md"));
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// 8. tier2 target — canonicalization is order-stable
// ---------------------------------------------------------------------------

describe("deriveIdentity — tier2 tuple target canonicalization", () => {
  it("tier2 target fields are included in hash deterministically", () => {
    const t1 = tier2Target("docs/a.md", "core/b.md", "CONSUMES");
    const t2 = tier2Target("docs/a.md", "core/b.md", "CONSUMES");
    expect(deriveIdentity("tier2", "compat", t1)).toBe(deriveIdentity("tier2", "compat", t2));
  });

  it("different tier2 artifact → different key", () => {
    const t1 = tier2Target("docs/a.md", "core/b.md", "CONSUMES");
    const t2 = tier2Target("docs/X.md", "core/b.md", "CONSUMES");
    expect(deriveIdentity("tier2", "compat", t1)).not.toBe(deriveIdentity("tier2", "compat", t2));
  });

  it("different tier2 unit → different key", () => {
    const t1 = tier2Target("docs/a.md", "core/b.md", "CONSUMES");
    const t2 = tier2Target("docs/a.md", "core/X.md", "CONSUMES");
    expect(deriveIdentity("tier2", "compat", t1)).not.toBe(deriveIdentity("tier2", "compat", t2));
  });

  it("different tier2 edgeClass → different key", () => {
    const t1 = tier2Target("docs/a.md", "core/b.md", "CONSUMES");
    const t2 = tier2Target("docs/a.md", "core/b.md", "SUPERSEDES");
    expect(deriveIdentity("tier2", "compat", t1)).not.toBe(deriveIdentity("tier2", "compat", t2));
  });
});

// ---------------------------------------------------------------------------
// 9. tier2 collision safety — colon-containing field values must not collide
// ---------------------------------------------------------------------------
//
// CRITICAL 1 regression guard: the old format used `:` as a field delimiter
// inside the tier2 canonical string, which meant two distinct triples whose
// values contain the literal substrings `:edgeClass=` or `:unit=` could
// produce the same canonical string and thus the same identity key.
//
// Example of the collision under the old scheme:
//   artifact="a:edgeClass=b:unit=c", edgeClass="d", unit="e"
//   →  "tier2:artifact=a:edgeClass=b:unit=c:edgeClass=d:unit=e"
//
//   artifact="a",                   edgeClass="b:unit=c:edgeClass=d", unit="e"
//   →  "tier2:artifact=a:edgeClass=b:unit=c:edgeClass=d:unit=e"
//
// Both produce the identical string. After the fix they MUST produce distinct
// identity keys.

describe("deriveIdentity — tier2 collision safety (CRITICAL 1)", () => {
  it("tier2 triples whose field values contain colon-based substrings must not collide", () => {
    // Triple A: artifact contains literal ':edgeClass=...:unit=...' substring
    const tA = tier2Target(
      "a:edgeClass=b:unit=c", // artifact with embedded delimiter-lookalike
      "e",
      "d",
    );

    // Triple B: a distinct triple that produces the same colon-joined string under the OLD scheme
    const tB = tier2Target(
      "a",
      "e",
      "b:unit=c:edgeClass=d", // edgeClass with embedded delimiter-lookalike
    );

    const keyA = deriveIdentity("tier2", "compat", tA);
    const keyB = deriveIdentity("tier2", "compat", tB);

    // These are genuinely different triples — they MUST have different identity keys.
    expect(keyA).not.toBe(keyB);
  });

  it("tier2 field values containing colons are still deterministic", () => {
    const t = tier2Target("vault/a:b.md", "core/c:d.md", "CONSUMES:SHALLOW");
    const key1 = deriveIdentity("tier2", "compat", t);
    const key2 = deriveIdentity("tier2", "compat", t);
    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// 10. fingerprint — property-style: repeated calls with same input → same hash  (was §9)
// ---------------------------------------------------------------------------

describe("fingerprint — repeated-call determinism", () => {
  const inputs: Array<Record<string, unknown>> = [
    {},
    { a: 1 },
    { path: "x", score: 0.5, tags: ["a", "b"] },
    { nested: { deep: { val: true } } },
  ];

  for (const ev of inputs) {
    it(`fingerprint is stable across 5 calls: ${JSON.stringify(ev)}`, () => {
      const results = Array.from({ length: 5 }, () => fingerprint(ev));
      const unique = new Set(results);
      expect(unique.size).toBe(1);
    });
  }
});
