import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, mintLeaseHolder, openLockDb, releaseLock } from "../../src/access/locks.js";
import {
  addTension,
  agingTier,
  CALLER_RESOLUTION_KINDS,
  isTensionLeaseContention,
  LOGGABLE_TENSION_KINDS,
  listTensions,
  RESOLUTION_KINDS,
  resolveTension,
  retryOnTensionLease,
  STALE_TIER_LINT_COPY,
  TENSIONS_LOCK_KEY,
  type TensionEntry,
  tensionsPath,
} from "../../src/curation/tension.js";
import { err, ok } from "../../src/frontmatter/types.js";
import { vaultTensionLog } from "../../src/tools/curation.js";

const sampleInput = {
  title: "Pooled vs consumption billing",
  sourceA: "pricing/cirrus-capacity-tiers.md",
  claimA: "pooled capacity is billed whether used or not",
  sourceB: "pricing/serverless-cost-predictability.md",
  claimB: "serverless billing tracks actual consumption",
  loggedBy: "agent:claude-code",
  kind: "interpretive" as const,
};

describe("tension", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-tension-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("returns an empty list when nothing has been logged", async () => {
    const result = await listTensions(vault);
    expect(result.ok && result.value).toEqual([]);
  });

  it("allocates unique ids under concurrent logging (#235 contention path)", async () => {
    // Id allocation + append run in one synchronous critical section
    // (mirroring stageAction), so concurrent addTension calls — the
    // inter-proposal conflict check firing from contending stagings — never
    // mint the same tension-NNN id. Before the fix, the async
    // read-then-append gap let every concurrent call read the same log
    // state and collide on one id.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        addTension(vault, { ...sampleInput, title: `Concurrent ${i}` }),
      ),
    );
    const ids = results.map((r) => (r.ok ? r.value.id : "ERR"));
    expect(new Set(ids).size).toBe(5);
    expect(ids).not.toContain("ERR");

    const logged = await listTensions(vault);
    expect(logged.ok && logged.value).toHaveLength(5);
  });

  it("accepts an inter-proposal tension only as a self-tension (#235)", async () => {
    const arbitrary = await addTension(vault, {
      ...sampleInput,
      kind: "inter-proposal" as const,
    });
    expect(arbitrary.ok).toBe(false);
    if (arbitrary.ok) return;
    expect(arbitrary.error.message).toContain("self-tension");

    const self = await addTension(vault, {
      ...sampleInput,
      kind: "inter-proposal" as const,
      sourceA: "pricing/contested.md",
      sourceB: "pricing/contested.md",
    });
    expect(self.ok).toBe(true);
  });

  it("appends a tension with default date and unresolved status", async () => {
    const added = await addTension(vault, sampleInput);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.status).toBe("unresolved");
    expect(added.value.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The file holds the canonical block format.
    const raw = readFileSync(tensionsPath(vault), "utf-8");
    expect(raw).toContain(`## ${added.value.date} — ${sampleInput.title}`);
    expect(raw).toContain(`- **Source A:** ${sampleInput.sourceA} says ${sampleInput.claimA}`);
    expect(raw).toContain("- **Status:** unresolved");
    expect(raw).toContain("- **Logged by:** agent:claude-code");
  });

  it("round-trips appended entries through listTensions", async () => {
    await addTension(vault, sampleInput);
    await addTension(vault, {
      ...sampleInput,
      title: "Second tension",
      date: "2026-05-10",
    });

    const result = await listTensions(vault);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    const second = result.value.find((e) => e.title === "Second tension");
    expect(second?.date).toBe("2026-05-10");
    expect(second?.sourceA).toBe(sampleInput.sourceA);
    expect(second?.claimB).toBe(sampleInput.claimB);
    expect(second?.loggedBy).toBe("agent:claude-code");
  });

  it("filters listTensions by status", async () => {
    await addTension(vault, sampleInput);
    await addTension(vault, {
      ...sampleInput,
      title: "Already settled",
      status: "resolved",
    });

    const unresolved = await listTensions(vault, "unresolved");
    expect(unresolved.ok && unresolved.value).toHaveLength(1);

    const resolved = await listTensions(vault, "resolved");
    expect(resolved.ok && resolved.value).toHaveLength(1);
    if (resolved.ok) expect(resolved.value[0]?.title).toBe("Already settled");
  });

  it("rejects an entry missing a required field", async () => {
    const result = await addTension(vault, { ...sampleInput, title: "  " });
    expect(result.ok).toBe(false);
  });

  // --- Phase 1 (tension graph plan) -----------------------------------------

  describe("Phase 1: kind taxonomy", () => {
    it("assigns sequential ids and persists the kind field", async () => {
      const first = await addTension(vault, sampleInput);
      const second = await addTension(vault, {
        ...sampleInput,
        title: "Second tension",
        kind: "factual",
      });
      expect(first.ok && first.value.id).toBe("tension-001");
      expect(second.ok && second.value.id).toBe("tension-002");

      const raw = readFileSync(tensionsPath(vault), "utf-8");
      expect(raw).toContain("- **Id:** tension-001");
      expect(raw).toContain("- **Kind:** interpretive");
      expect(raw).toContain("- **Kind:** factual");
    });

    it("rejects a kind not in the loggable set", async () => {
      // unspecified is a legacy-only state; new logs must declare a real kind.
      const unspec = await addTension(vault, {
        ...sampleInput,
        kind: "unspecified" as unknown as "factual",
      });
      expect(unspec.ok).toBe(false);

      const bogus = await addTension(vault, {
        ...sampleInput,
        kind: "made-up" as unknown as "factual",
      });
      expect(bogus.ok).toBe(false);
    });

    it("reads a legacy entry (no kind, no id) as kind=unspecified", async () => {
      // Pre-Phase-1 entries on disk look exactly like the original block format.
      mkdirSync(join(vault, ".daftari"), { recursive: true });
      const legacy =
        "\n## 2026-04-01 — Legacy tension\n" +
        "- **Source A:** legacy/a.md says A says X\n" +
        "- **Source B:** legacy/b.md says B says Y\n" +
        "- **Status:** unresolved\n" +
        "- **Logged by:** agent:legacy\n";
      writeFileSync(tensionsPath(vault), legacy, "utf-8");

      const list = await listTensions(vault);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.value).toHaveLength(1);
      const [entry] = list.value;
      expect(entry?.kind).toBe("unspecified");
      expect(entry?.id).toBeUndefined();
      expect(entry?.resolved).toBe(false);
    });

    it("does not write 'kind: unspecified' back to the file when re-rendering", async () => {
      // Sanity check: legacy entries should round-trip untouched on read. The
      // append path never re-renders existing entries, so this test just
      // confirms the file on disk is unchanged by listTensions.
      mkdirSync(join(vault, ".daftari"), { recursive: true });
      const legacy =
        "\n## 2026-04-01 — Legacy tension\n" +
        "- **Source A:** legacy/a.md says X\n" +
        "- **Source B:** legacy/b.md says Y\n" +
        "- **Status:** unresolved\n" +
        "- **Logged by:** agent:legacy\n";
      writeFileSync(tensionsPath(vault), legacy, "utf-8");

      await listTensions(vault);
      const after = readFileSync(tensionsPath(vault), "utf-8");
      expect(after).toBe(legacy);
      expect(after).not.toContain("Kind: unspecified");
    });
  });

  describe("Phase 1: resolveTension", () => {
    it("records a resolution with required fields", async () => {
      const logged = await addTension(vault, { ...sampleInput, kind: "factual" });
      expect(logged.ok).toBe(true);
      if (!logged.ok) return;

      const resolved = await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-06-15T09:30:00Z",
        resolved_by: "human:mihir",
        kind: "corrected",
        rationale: "Vendor portal confirmed",
        references: ["pricing/canonical.md"],
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value.resolved).toBe(true);
      expect(resolved.value.status).toBe("resolved");
      expect(resolved.value.resolution?.kind).toBe("corrected");

      // Round-trip through the file.
      const list = await listTensions(vault);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const [entry] = list.value;
      expect(entry?.resolved).toBe(true);
      expect(entry?.resolution?.resolved_at).toBe("2026-06-15T09:30:00Z");
      expect(entry?.resolution?.resolved_by).toBe("human:mihir");
      expect(entry?.resolution?.kind).toBe("corrected");
      expect(entry?.resolution?.rationale).toBe("Vendor portal confirmed");
      expect(entry?.resolution?.references).toEqual(["pricing/canonical.md"]);
    });

    it("errors when the id is not found", async () => {
      const result = await resolveTension(vault, "tension-999", {
        resolved_at: "2026-06-15T09:30:00Z",
        resolved_by: "human:mihir",
        kind: "invalid",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/not found/);
    });

    it("errors when the tension is already resolved", async () => {
      const logged = await addTension(vault, { ...sampleInput, kind: "factual" });
      if (!logged.ok) return;
      await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-06-15T09:30:00Z",
        resolved_by: "human:mihir",
        kind: "corrected",
      });
      const second = await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-06-16T09:30:00Z",
        resolved_by: "human:mihir",
        kind: "accepted",
      });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.message).toMatch(/already resolved/);
    });

    it("preserves other entries when resolving one of many", async () => {
      const a = await addTension(vault, { ...sampleInput, kind: "temporal" });
      const b = await addTension(vault, {
        ...sampleInput,
        title: "Second",
        kind: "factual",
      });
      const c = await addTension(vault, {
        ...sampleInput,
        title: "Third",
        kind: "interpretive",
      });
      if (!a.ok || !b.ok || !c.ok) return;

      await resolveTension(vault, b.value.id as string, {
        resolved_at: "2026-06-15T09:30:00Z",
        resolved_by: "human:mihir",
        kind: "corrected",
      });

      const list = await listTensions(vault);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.value).toHaveLength(3);
      expect(list.value.find((e) => e.title === "Second")?.resolved).toBe(true);
      expect(list.value.find((e) => e.title === sampleInput.title)?.resolved).toBe(false);
      expect(list.value.find((e) => e.title === "Third")?.resolved).toBe(false);
    });
  });

  describe("S3-b: tension-log RMW lease", () => {
    // The lost-update regression. resolveTension is async: readFile → rewrite
    // → writeFile, with a real await window between the read and the write
    // (tension.ts:404/460). Two concurrent resolutions can both read the
    // same original content before either writes back; whichever writes
    // last silently discards the other's resolution — but that caller's
    // resolveTension call already returned `ok: true`. The invariant that
    // must never be violated: every call that reports success must be
    // reflected on disk. This is order-independent (unlike "who wins"), so
    // it is a reliable RED test against today's unleased RMW.
    it("never reports a phantom success under concurrent resolveTension calls", async () => {
      const a = await addTension(vault, { ...sampleInput, title: "First" });
      const b = await addTension(vault, { ...sampleInput, title: "Second" });
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;

      const [ra, rb] = await Promise.all([
        resolveTension(vault, a.value.id as string, {
          resolved_at: "2026-08-08",
          resolved_by: "agent:a",
          kind: "accepted",
        }),
        resolveTension(vault, b.value.id as string, {
          resolved_at: "2026-08-08",
          resolved_by: "agent:b",
          kind: "accepted",
        }),
      ]);

      const logged = await listTensions(vault);
      expect(logged.ok).toBe(true);
      if (!logged.ok) return;

      for (const [id, r] of [
        [a.value.id, ra],
        [b.value.id, rb],
      ] as const) {
        if (r.ok) {
          const onDisk = logged.value.find((t) => t.id === id);
          expect(onDisk?.resolved).toBe(true);
        }
      }
    });

    it("fails fast when addTension is attempted while `__tensions__` is held", async () => {
      const lockDbResult = openLockDb(vault);
      expect(lockDbResult.ok).toBe(true);
      if (!lockDbResult.ok) return;
      const lockDb = lockDbResult.value;
      const held = acquireLock(lockDb, TENSIONS_LOCK_KEY, mintLeaseHolder("agent:other"));
      expect(held.ok).toBe(true);

      const blocked = await addTension(vault, sampleInput);
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.error.message).toContain("locked");

      const logged = await listTensions(vault);
      expect(logged.ok && logged.value).toEqual([]);
      lockDb.close();
    });

    it("fails fast when resolveTension is attempted while `__tensions__` is held, leaving the file untouched", async () => {
      const logged = await addTension(vault, sampleInput);
      expect(logged.ok).toBe(true);
      if (!logged.ok) return;
      const before = readFileSync(tensionsPath(vault), "utf-8");

      const lockDbResult = openLockDb(vault);
      expect(lockDbResult.ok).toBe(true);
      if (!lockDbResult.ok) return;
      const lockDb = lockDbResult.value;
      const held = acquireLock(lockDb, TENSIONS_LOCK_KEY, mintLeaseHolder("agent:other"));
      expect(held.ok).toBe(true);

      const blocked = await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-08-08",
        resolved_by: "agent:a",
        kind: "accepted",
      });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.error.message).toContain("locked");

      const after = readFileSync(tensionsPath(vault), "utf-8");
      expect(after).toBe(before);
      lockDb.close();
    });

    it("releases the `__tensions__` lease on every early-error path", async () => {
      const logged = await addTension(vault, sampleInput);
      expect(logged.ok).toBe(true);
      if (!logged.ok) return;

      // Path 1: tension not found.
      const notFound = await resolveTension(vault, "tension-999", {
        resolved_at: "2026-08-08",
        resolved_by: "agent:a",
        kind: "accepted",
      });
      expect(notFound.ok).toBe(false);

      let probeResult = openLockDb(vault);
      expect(probeResult.ok).toBe(true);
      if (!probeResult.ok) return;
      let probe = acquireLock(probeResult.value, TENSIONS_LOCK_KEY, mintLeaseHolder("agent:probe"));
      expect(probe.ok).toBe(true);
      if (probe.ok) releaseLock(probeResult.value, TENSIONS_LOCK_KEY, probe.value.holder);
      probeResult.value.close();

      // Path 2: already resolved.
      await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-08-08",
        resolved_by: "agent:a",
        kind: "accepted",
      });
      const alreadyResolved = await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-08-09",
        resolved_by: "agent:b",
        kind: "accepted",
      });
      expect(alreadyResolved.ok).toBe(false);

      probeResult = openLockDb(vault);
      expect(probeResult.ok).toBe(true);
      if (!probeResult.ok) return;
      probe = acquireLock(probeResult.value, TENSIONS_LOCK_KEY, mintLeaseHolder("agent:probe2"));
      expect(probe.ok).toBe(true);
      probeResult.value.close();
    });

    it("does not block addTension while a file lease is held on an unrelated path, and vice versa (R4)", async () => {
      const lockDbResult = openLockDb(vault);
      expect(lockDbResult.ok).toBe(true);
      if (!lockDbResult.ok) return;
      const lockDb = lockDbResult.value;
      const fileLease = acquireLock(lockDb, "pricing/a.md", mintLeaseHolder("agent:writer"));
      expect(fileLease.ok).toBe(true);

      const added = await addTension(vault, sampleInput);
      expect(added.ok).toBe(true);

      const tensionLease = acquireLock(
        lockDb,
        TENSIONS_LOCK_KEY,
        mintLeaseHolder("agent:tensioner"),
      );
      expect(tensionLease.ok).toBe(true);
      lockDb.close();
    });
  });
});

// --- Phase 4 (aging) suites ----------------------------------------------
//
// Lives outside the Phase 1 describe so the fixtures and clock are scoped
// tightly. `agingTier` is a pure function — these tests pass synthetic
// entries directly rather than round-tripping through the file system.

const buildEntry = (overrides: Partial<TensionEntry>): TensionEntry => ({
  id: "tension-001",
  date: "2026-01-01",
  title: "test",
  kind: "factual",
  sourceA: "a.md",
  claimA: "A",
  sourceB: "b.md",
  claimB: "B",
  status: "unresolved",
  loggedBy: "agent:claude-code",
  resolved: false,
  ...overrides,
});

describe("agingTier (Phase 4)", () => {
  const NOW = new Date("2026-06-01T00:00:00Z");

  it("returns null for unspecified entries regardless of age", () => {
    // 200 days ago — would be stale if it were aged.
    const e = buildEntry({ kind: "unspecified", date: "2025-11-13" });
    expect(agingTier(e, NOW)).toBeNull();
  });

  it("returns null when the resolution kind is accepted", () => {
    const e = buildEntry({
      kind: "interpretive",
      date: "2025-11-13", // 200 days ago
      resolved: true,
      resolution: {
        resolved_at: "2026-02-01T00:00:00Z",
        resolved_by: "mihir",
        kind: "accepted",
      },
    });
    expect(agingTier(e, NOW)).toBeNull();
  });

  it("returns fresh for an entry ≤ 30 days old", () => {
    // 10 days before NOW.
    expect(agingTier(buildEntry({ date: "2026-05-22" }), NOW)).toBe("fresh");
    // Same day.
    expect(agingTier(buildEntry({ date: "2026-06-01" }), NOW)).toBe("fresh");
  });

  it("returns aging for an entry 31..90 days old", () => {
    // 31 days before NOW.
    expect(agingTier(buildEntry({ date: "2026-05-01" }), NOW)).toBe("aging");
    // 60 days.
    expect(agingTier(buildEntry({ date: "2026-04-02" }), NOW)).toBe("aging");
  });

  it("returns stale for an entry > 90 days old", () => {
    // 91 days before NOW.
    expect(agingTier(buildEntry({ date: "2026-03-02" }), NOW)).toBe("stale");
    // 200 days.
    expect(agingTier(buildEntry({ date: "2025-11-13" }), NOW)).toBe("stale");
  });

  describe("boundary inclusivity", () => {
    // Boundaries documented in agingTier: age ≤ 30 → fresh, age ≤ 90 → aging,
    // age > 90 → stale. Calendar-day arithmetic via ageInDays.
    it("treats exactly 30 days as fresh", () => {
      // 2026-06-01 - 30 days = 2026-05-02.
      expect(agingTier(buildEntry({ date: "2026-05-02" }), NOW)).toBe("fresh");
    });
    it("treats exactly 31 days as aging", () => {
      expect(agingTier(buildEntry({ date: "2026-05-01" }), NOW)).toBe("aging");
    });
    it("treats exactly 90 days as aging", () => {
      // 2026-06-01 - 90 days = 2026-03-03.
      expect(agingTier(buildEntry({ date: "2026-03-03" }), NOW)).toBe("aging");
    });
    it("treats exactly 91 days as stale", () => {
      expect(agingTier(buildEntry({ date: "2026-03-02" }), NOW)).toBe("stale");
    });
  });

  it("computes a tier for resolved-but-not-accepted entries (filtering is the aggregator's job)", () => {
    // Per spec: agingTier returns null only for unspecified or accepted. A
    // corrected/superseded/invalid resolution is closed but the function still
    // reports its tier — the lint aggregation is what excludes resolved
    // entries from the active-surface counts.
    const e = buildEntry({
      kind: "factual",
      date: "2025-11-13", // 200 days ago
      resolved: true,
      resolution: {
        resolved_at: "2026-02-01T00:00:00Z",
        resolved_by: "mihir",
        kind: "corrected",
      },
    });
    expect(agingTier(e, NOW)).toBe("stale");
  });
});

// --- decided_by_principal (Stage 3, §8) -----------------------------------

describe("decided_by_principal", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-tension-dbp-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("renders and parses decided_by_principal round-trip", async () => {
    const added = await addTension(vault, {
      title: "Test contested edge",
      kind: "factual",
      sourceA: "docs/a.md",
      claimA: "derives from docs/b.md",
      sourceB: "docs/b.md",
      claimB: "re-derivation failed",
      loggedBy: "agent:curation-loop",
      decidedByPrincipal: "agent:curation-loop",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.decidedByPrincipal).toBe("agent:curation-loop");

    const list = await listTensions(vault);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);
    expect(list.value[0]?.decidedByPrincipal).toBe("agent:curation-loop");
  });

  it("omits the line when decidedByPrincipal is absent", async () => {
    const added = await addTension(vault, {
      title: "No principal tension",
      kind: "factual",
      sourceA: "docs/a.md",
      claimA: "derives from docs/b.md",
      sourceB: "docs/b.md",
      claimB: "re-derivation failed",
      loggedBy: "agent:curation-loop",
    });
    expect(added.ok).toBe(true);
    const raw = readFileSync(tensionsPath(vault), "utf-8");
    expect(raw).not.toMatch(/Decided by principal/);
  });
});

describe("STALE_TIER_LINT_COPY", () => {
  it("keeps inter-proposal off the caller-loggable set but addable as a self-tension (#235)", () => {
    expect([...LOGGABLE_TENSION_KINDS]).toEqual(["temporal", "factual", "interpretive"]);
  });

  it("exposes every loggable kind and omits unspecified", () => {
    expect(Object.keys(STALE_TIER_LINT_COPY).sort()).toEqual([
      "factual",
      "inter-proposal",
      "interpretive",
      "positional",
      "temporal",
    ]);
    // The interpretive copy must name the accepted/invalid resolution paths —
    // this is the load-bearing line from Gap 4 of the spec.
    expect(STALE_TIER_LINT_COPY.interpretive).toContain("`accepted`");
    expect(STALE_TIER_LINT_COPY.interpretive).toContain("`invalid`");
    expect(STALE_TIER_LINT_COPY.interpretive).not.toMatch(/garbage collect/i);
  });
});

describe("positional tension kind (U-3)", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-tension-pos-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  const positionalInput = {
    title: "alice vs bob on retry storms",
    sourceA: "pricing/retry-storms.md",
    claimA: "the 250ms floor causes storms",
    sourceB: "pricing/retry-storms.md",
    claimB: "storms predate the floor",
    loggedBy: "alice",
    kind: "positional" as const,
    positionA: "pos-001",
    positionB: "pos-002",
  };

  it("mints a positional self-tension with position ids rendered and round-tripped", async () => {
    const added = await addTension(vault, positionalInput);
    expect(added.ok).toBe(true);
    if (!added.ok) throw added.error;
    expect(added.value.id).toMatch(/^tension-\d{3}$/);
    expect(added.value.positionA).toBe("pos-001");
    expect(added.value.positionB).toBe("pos-002");

    const raw = readFileSync(tensionsPath(vault), "utf-8");
    expect(raw).toContain("- **Position A:** pos-001");
    expect(raw).toContain("- **Position B:** pos-002");

    const listed = await listTensions(vault);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw listed.error;
    expect(listed.value[0]?.kind).toBe("positional");
    expect(listed.value[0]?.positionA).toBe("pos-001");
    expect(listed.value[0]?.positionB).toBe("pos-002");
  });

  it("rejects a positional tension that is not a self-tension", async () => {
    const r = await addTension(vault, { ...positionalInput, sourceB: "pricing/other.md" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("self-tension");
  });

  it("rejects a positional tension missing positionB", async () => {
    const { positionB: _pb, ...noB } = positionalInput;
    const r = await addTension(vault, noB);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("positionA");
  });

  it("vault_tension_log rejects kind positional (not caller-loggable, R-6)", async () => {
    const r = await vaultTensionLog(vault, {
      title: "t",
      sourceA: "a.md",
      sourceB: "a.md",
      claimA: "x",
      claimB: "y",
      agent: "agent:test",
      kind: "positional",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain(LOGGABLE_TENSION_KINDS.join(", "));
  });

  it("a legacy block without position lines parses with both undefined", async () => {
    const plain = await addTension(vault, sampleInput);
    expect(plain.ok).toBe(true);
    const listed = await listTensions(vault);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw listed.error;
    expect(listed.value[0]?.positionA).toBeUndefined();
    expect(listed.value[0]?.positionB).toBeUndefined();
  });

  it("a resolved-accepted positional tension is exempt from aging (R-7 regression)", async () => {
    const added = await addTension(vault, { ...positionalInput, date: "2020-01-01" });
    expect(added.ok).toBe(true);
    if (!added.ok) throw added.error;
    expect(agingTier(added.value, new Date("2026-08-06"))).toBe("stale");
    const resolved = await resolveTension(vault, added.value.id as string, {
      resolved_at: new Date().toISOString(),
      resolved_by: "carol",
      kind: "accepted",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw resolved.error;
    expect(agingTier(resolved.value, new Date("2026-08-06"))).toBeNull();
  });
});

// Item 5: the `consolidated` resolution kind (system-only — recorded by
// vault_consolidate's batch resolve, never caller-pickable) and the
// slice-3 §3.5 bounded jittered retry on `__tensions__` lease contention.
describe("consolidated resolution kind + lease retry", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-tension5-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  const positionalInput = {
    title: "Positional: alice vs bob",
    sourceA: "pricing/claim.md",
    claimA: "assert (high)",
    sourceB: "pricing/claim.md",
    claimB: "dispute (medium)",
    loggedBy: "alice",
    kind: "positional" as const,
    positionA: "pos-001",
    positionB: "pos-002",
  };

  it("`consolidated` round-trips through render and parse", async () => {
    const added = await addTension(vault, positionalInput);
    expect(added.ok).toBe(true);
    if (!added.ok) throw added.error;
    const resolved = await resolveTension(vault, added.value.id as string, {
      resolved_at: new Date().toISOString(),
      resolved_by: "carol",
      kind: "consolidated",
      rationale: "org_position ratified assert by carol; dissent carried: pos-002",
    });
    expect(resolved.ok).toBe(true);

    const listed = await listTensions(vault);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw listed.error;
    expect(listed.value[0]?.resolution?.kind).toBe("consolidated");
  });

  it("CALLER_RESOLUTION_KINDS fences the caller vocabulary to the original four", () => {
    expect([...CALLER_RESOLUTION_KINDS]).toEqual([
      "superseded",
      "corrected",
      "accepted",
      "invalid",
    ]);
    expect(RESOLUTION_KINDS).toContain("consolidated");
  });

  it("isTensionLeaseContention matches only the lease-contention wrap", () => {
    expect(
      isTensionLeaseContention(
        new Error("cannot update tension log: file is locked by 123:x:agent:a"),
      ),
    ).toBe(true);
    expect(isTensionLeaseContention(new Error("cannot read tension log: EACCES"))).toBe(false);
    expect(isTensionLeaseContention(new Error("tension not found: t-9"))).toBe(false);
  });

  it("retryOnTensionLease retries contention once after a jittered sleep in [100,250]ms", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await retryOnTensionLease(
      async () => {
        calls++;
        if (calls === 1) {
          return err(new Error("cannot update tension log: file is locked by 1:x:b"));
        }
        return ok("minted");
      },
      { sleep: async (ms: number) => void sleeps.push(ms) },
    );
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[0]).toBeLessThanOrEqual(250);
  });

  it("retryOnTensionLease passes non-contention errors through untouched", async () => {
    let calls = 0;
    const result = await retryOnTensionLease(async () => {
      calls++;
      return err(new Error("tension not found: t-9"));
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("retryOnTensionLease gives up after the bounded retry", async () => {
    let calls = 0;
    const result = await retryOnTensionLease(
      async () => {
        calls++;
        return err(new Error("cannot update tension log: file is locked by 1:x:b"));
      },
      { sleep: async () => {} },
    );
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
  });
});
