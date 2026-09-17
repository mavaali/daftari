// U3 — the shared-write path decision (Gharonda spike).
//
// U2 proved federation mounts are READ-ONLY: a write-shaped tool targeting an
// `alias:`-prefixed path is refused before it touches disk. So a principal
// who wants to WRITE to `shared` needs a process for which `shared` — not a
// mount — is the CANONICAL vault. This unit decides which topology serves
// that write, then proves it with the real write+lock path (no synthetic
// lock): src/access/locks.ts (SQLite-backed, per-file, 60s TTL, lazy expiry)
// as exercised by src/tools/write.ts's vaultWrite -> performWrite, which
// mints a fresh per-mutation lease holder (mintLeaseHolder) and acquires/
// releases the file lock around the write+index+commit transaction.
//
// Real in-process pattern mirrored from:
//   - test/tools/write.test.ts "lock contention" (openLockDb/acquireLock to
//     pre-hold a lock, then assert vaultWrite is refused with "locked"; and
//     the Promise.all race for "serializes two concurrent writes")
//   - test/tools/write.test.ts's own documented finding (comment above its
//     "deterministic injected race" describe block): measured against this
//     repo's fixture vault, a Promise.all race's LOSER collides with the
//     winner's lock WHILE the winner still holds it (write+index+commit is
//     one held-lock transaction) far more often than arriving after release
//     — so a bare Promise.all reliably reproduces "one succeeds, one is
//     locked out" for same-path contention, without needing the
//     inject-race.ts harness (that harness targets a different race: a
//     stale-base_version lost-update on a read-modify-write tool, not file
//     locking, and does not apply here since vault_write for a *new* path
//     carries no baseVersion).
//   - experiments/gharonda-private-shared/isolation.test.ts (U2) for the
//     AccessContext shape and the "operate directly on the fixture vault"
//     convention this spike already established for alice-private (U2's
//     snapshot only asserts no derived state under the *mount targets*,
//     BOB_ROOT/SHARED_ROOT, not under the canonical vault being acted on).

import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, openLockDb, releaseLock } from "../../src/access/locks.js";
import type { AccessContext } from "../../src/access/rbac.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultWrite } from "../../src/tools/write.js";

const SHARED_FIXTURE = join(__dirname, "vaults", "shared");

// Matches shared/.daftari/config.yaml `roles: householder: { read: ["*"],
// write: ["*"], ... }` — the role BOTH human:alice and human:bob resolve to
// in federation.principals when `shared` is their CANONICAL vault (the U3
// decision below: one shared-canonical process, not one per principal).
const ALICE: AccessContext = {
  user: "human:alice",
  roleName: "householder",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};
const BOB: AccessContext = {
  user: "human:bob",
  roleName: "householder",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

// A fresh copy of the shared fixture vault per test, so this unit's writes
// (which — unlike U1/U2's read-only exercises — create index.db, locks.db,
// and a nested git repo via vaultWrite's auto-commit, per src/utils/git.ts
// ensureGitRepo) never accumulate inside the checked-in
// experiments/gharonda-private-shared/vaults/shared/ fixture that later
// units and the README's documented topology read. Mirrors
// test/helpers/temp-vault.ts's makeTempVault, generalized off that helper's
// hardcoded sample-vault fixture path.
function copySharedVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "gharonda-shared-write-"));
  cpSync(SHARED_FIXTURE, dir, {
    recursive: true,
    filter: (src) => !src.includes(`${sep}.git`),
  });
  return dir;
}

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Shared note",
    domain: "accumulation",
    collection: "household",
    status: "draft",
    confidence: "medium",
    created: "2026-09-17",
    updated: "2026-09-17",
    updated_by: "human:alice",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: [],
    ...overrides,
  };
}

describe("U3 shared-write path — one shared-canonical process, both principals", () => {
  let vault: string;

  beforeEach(() => {
    vault = copySharedVault();
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("1. alice and bob write DIFFERENT docs concurrently — both succeed (per-file lock, no cross-doc block)", async () => {
    const results = await Promise.all([
      vaultWrite(
        vault,
        {
          path: "note-alice.md",
          body: "written by alice\n",
          frontmatter: frontmatter({ updated_by: "human:alice" }),
          agent: "human:alice",
        },
        ALICE,
      ),
      vaultWrite(
        vault,
        {
          path: "note-bob.md",
          body: "written by bob\n",
          frontmatter: frontmatter({ updated_by: "human:bob" }),
          agent: "human:bob",
        },
        BOB,
      ),
    ]);

    for (const r of results) {
      if (!r.ok) throw r.error;
    }
    expect(results.every((r) => r.ok)).toBe(true);

    const aliceDoc = await vaultRead(vault, "note-alice.md");
    const bobDoc = await vaultRead(vault, "note-bob.md");
    expect(aliceDoc.ok && aliceDoc.value.content).toContain("written by alice");
    expect(bobDoc.ok && bobDoc.value.content).toContain("written by bob");
  }, 60_000);

  describe("2. alice and bob write the SAME doc concurrently — exactly one succeeds, no corruption", () => {
    it("deterministic: bob's process pre-holds the file lock, alice's write is refused, no partial file lands", async () => {
      const lockDbResult = openLockDb(vault);
      expect(lockDbResult.ok).toBe(true);
      if (!lockDbResult.ok) return;
      const lockDb = lockDbResult.value;

      // Simulates bob's shared-canonical process mid-transaction on the same
      // path: it holds the real lock this vault's own performWrite would
      // hold for the duration of its write+index+commit.
      const held = acquireLock(lockDb, "contended.md", "human:bob-lease");
      expect(held.ok).toBe(true);

      const aliceWrite = await vaultWrite(
        vault,
        {
          path: "contended.md",
          body: "written by alice\n",
          frontmatter: frontmatter({ updated_by: "human:alice" }),
          agent: "human:alice",
        },
        ALICE,
      );
      expect(aliceWrite.ok).toBe(false);
      if (aliceWrite.ok) throw new Error("alice's write must be refused while bob holds the lock");
      expect(aliceWrite.error.message).toContain("locked");

      // No partial/corrupt file: the doc never made it to disk at all — a
      // read attempt for a doc that doesn't exist is a "not found" error,
      // never garbled content.
      const readDuring = await vaultRead(vault, "contended.md");
      expect(readDuring.ok).toBe(false);

      releaseLock(lockDb, "contended.md", "human:bob-lease");
      lockDb.close();

      // Once released, the same path is immediately writable — the TTL/lease
      // model never permanently wedges a path.
      const retry = await vaultWrite(
        vault,
        {
          path: "contended.md",
          body: "written by alice, retried\n",
          frontmatter: frontmatter({ updated_by: "human:alice" }),
          agent: "human:alice",
        },
        ALICE,
      );
      expect(retry.ok).toBe(true);
      const readAfter = await vaultRead(vault, "contended.md");
      expect(readAfter.ok && readAfter.value.content).toContain("written by alice, retried");
    }, 60_000);

    it("genuine race: Promise.all of both principals writing the same new doc — exactly one wins, the loser is locked out, final content is exactly one writer's (not interleaved)", async () => {
      const writeOnce = (access: AccessContext, agent: string) =>
        vaultWrite(
          vault,
          {
            path: "contended-race.md",
            body: `written by ${agent}\n`,
            frontmatter: frontmatter({ updated_by: agent }),
            agent,
          },
          access,
        );

      const [aliceResult, bobResult] = await Promise.all([
        writeOnce(ALICE, "human:alice"),
        writeOnce(BOB, "human:bob"),
      ]);

      const results = [aliceResult, bobResult];
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);

      // Per the measured finding this test mirrors (write.test.ts's
      // documented Promise.all behavior against this repo's fixture vault):
      // the loser's synchronous lock-acquire collides with the winner's
      // still-held lock, so exactly one of the two lands, not both.
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      for (const l of losers) {
        if (l.ok) continue;
        expect(l.error.message).toContain("locked");
      }

      // The final file content is exactly the winner's body — not a merge,
      // not interleaved bytes, not truncated. That is the "no silent
      // last-write-wins corruption" guarantee: there is no last-write-wins
      // here at all, because the loser never got to write.
      const read = await vaultRead(vault, "contended-race.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const wonAsAlice = aliceResult.ok;
      const expectedBody = wonAsAlice ? "written by human:alice\n" : "written by human:bob\n";
      // performWrite's serializeDocument always prefixes the body with a
      // leading newline after the frontmatter fence (write.ts:305); strip it
      // before comparing so this assertion checks content, not that framing.
      expect(read.value.content.replace(/^\n/, "")).toBe(expectedBody);
    }, 60_000);
  });

  it("3. after a write to shared, the OTHER principal reading the same canonical-shared vault sees the new content — shared is genuinely shared", async () => {
    const written = await vaultWrite(
      vault,
      {
        path: "kitchen-reno-budget.md",
        body: "Budget: $12,000, agreed 2026-09-17.\n",
        frontmatter: frontmatter({ updated_by: "human:alice", title: "Kitchen reno budget" }),
        agent: "human:alice",
      },
      ALICE,
    );
    expect(written.ok).toBe(true);

    // Bob reads through the SAME canonical-shared vault (the U3 decision:
    // one shared-canonical process serves both principals, differentiated
    // by AccessContext per call, not by which process they're talking to).
    // vaultRead has no principal-scoping of its own on a canonical vault —
    // RBAC read gating is a mount-time concern (proven in U2); what matters
    // here is that bob's request against this same vault root sees alice's
    // write, i.e. there is exactly one on-disk copy of `shared`, not two
    // diverging ones.
    const readAsBob = await vaultRead(vault, "kitchen-reno-budget.md");
    expect(readAsBob.ok).toBe(true);
    if (!readAsBob.ok) return;
    expect(readAsBob.value.content).toContain("Budget: $12,000");
  }, 60_000);
});

// Sanity: this suite must leave nothing behind under the CHECKED-IN fixture
// vault — everything above runs against copySharedVault()'s tmpdir copy.
describe("U3 fixture hygiene", () => {
  it("the checked-in vaults/shared fixture is untouched by this test file (still just config.yaml)", () => {
    const entries = readdirSync(join(SHARED_FIXTURE, ".daftari"));
    expect(entries).toEqual(["config.yaml"]);
  });
});
