// The attestation bundle (#298 layer 2): a per-doc manifest — content hash,
// git history, ratification/contested status, open-tension counts — derived
// ENTIRELY from markdown bytes, git, and the vault's own tension log, signed
// once with the operator's Ed25519 key, verifiable offline.
//
// Never a second source of truth: every field is re-derivable by anyone
// holding the vault and its history. Git-ignored derived logs (curation-log,
// edges, staged-actions, read-log …) are structurally excluded — a guard
// test pins that poisoning them cannot move a single manifest byte.
//
// Threat model, stated plainly: the signer IS the vault operator. The
// signature proves the bundle is byte-identical to what the keyholder
// produced and that the content hashes / sealed history are the keyholder's
// snapshot claims. Because git commits chain, one signature over headCommit
// transitively seals every ancestor — including the authenticated-principal
// author fields commitIdentity records — as tamper-evident. It does NOT
// prove per-principal authorship, freshness, or non-rollback.
//
// Operator-only surface (the Tension Court precedent): the manifest names
// EVERY doc path in the vault, so it is a whole-vault operator export —
// role-scoped bundles are rejected in v1 (the 2026-07-14 small-cell
// disclosure analysis; revisit that spec before ever building them).
//
// The dirty-tree gate exempts `.daftari/`: the tension log is advisory
// operator state that nothing auto-commits, and its annotations in the
// manifest are snapshot claims like everything else. Doc files must be
// clean, or the content hashes and the head seal would be different claims.

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { listTensions } from "../curation/tension.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { headFullSha, historyByPath, isGitRepo, statusPorcelain } from "../utils/git.js";
import { sha256Hex } from "../utils/hash.js";
import { type AttestKey, signBytes } from "./sign.js";

export const ATTEST_FORMAT = "daftari.attestation/v1";

export interface AttestDocEntry {
  path: string;
  contentHash: string;
  status: string;
  confidence: string;
  provenance: string;
  contested: boolean;
  ratified: boolean;
  openTensions: number;
  git: {
    firstCommitDate: string;
    lastCommit: string;
    lastAuthor: string;
    lastDate: string;
    commitCount: number;
  } | null;
}

export interface AttestManifest {
  headCommit: string;
  generatedAt: string;
  daftariVersion: string;
  signer: { keyId: string; publicKey: string; algorithm: "ed25519" } | null;
  totals: { docs: number; contestedDocs: number; openTensions: number };
  docs: AttestDocEntry[];
}

export interface AttestEnvelope {
  format: typeof ATTEST_FORMAT;
  manifest: AttestManifest;
  signature: { algorithm: "ed25519"; keyId: string; value: string };
}

// The exact bytes the signature covers. JSON.stringify of the manifest as
// produced; verification re-stringifies the parsed manifest. Sound in JS
// because insertion order is preserved for non-integer-like keys and `docs`
// is an array — the canonical.test.ts round-trip pins the bet.
export function manifestBytes(manifest: unknown): string {
  return JSON.stringify(manifest);
}

// "Output artifact, never vault state", enforced structurally: an output
// path that resolves inside the vault root is refused, so a bundle can never
// be committed into the vault and minted into a second source of truth.
export function outPathInsideVault(vaultRoot: string, outPath: string): boolean {
  const rel = relative(resolve(vaultRoot), resolve(outPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function buildManifest(
  vaultRoot: string,
  opts: { daftariVersion: string; generatedAt?: string },
): Promise<Result<AttestManifest, Error>> {
  if (!(await isGitRepo(vaultRoot))) {
    return err(new Error("attest: the vault is not a git repository — nothing to seal"));
  }

  // Clean-tree gate: any dirty path OUTSIDE .daftari/ refuses, and names
  // the offenders — a bundle over uncommitted docs is unverifiable against
  // git by construction.
  const status = await statusPorcelain(vaultRoot);
  if (!status.ok) return status;
  // A porcelain rename line carries BOTH sides ("R  old -> new"); the
  // .daftari exemption applies only when EVERY involved path is under the
  // control dir, or a rename out of it would smuggle a dirty doc past the
  // gate. Quoted special-character paths are unquoted before the check.
  const unquote = (p: string): string =>
    p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  const exempt = (p: string): boolean => p.startsWith(".daftari/") || p === ".daftari";
  const dirty = status.value
    .flatMap((l) => l.slice(3).split(" -> ").map(unquote))
    .filter((p) => !exempt(p));
  if (dirty.length > 0) {
    return err(
      new Error(
        `attest: working tree is dirty — commit first (offending paths: ${dirty.join(", ")})`,
      ),
    );
  }

  const head = await headFullSha(vaultRoot);
  if (!head.ok) return head;

  const docs = await loadDocuments(vaultRoot);
  if (!docs.ok) return docs;
  const tensions = await listTensions(vaultRoot);
  if (!tensions.ok) return tensions;
  const history = await historyByPath(vaultRoot);
  if (!history.ok) return history;

  // Open tensions per doc path; totals count DISTINCT unresolved entries.
  const openByPath = new Map<string, number>();
  let openTotal = 0;
  for (const t of tensions.value) {
    if (t.resolved) continue;
    openTotal += 1;
    for (const p of new Set([t.sourceA, t.sourceB])) {
      openByPath.set(p, (openByPath.get(p) ?? 0) + 1);
    }
  }

  const entries: AttestDocEntry[] = [];
  for (const doc of docs.value) {
    const raw = await readFile(resolve(vaultRoot, doc.path), "utf-8");
    const fm = doc.frontmatter;
    entries.push({
      path: doc.path,
      contentHash: sha256Hex(raw),
      status: fm.status,
      confidence: fm.confidence,
      provenance: fm.provenance,
      contested: fm.contested ?? false,
      ratified: fm.org_position != null,
      openTensions: openByPath.get(doc.path) ?? 0,
      git: history.value.get(doc.path) ?? null,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return ok({
    headCommit: head.value,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    daftariVersion: opts.daftariVersion,
    signer: null, // filled by signManifest
    totals: {
      docs: entries.length,
      contestedDocs: entries.filter((e) => e.contested).length,
      openTensions: openTotal,
    },
    docs: entries,
  });
}

export function signManifest(manifest: AttestManifest, key: AttestKey): AttestEnvelope {
  const signed: AttestManifest = {
    ...manifest,
    signer: { keyId: key.keyId, publicKey: key.publicKeyPem, algorithm: "ed25519" },
  };
  return {
    format: ATTEST_FORMAT,
    manifest: signed,
    signature: {
      algorithm: "ed25519",
      keyId: key.keyId,
      value: signBytes(key, manifestBytes(signed)),
    },
  };
}
