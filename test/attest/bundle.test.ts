// The attestation bundle (#298 layer 2): a manifest derived entirely from
// markdown bytes + git + the vault's own tension log — never a second source
// of truth — signed once, verifiable offline.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, outPathInsideVault } from "../../src/attest/bundle.js";
import { addTension } from "../../src/curation/tension.js";
import { sha256Hex } from "../../src/utils/hash.js";

let vault: string;

function g(...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", vault, "-c", "user.name=op", "-c", "user.email=op@t", ...args],
    { encoding: "utf-8" },
  );
}

function writeDoc(relPath: string, extra = ""): string {
  const body = `---
title: "Doc ${relPath}"
domain: "accumulation"
collection: "${relPath.split("/")[0]}"
status: "canonical"
confidence: "high"
created: "2026-08-01"
updated: "2026-08-01"
updated_by: "agent:test"
provenance: "direct"
superseded_by: null
ttl_days: 120
sources: []
tags: []
${extra}---

Body of ${relPath}.
`;
  mkdirSync(join(vault, relPath.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(join(vault, relPath), body, "utf-8");
  return body;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-attbundle-"));
  g("init", "-q");
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("buildManifest", () => {
  it("hashes each doc's raw bytes, sorts by path, and anchors the full head sha", async () => {
    const bodyB = writeDoc("pricing/beta.md");
    const bodyA = writeDoc("pricing/alpha.md");
    g("add", "-A");
    g("commit", "-q", "-m", "seed");

    const m = await buildManifest(vault, { daftariVersion: "0.0.0-test" });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value.docs.map((d) => d.path)).toEqual(["pricing/alpha.md", "pricing/beta.md"]);
    expect(m.value.docs[0]?.contentHash).toBe(sha256Hex(bodyA));
    expect(m.value.docs[1]?.contentHash).toBe(sha256Hex(bodyB));
    expect(m.value.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.value.daftariVersion).toBe("0.0.0-test");
    expect(m.value.totals.docs).toBe(2);
    const gitMeta = m.value.docs[0]?.git;
    expect(gitMeta?.lastAuthor).toBe("op");
    expect(gitMeta?.commitCount).toBe(1);
  });

  it("refuses a dirty working tree — except the .daftari control dir", async () => {
    writeDoc("pricing/a.md");
    g("add", "-A");
    g("commit", "-q", "-m", "seed");

    // Dirty .daftari (the tension log is advisory operator state, never
    // auto-committed) must NOT block attestation…
    const t = await addTension(vault, {
      title: "T",
      sourceA: "pricing/a.md",
      claimA: "x",
      sourceB: "pricing/other.md",
      claimB: "y",
      loggedBy: "op",
      kind: "factual",
    });
    expect(t.ok).toBe(true);
    const cleanish = await buildManifest(vault, { daftariVersion: "0.0.0-test" });
    expect(cleanish.ok).toBe(true);

    // …but an uncommitted DOC change must: the content hash and the head
    // seal would be different claims.
    writeDoc("pricing/uncommitted.md");
    const dirty = await buildManifest(vault, { daftariVersion: "0.0.0-test" });
    expect(dirty.ok).toBe(false);
    if (dirty.ok) return;
    expect(dirty.error.message).toContain("dirty");
    expect(dirty.error.message).toContain("pricing/uncommitted.md");
  });

  it("derives contested, ratified, and per-doc open tension counts", async () => {
    writeDoc(
      "pricing/claim.md",
      `positions:
  - id: "pos-001"
    principal: "alice"
    stance: "assert"
    statement: null
    confidence: "high"
    provenance: "direct"
    valid_from: null
    superseded_by: null
    created: "2026-08-01"
    sources: []
  - id: "pos-002"
    principal: "bob"
    stance: "dispute"
    statement: null
    confidence: "medium"
    provenance: "direct"
    valid_from: null
    superseded_by: null
    created: "2026-08-02"
    sources: []
org_position:
  stance: "assert"
  confidence: "high"
  ratified_by: "carol"
  ratified_at: "2026-08-10"
  dissent:
    - "pos-002"
contested: true
`,
    );
    writeDoc("pricing/plain.md");
    g("add", "-A");
    g("commit", "-q", "-m", "seed");
    const minted = await addTension(vault, {
      title: "Positional",
      sourceA: "pricing/claim.md",
      claimA: "assert",
      sourceB: "pricing/claim.md",
      claimB: "dispute",
      loggedBy: "bob",
      kind: "positional",
      positionA: "pos-001",
      positionB: "pos-002",
    });
    expect(minted.ok).toBe(true);

    const m = await buildManifest(vault, { daftariVersion: "0.0.0-test" });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const claim = m.value.docs.find((d) => d.path === "pricing/claim.md");
    expect(claim?.contested).toBe(true);
    expect(claim?.ratified).toBe(true);
    expect(claim?.openTensions).toBe(1);
    const plain = m.value.docs.find((d) => d.path === "pricing/plain.md");
    expect(plain?.contested).toBe(false);
    expect(plain?.ratified).toBe(false);
    expect(plain?.openTensions).toBe(0);
    expect(m.value.totals.contestedDocs).toBe(1);
    expect(m.value.totals.openTensions).toBe(1);
  });

  it("git-ignored derived logs can never reach the bundle (guard)", async () => {
    writeDoc("pricing/a.md");
    g("add", "-A");
    g("commit", "-q", "-m", "seed");
    const before = await buildManifest(vault, {
      daftariVersion: "0.0.0-test",
      generatedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, ".daftari", "curation-log.jsonl"), '{"poison":true}\n');
    writeFileSync(join(vault, ".daftari", "edges.jsonl"), '{"poison":true}\n');

    const after = await buildManifest(vault, {
      daftariVersion: "0.0.0-test",
      generatedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(JSON.stringify(after.value)).toBe(JSON.stringify(before.value));
  });
});

describe("outPathInsideVault", () => {
  it("refuses paths that resolve inside the vault root, allows outside", () => {
    expect(outPathInsideVault(vault, join(vault, "bundle.json"))).toBe(true);
    expect(outPathInsideVault(vault, join(vault, "sub", "x.json"))).toBe(true);
    expect(outPathInsideVault(vault, join(tmpdir(), "elsewhere.json"))).toBe(false);
    // Dotted escape that lexically mentions the vault but resolves outside.
    expect(outPathInsideVault(vault, join(vault, "..", "outside.json"))).toBe(false);
  });
});

describe("review hardening", () => {
  it("a rename out of .daftari/ cannot smuggle past the dirty gate", async () => {
    writeDoc("pricing/a.md");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, ".daftari", "tensions.md"), "## t\n");
    g("add", "-A");
    g("commit", "-q", "-m", "seed");
    // Stage a rename FROM .daftari INTO the doc tree: porcelain reports
    // "R  .daftari/tensions.md -> pricing/evil.md" — the exemption must
    // consider BOTH sides.
    g("mv", ".daftari/tensions.md", "pricing/evil.md");
    const dirty = await buildManifest(vault, { daftariVersion: "0.0.0-test" });
    expect(dirty.ok).toBe(false);
    if (dirty.ok) return;
    expect(dirty.error.message).toContain("evil.md");
  });

  it("a committed file named @-something does not corrupt history parsing", async () => {
    writeDoc("pricing/a.md");
    writeFileSync(join(vault, "@weird.md"), "not frontmatter, just a file\n");
    g("add", "-A");
    g("commit", "-q", "-m", "seed");
    const m = await buildManifest(vault, { daftariVersion: "0.0.0-test" });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const a = m.value.docs.find((d) => d.path === "pricing/a.md");
    expect(a?.git?.lastAuthor).toBe("op");
    expect(a?.git?.commitCount).toBe(1);
  });
});
