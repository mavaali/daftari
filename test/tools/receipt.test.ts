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
    body: `---\n${lines.join("\n")}\nsources: []\ntags: []\n---\n\nBody of ${relPath}.\n`,
  };
}

function writeDoc(vault: string, relPath: string, overrides: Record<string, string | null> = {}) {
  const d = doc(relPath, overrides);
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

describe("receipt tool definition", () => {
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
