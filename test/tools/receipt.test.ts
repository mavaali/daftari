import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { generateAttestKeys, verifyBytes } from "../../src/attest/sign.js";
import { addTension } from "../../src/curation/tension.js";
import { MAX_RECEIPT_PATHS, receiptTools, vaultReceipt } from "../../src/tools/receipt.js";
import { commit } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const TODAY = new Date().toISOString().slice(0, 10);

function doc(
  relPath: string,
  overrides: Record<string, string | null> = {},
  sources: string[] = [],
): { relPath: string; body: string } {
  const fm: Record<string, string | null> = {
    title: `Doc ${relPath}`,
    domain: "accumulation",
    collection: relPath.split("/")[0] ?? "",
    status: "canonical",
    confidence: "medium",
    created: TODAY,
    updated: TODAY,
    updated_by: "agent:test",
    provenance: "direct",
    superseded_by: null,
    ttl_days: "120",
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => {
    if (v === null) return `${k}: null`;
    // ttl_days is numeric in the schema — write it unquoted.
    return k === "ttl_days" ? `${k}: ${v}` : `${k}: "${v}"`;
  });
  return {
    relPath,
    body: `---\n${lines.join("\n")}\nsources: ${JSON.stringify(sources)}\ntags: []\n---\n\nBody of ${relPath}.\n`,
  };
}

function writeDoc(
  vault: string,
  relPath: string,
  overrides: Record<string, string | null> = {},
  sources: string[] = [],
) {
  const d = doc(relPath, overrides, sources);
  mkdirSync(join(vault, relPath.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(join(vault, relPath), d.body, "utf-8");
}

describe("vaultReceipt", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("compiles a clean receipt for a fresh canonical document", async () => {
    writeDoc(vault, "pricing/fresh.md");
    const result = await vaultReceipt(vault, { paths: ["pricing/fresh.md"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const r = result.value;
    expect(r.sources).toHaveLength(1);
    const s = r.sources[0];
    expect(s?.path).toBe("pricing/fresh.md");
    expect(s?.status).toBe("canonical");
    expect(s?.decay).toBeNull();
    expect(s?.currentSource).toBeNull();
    expect(s?.tensions).toEqual([]);
    expect(r.summary.flags).toEqual([]);
    expect(r.summary.byStatus).toEqual({ canonical: 1 });
    expect(r.summary.openTensions).toBe(0);
    expect(r.summary.oldestUpdated).toBe(TODAY);
    expect(r.summary.newestUpdated).toBe(TODAY);
    // The temp vault copy strips .git, so there is no as-of anchor.
    expect(r.vaultHead).toBeNull();
  });

  it("pins each source's exact content with a version hash", async () => {
    writeDoc(vault, "pricing/fresh.md");
    const result = await vaultReceipt(vault, { paths: ["pricing/fresh.md"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = readFileSync(join(vault, "pricing/fresh.md"), "utf-8");
    const expected = createHash("sha256").update(raw, "utf-8").digest("hex");
    expect(result.value.sources[0]?.version).toBe(expected);
  });

  it("flags contested sources and lists their tensions", async () => {
    writeDoc(vault, "pricing/contested.md");
    writeDoc(vault, "pricing/other.md");
    const logged = await addTension(vault, {
      title: "Contested pricing claim",
      kind: "factual",
      sourceA: "pricing/contested.md",
      claimA: "says X",
      sourceB: "pricing/other.md",
      claimB: "says Y",
      loggedBy: "agent:test",
    });
    expect(logged.ok).toBe(true);

    const result = await vaultReceipt(vault, { paths: ["pricing/contested.md"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.flags).toContain("cites-contested");
    expect(result.value.summary.openTensions).toBe(1);
    const tensions = result.value.sources[0]?.tensions ?? [];
    expect(tensions).toHaveLength(1);
    expect(tensions[0]?.title).toBe("Contested pricing claim");
    expect(tensions[0]?.kind).toBe("factual");
  });

  it("counts a tension touching two cited documents once", async () => {
    writeDoc(vault, "pricing/a.md");
    writeDoc(vault, "pricing/b.md");
    await addTension(vault, {
      title: "A vs B",
      kind: "factual",
      sourceA: "pricing/a.md",
      claimA: "says X",
      sourceB: "pricing/b.md",
      claimB: "says Y",
      loggedBy: "agent:test",
    });

    const result = await vaultReceipt(vault, { paths: ["pricing/a.md", "pricing/b.md"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.openTensions).toBe(1);
    expect(result.value.sources[0]?.tensions).toHaveLength(1);
    expect(result.value.sources[1]?.tensions).toHaveLength(1);
  });

  it("resolves a supersession chain to its terminal-current document", async () => {
    writeDoc(vault, "pricing/old.md", {
      status: "superseded",
      superseded_by: "pricing/new.md",
    });
    writeDoc(vault, "pricing/new.md");

    const result = await vaultReceipt(vault, { paths: ["pricing/old.md"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chain = result.value.sources[0]?.currentSource;
    expect(chain?.kind).toBe("resolved");
    if (chain?.kind !== "resolved") return;
    expect(chain.path).toBe("pricing/new.md");
    expect(chain.hops).toBe(1);
    expect(result.value.summary.flags).toContain("cites-superseded");
    expect(result.value.summary.flags).not.toContain("supersession-unresolved");
  });

  it("flags a dangling supersession chain as unresolved", async () => {
    writeDoc(vault, "pricing/orphaned.md", {
      status: "superseded",
      superseded_by: "pricing/deleted.md",
    });

    const result = await vaultReceipt(vault, { paths: ["pricing/orphaned.md"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]?.currentSource?.kind).toBe("dangling");
    expect(result.value.summary.flags).toContain("supersession-unresolved");
  });

  it("flags a cyclic supersession chain as unresolved", async () => {
    writeDoc(vault, "pricing/c1.md", { status: "superseded", superseded_by: "pricing/c2.md" });
    writeDoc(vault, "pricing/c2.md", { status: "superseded", superseded_by: "pricing/c1.md" });

    const result = await vaultReceipt(vault, { paths: ["pricing/c1.md"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]?.currentSource?.kind).toBe("cycle");
    expect(result.value.summary.flags).toContain("supersession-unresolved");
  });

  it("flags deprecated, draft, and low-confidence citations", async () => {
    writeDoc(vault, "pricing/dead.md", { status: "deprecated" });
    writeDoc(vault, "pricing/wip.md", { status: "draft" });
    writeDoc(vault, "pricing/shaky.md", { confidence: "low" });

    const result = await vaultReceipt(vault, {
      paths: ["pricing/dead.md", "pricing/wip.md", "pricing/shaky.md"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.flags).toContain("cites-deprecated");
    expect(result.value.summary.flags).toContain("cites-draft");
    expect(result.value.summary.flags).toContain("cites-low-confidence");
    expect(result.value.summary.byStatus).toEqual({ canonical: 1, deprecated: 1, draft: 1 });
  });

  it("flags a citation past its TTL as stale", async () => {
    writeDoc(vault, "pricing/rotten.md", {
      created: "2025-01-01",
      updated: "2025-01-01",
      ttl_days: "30",
    });
    const result = await vaultReceipt(vault, { paths: ["pricing/rotten.md"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]?.decay?.level).toBe("warn");
    expect(result.value.summary.flags).toContain("cites-stale");
  });

  it("dedupes aliased spellings of the same path", async () => {
    writeDoc(vault, "pricing/one.md");
    const result = await vaultReceipt(vault, {
      paths: ["pricing/one.md", "./pricing/one.md", "pricing/../pricing/one.md"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.summary.sourceCount).toBe(1);
  });

  it("carries the caller's claim verbatim and covers it with the hash", async () => {
    writeDoc(vault, "pricing/fresh.md");
    const result = await vaultReceipt(vault, {
      paths: ["pricing/fresh.md"],
      claim: "Helios entry pricing starts at the indie tier.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claim).toBe("Helios entry pricing starts at the indie tier.");
  });

  it("produces a recomputable receipt hash over the full payload", async () => {
    writeDoc(vault, "pricing/fresh.md");
    const result = await vaultReceipt(vault, { paths: ["pricing/fresh.md"], claim: "x" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { receiptHash, ...payload } = result.value;
    const recomputed = createHash("sha256").update(JSON.stringify(payload), "utf-8").digest("hex");
    expect(receiptHash).toBe(recomputed);
    expect(receiptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("anchors the receipt to the vault's git HEAD when the vault is a repo", async () => {
    writeDoc(vault, "pricing/fresh.md");
    const committed = await commit(vault, ["pricing/fresh.md"], "seed", "agent:test");
    expect(committed.ok).toBe(true);

    const result = await vaultReceipt(vault, { paths: ["pricing/fresh.md"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultHead).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("rejects an empty paths array", async () => {
    const result = await vaultReceipt(vault, { paths: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("non-empty 'paths'");
  });

  it("rejects more paths than the cap", async () => {
    const paths = Array.from({ length: MAX_RECEIPT_PATHS + 1 }, (_, i) => `pricing/p${i}.md`);
    const result = await vaultReceipt(vault, { paths });
    expect(result.ok).toBe(false);
  });

  it("rejects path traversal", async () => {
    const result = await vaultReceipt(vault, { paths: ["../../../etc/passwd"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("escapes vault root");
  });

  it("errors on a missing cited file", async () => {
    const result = await vaultReceipt(vault, { paths: ["pricing/missing.md"] });
    expect(result.ok).toBe(false);
  });
});

describe("vaultReceipt — RBAC", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  const analyst: AccessContext = {
    user: "human:test",
    roleName: "analyst",
    role: { read: ["pricing"], write: [], promote: false, ratify: false },
  };

  it("denies a receipt over a collection the role cannot read", async () => {
    writeDoc(vault, "moonshot/secret.md");
    const result = await vaultReceipt(vault, { paths: ["moonshot/secret.md"] }, analyst);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("access denied");
  });

  it("degrades an unreadable supersession hop to 'restricted'", async () => {
    writeDoc(vault, "pricing/old.md", {
      status: "superseded",
      superseded_by: "moonshot/new.md",
    });
    writeDoc(vault, "moonshot/new.md");

    const result = await vaultReceipt(vault, { paths: ["pricing/old.md"] }, analyst);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]?.currentSource?.kind).toBe("restricted");
    expect(result.value.summary.flags).toContain("supersession-unresolved");
  });

  it("hides a tension whose counterpart lives in an unreadable collection", async () => {
    writeDoc(vault, "pricing/visible.md");
    writeDoc(vault, "moonshot/hidden.md");
    await addTension(vault, {
      title: "Visible vs hidden",
      kind: "factual",
      sourceA: "pricing/visible.md",
      claimA: "says X",
      sourceB: "moonshot/hidden.md",
      claimB: "says Y",
      loggedBy: "agent:test",
    });

    const result = await vaultReceipt(vault, { paths: ["pricing/visible.md"] }, analyst);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]?.tensions).toEqual([]);
    expect(result.value.summary.openTensions).toBe(0);
    expect(result.value.summary.flags).not.toContain("cites-contested");
  });

  it("hides a tension whose alias side canonicalizes into an unreadable collection", async () => {
    writeDoc(vault, "pricing/visible.md");
    // pricing/../moonshot/hidden.md IS a moonshot doc; the raw top segment
    // says pricing. The read gate must judge the canonical path.
    await addTension(vault, {
      title: "Alias vs visible",
      kind: "factual",
      sourceA: "pricing/../moonshot/hidden.md",
      claimA: "says X",
      sourceB: "pricing/visible.md",
      claimB: "says Y",
      loggedBy: "agent:test",
    });

    const result = await vaultReceipt(vault, { paths: ["pricing/visible.md"] }, analyst);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]?.tensions).toEqual([]);
    expect(result.value.summary.openTensions).toBe(0);
    expect(result.value.summary.flags).not.toContain("cites-contested");
  });
});

// 0ksb: a receipt checks the cited document's own `sources`, one hop. Before
// this, empty flags claimed "grounded" while the evidence underneath was
// retracted, contested, deleted, or never checkable at all.
describe("vaultReceipt — upstream sources (0ksb)", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  async function flagsFor(path: string, access?: AccessContext) {
    const result = await vaultReceipt(vault, { paths: [path] }, access);
    if (!result.ok) throw result.error;
    return result.value;
  }

  it("keeps empty flags for a claim grounded in a current vault source", async () => {
    writeDoc(vault, "pricing/evidence.md");
    writeDoc(vault, "pricing/claim.md", {}, ["vault:pricing/evidence.md"]);
    const r = await flagsFor("pricing/claim.md");
    expect(r.summary.flags).toEqual([]);
    expect(r.sources[0]?.upstreamFlags).toEqual([]);
  });

  it("flags distill, web, opaque, and unresolved legacy sources as unverifiable", async () => {
    for (const [name, ref] of [
      ["distilled", "distill:vendor-memo#abc123"],
      ["web", "https://example.com/report"],
      ["opaque", "slack:C123/p456"],
      ["legacy", "a conversation with Bob"],
    ] as const) {
      writeDoc(vault, `pricing/${name}.md`, {}, [ref]);
      const r = await flagsFor(`pricing/${name}.md`);
      expect(r.summary.flags, ref).toEqual(["cites-unverifiable-source"]);
      expect(r.sources[0]?.upstreamFlags, ref).toEqual(["cites-unverifiable-source"]);
    }
  });

  it("treats a legacy source that resolves to a vault doc as a vault source", async () => {
    writeDoc(vault, "pricing/evidence.md", { status: "deprecated" });
    writeDoc(vault, "pricing/claim.md", {}, ["pricing/evidence"]);
    const r = await flagsFor("pricing/claim.md");
    expect(r.summary.flags).toEqual(["cites-retracted-upstream"]);
  });

  it("flags an explicit vault source that no longer exists as broken", async () => {
    writeDoc(vault, "pricing/claim.md", {}, ["vault:pricing/deleted.md"]);
    expect((await flagsFor("pricing/claim.md")).summary.flags).toEqual(["cites-broken-source"]);
    // A role that reads every collection has nothing hidden from it, so a
    // missing source cannot be confused with a hidden one: still broken.
    const everything: AccessContext = {
      user: "human:op",
      roleName: "admin",
      role: { read: ["*"], write: [], promote: false, ratify: false },
    };
    expect((await flagsFor("pricing/claim.md", everything)).summary.flags).toEqual([
      "cites-broken-source",
    ]);
  });

  it("flags superseded, retracted, and contested upstream sources", async () => {
    writeDoc(vault, "pricing/old.md", { status: "superseded", superseded_by: "pricing/new.md" });
    writeDoc(vault, "pricing/new.md");
    writeDoc(vault, "pricing/dead.md", { status: "deprecated" });
    writeDoc(vault, "pricing/gone.md", { status: "archived" });
    writeDoc(vault, "pricing/disputed.md");
    writeDoc(vault, "pricing/rebuttal.md");
    await addTension(vault, {
      title: "Disputed evidence",
      kind: "factual",
      sourceA: "pricing/disputed.md",
      claimA: "says X",
      sourceB: "pricing/rebuttal.md",
      claimB: "says Y",
      loggedBy: "agent:test",
    });
    writeDoc(vault, "pricing/c-old.md", {}, ["vault:pricing/old.md"]);
    writeDoc(vault, "pricing/c-dead.md", {}, ["vault:pricing/dead.md"]);
    writeDoc(vault, "pricing/c-gone.md", {}, ["vault:pricing/gone.md"]);
    writeDoc(vault, "pricing/c-disputed.md", {}, ["vault:pricing/disputed.md"]);

    expect((await flagsFor("pricing/c-old.md")).summary.flags).toEqual([
      "cites-superseded-upstream",
    ]);
    expect((await flagsFor("pricing/c-dead.md")).summary.flags).toEqual([
      "cites-retracted-upstream",
    ]);
    expect((await flagsFor("pricing/c-gone.md")).summary.flags).toEqual([
      "cites-retracted-upstream",
    ]);
    const disputed = await flagsFor("pricing/c-disputed.md");
    expect(disputed.summary.flags).toEqual(["cites-contested-upstream"]);
    // The cited doc itself is not a party to the tension.
    expect(disputed.summary.openTensions).toBe(0);
  });

  it("attributes upstream flags to the cited document that carries them", async () => {
    writeDoc(vault, "pricing/dead.md", { status: "deprecated" });
    writeDoc(vault, "pricing/clean.md");
    writeDoc(vault, "pricing/claim.md", {}, ["vault:pricing/dead.md", "https://example.com"]);
    const r = await vaultReceipt(vault, { paths: ["pricing/clean.md", "pricing/claim.md"] });
    if (!r.ok) throw r.error;
    expect(r.value.sources[0]?.upstreamFlags).toEqual([]);
    expect(r.value.sources[1]?.upstreamFlags).toEqual([
      "cites-retracted-upstream",
      "cites-unverifiable-source",
    ]);
    expect(r.value.summary.flags).toEqual([
      "cites-retracted-upstream",
      "cites-unverifiable-source",
    ]);
  });

  it("ignores a self-citation", async () => {
    writeDoc(vault, "pricing/self.md", { status: "canonical" }, ["vault:pricing/self.md"]);
    expect((await flagsFor("pricing/self.md")).summary.flags).toEqual([]);
  });

  it("keeps the receipt hash recomputable with upstream flags present", async () => {
    writeDoc(vault, "pricing/claim.md", {}, ["distill:memo#x", "vault:pricing/deleted.md"]);
    const r = await flagsFor("pricing/claim.md");
    const { receiptHash, ...payload } = r;
    expect(createHash("sha256").update(JSON.stringify(payload), "utf-8").digest("hex")).toBe(
      receiptHash,
    );
  });

  describe("repo: sources", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
      dirs.length = 0;
    });

    function repoVault(): string {
      const repo = mkdtempSync(join(tmpdir(), "daftari-receipt-repo-"));
      dirs.push(repo);
      const v = join(repo, "vault");
      mkdirSync(join(v, ".daftari"), { recursive: true });
      mkdirSync(join(repo, "evidence"));
      writeFileSync(join(repo, "evidence", "present.md"), "evidence");
      writeFileSync(join(v, ".daftari", "config.yaml"), "repo_root: ..\n");
      return v;
    }

    it("passes an existing repo file, flags a missing one as broken", async () => {
      const v = repoVault();
      writeDoc(v, "pricing/ok.md", {}, ["repo:evidence/present.md"]);
      writeDoc(v, "pricing/missing.md", {}, ["repo:evidence/absent.md"]);
      const ok1 = await vaultReceipt(v, { paths: ["pricing/ok.md"] });
      const bad = await vaultReceipt(v, { paths: ["pricing/missing.md"] });
      if (!ok1.ok || !bad.ok) throw new Error("receipt failed");
      expect(ok1.value.summary.flags).toEqual([]);
      expect(bad.value.summary.flags).toEqual(["cites-broken-source"]);
    });

    it("is unverifiable to a role without verify_repo_sources, and never stats it", async () => {
      const v = repoVault();
      writeDoc(v, "pricing/missing.md", {}, ["repo:evidence/absent.md"]);
      const reader: AccessContext = {
        user: "agent:r",
        roleName: "reader",
        role: { read: ["*"], write: [], promote: false, ratify: false },
      };
      const r = await vaultReceipt(v, { paths: ["pricing/missing.md"] }, reader);
      if (!r.ok) throw r.error;
      expect(r.value.summary.flags).toEqual(["cites-unverifiable-source"]);
    });

    it("is unverifiable when no repo_root is configured", async () => {
      writeDoc(vault, "pricing/repo.md", {}, ["repo:evidence/present.md"]);
      expect((await flagsFor("pricing/repo.md")).summary.flags).toEqual([
        "cites-unverifiable-source",
      ]);
    });
  });

  describe("RBAC", () => {
    const analyst: AccessContext = {
      user: "human:test",
      roleName: "analyst",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };

    it("coarsens a hidden source and a deleted one to the same flag, with no state", async () => {
      // Hidden and retracted and contested: none of that may surface.
      writeDoc(vault, "moonshot/hidden.md", { status: "deprecated", title: "HIDDEN-TITLE" });
      writeDoc(vault, "moonshot/other.md");
      await addTension(vault, {
        title: "HIDDEN-TENSION",
        kind: "factual",
        sourceA: "moonshot/hidden.md",
        claimA: "says X",
        sourceB: "moonshot/other.md",
        claimB: "says Y",
        loggedBy: "agent:test",
      });
      writeDoc(vault, "pricing/cites-hidden.md", {}, ["vault:moonshot/hidden.md"]);
      writeDoc(vault, "pricing/cites-deleted.md", {}, ["vault:pricing/deleted.md"]);
      // A doc under a readable path prefix whose collection is hidden: must
      // look exactly like a deleted readable-prefix doc (#416).
      writeDoc(vault, "pricing/misfiled.md", { collection: "moonshot" });
      writeDoc(vault, "pricing/cites-misfiled.md", {}, ["vault:pricing/misfiled.md"]);

      const hidden = await flagsFor("pricing/cites-hidden.md", analyst);
      const deleted = await flagsFor("pricing/cites-deleted.md", analyst);
      const misfiled = await flagsFor("pricing/cites-misfiled.md", analyst);
      for (const r of [hidden, deleted, misfiled]) {
        expect(r.summary.flags).toEqual(["cites-unreadable-source"]);
        expect(r.sources[0]?.upstreamFlags).toEqual(["cites-unreadable-source"]);
        const text = JSON.stringify(r);
        expect(text).not.toContain("HIDDEN-TITLE");
        expect(text).not.toContain("HIDDEN-TENSION");
      }
    });

    it("folds a legacy source resolving into a hidden collection into unverifiable", async () => {
      writeDoc(vault, "moonshot/secret-plan.md");
      writeDoc(vault, "pricing/claim.md", {}, ["moonshot/secret-plan"]);
      writeDoc(vault, "pricing/claim2.md", {}, ["moonshot/no-such-plan"]);
      const a = await flagsFor("pricing/claim.md", analyst);
      const b = await flagsFor("pricing/claim2.md", analyst);
      expect(a.summary.flags).toEqual(["cites-unverifiable-source"]);
      expect(b.summary.flags).toEqual(a.summary.flags);
    });

    it("does not surface a tension on a readable source whose counterpart is hidden", async () => {
      writeDoc(vault, "pricing/evidence.md");
      writeDoc(vault, "moonshot/rebuttal.md");
      await addTension(vault, {
        title: "Visible vs hidden",
        kind: "factual",
        sourceA: "pricing/evidence.md",
        claimA: "says X",
        sourceB: "moonshot/rebuttal.md",
        claimB: "says Y",
        loggedBy: "agent:test",
      });
      writeDoc(vault, "pricing/claim.md", {}, ["vault:pricing/evidence.md"]);
      expect((await flagsFor("pricing/claim.md", analyst)).summary.flags).toEqual([]);
      // The operator sees it.
      expect((await flagsFor("pricing/claim.md")).summary.flags).toEqual([
        "cites-contested-upstream",
      ]);
    });
  });
});

describe("receipt tool definition", () => {
  it("no longer claims empty flags mean grounded without naming what is checked", () => {
    const def = receiptTools.find((t) => t.name === "vault_receipt");
    expect(def?.description).toContain("cites-unverifiable-source");
    expect(def?.description).toContain("one hop");
    expect(def?.description).not.toContain("empty flags mean current, grounded, uncontested");
  });

  it("registers vault_receipt as a read-only tool", () => {
    const def = receiptTools.find((t) => t.name === "vault_receipt");
    expect(def).toBeDefined();
    expect(def?.annotations?.readOnlyHint).toBe(true);
    expect(def?.inputSchema).toMatchObject({ required: ["paths"] });
  });
});

// #298: operator-key receipt signing. When DAFTARI_ATTEST_KEY names a usable
// Ed25519 key, the receipt carries a signature over the exact payload bytes
// already hashed into receiptHash; unset, the output is byte-unchanged.
describe("receipt signing (#298)", () => {
  let vault: string;
  let keyDir: string;
  const prevEnv = process.env.DAFTARI_ATTEST_KEY;
  beforeEach(() => {
    vault = makeTempVault();
    keyDir = mkdtempSync(join(tmpdir(), "daftari-receiptkeys-"));
  });
  afterEach(() => {
    cleanupVault(vault);
    rmSync(keyDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.DAFTARI_ATTEST_KEY;
    else process.env.DAFTARI_ATTEST_KEY = prevEnv;
  });

  it("signs the payload when the key env is set, verifiably", async () => {
    const made = generateAttestKeys(keyDir);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    process.env.DAFTARI_ATTEST_KEY = made.value.keyPath;

    writeDoc(vault, "pricing/signed.md");
    const result = await vaultReceipt(vault, { paths: ["pricing/signed.md"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { receiptHash, signature, ...payload } = result.value as Record<string, unknown> & {
      receiptHash: string;
      signature?: { algorithm: string; keyId: string; publicKey: string; value: string };
    };
    expect(signature).toBeDefined();
    if (!signature) return;
    expect(signature.algorithm).toBe("ed25519");
    expect(signature.keyId).toMatch(/^[0-9a-f]{16}$/);
    const bytes = JSON.stringify(payload);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(receiptHash);
    expect(verifyBytes(signature.publicKey, bytes, signature.value)).toBe(true);
  });

  it("is byte-unchanged without the env, and loud when the key is unusable", async () => {
    delete process.env.DAFTARI_ATTEST_KEY;
    writeDoc(vault, "pricing/unsigned.md");
    const unsigned = await vaultReceipt(vault, { paths: ["pricing/unsigned.md"] });
    expect(unsigned.ok).toBe(true);
    if (!unsigned.ok) return;
    expect((unsigned.value as { signature?: unknown }).signature).toBeUndefined();

    process.env.DAFTARI_ATTEST_KEY = join(keyDir, "does-not-exist.key");
    const broken = await vaultReceipt(vault, { paths: ["pricing/unsigned.md"] });
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.error.message).toContain("DAFTARI_ATTEST_KEY");
  });
});
