// `daftari sync` CLI wiring (#6): flag validation, exit codes, and the
// push/restore round trip over the fs backend. The engine's own semantics
// live in test/storage/sync.test.ts; this file mirrors src/sync/index.ts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSync } from "../../src/sync/index.js";

const DOC = `---
title: a
collection: public
domain: accumulation
status: canonical
confidence: high
created: 2026-03-01
updated: 2026-03-01
tags: [x]
---

# a
`;

describe("daftari sync CLI (#6)", () => {
  let vault: string;
  let backing: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-sync-cli-vault-"));
    backing = mkdtempSync(join(tmpdir(), "daftari-sync-cli-backing-"));
    mkdirSync(join(vault, "notes"), { recursive: true });
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, "notes", "a.md"), DOC);
    writeFileSync(
      join(vault, ".daftari", "config.yaml"),
      `version: 1\nstorage:\n  backend: fs\n  path: ${backing}\n`,
    );
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(backing, { recursive: true, force: true });
  });

  it("usage errors are exit 2: missing --vault, --restore with --dry-run", async () => {
    expect(await runSync([])).toBe(2);
    expect(await runSync(["--vault", vault, "--restore", "--dry-run"])).toBe(2);
  });

  it("a vault without a storage block refuses with exit 2", async () => {
    writeFileSync(join(vault, ".daftari", "config.yaml"), "version: 1\n");
    expect(await runSync(["--vault", vault])).toBe(2);
  });

  it("restore flag validation: --backend required and per-backend target required", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "daftari-sync-cli-restore-")), "vault");
    expect(await runSync(["--vault", target, "--restore"])).toBe(2);
    expect(await runSync(["--vault", target, "--restore", "--backend", "dropbox"])).toBe(2);
    expect(await runSync(["--vault", target, "--restore", "--backend", "fs"])).toBe(2);
    expect(await runSync(["--vault", target, "--restore", "--backend", "s3"])).toBe(2);
  });

  it("push, dry-run, and restore round-trip over the fs backend", async () => {
    expect(await runSync(["--vault", vault, "--dry-run"])).toBe(0);
    expect(existsSync(join(backing, "meta", "manifest.json"))).toBe(false);

    expect(await runSync(["--vault", vault])).toBe(0);
    expect(existsSync(join(backing, "meta", "manifest.json"))).toBe(true);
    expect(readFileSync(join(backing, "tree", "notes", "a.md"), "utf-8")).toBe(DOC);

    const target = join(mkdtempSync(join(tmpdir(), "daftari-sync-cli-restore2-")), "vault");
    expect(
      await runSync(["--vault", target, "--restore", "--backend", "fs", "--path", backing]),
    ).toBe(0);
    expect(readFileSync(join(target, "notes", "a.md"), "utf-8")).toBe(DOC);
    // The restore reindexed: the rebuilt (never-synced) index exists locally.
    expect(existsSync(join(target, ".daftari", "index.db"))).toBe(true);
    rmSync(target, { recursive: true, force: true });
  });

  it("restoring into a non-empty directory is a runtime error (exit 3)", async () => {
    expect(await runSync(["--vault", vault])).toBe(0);
    expect(
      await runSync(["--vault", vault, "--restore", "--backend", "fs", "--path", backing]),
    ).toBe(3);
  });
});
