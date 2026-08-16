// Offline verification of an attestation bundle (#298). Read-only by
// construction: no writes, no locks, no process lock, no index. The exit-code
// split is the contract — scripts must distinguish FORGED from STALE:
//   0 verified · 1 cryptographic/authenticity failure · 2 usage/malformed ·
//   3 runtime (the Result error path) · 4 signature-valid-but-content-drifted.
// Partial verification is a first-class outcome: per-doc results are reported
// individually (match / modified / missing / unlisted), never summarized away.

import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadDocuments } from "../curation/vault-docs.js";
import { ok, type Result } from "../frontmatter/types.js";
import { blobExists, isGitRepo } from "../utils/git.js";
import { sha256Hex } from "../utils/hash.js";
import { ATTEST_FORMAT, type AttestEnvelope, manifestBytes } from "./bundle.js";
import { keyIdOf, verifyBytes } from "./sign.js";

export type VerifyState =
  | "verified"
  | "content-drift"
  | "signature-invalid"
  | "key-mismatch"
  | "malformed";

export interface VerifyReport {
  state: VerifyState;
  exitCode: 0 | 1 | 2 | 4;
  detail: string;
  keyId?: string;
  // False when no --pubkey was pinned: the signature then proves INTEGRITY
  // (nobody altered the bundle), not IDENTITY (who signed it).
  identityPinned: boolean;
  docs?: { match: string[]; modified: string[]; missing: string[]; unlisted: string[] };
  headKnown?: boolean;
}

function samePublicKey(aPem: string, bPem: string): boolean {
  try {
    const a = createPublicKey(aPem).export({ type: "spki", format: "der" });
    const b = createPublicKey(bPem).export({ type: "spki", format: "der" });
    return a.equals(b);
  } catch {
    return false;
  }
}

export async function verifyBundle(
  bundleRaw: string,
  opts: { vaultRoot?: string; pubkeyPem?: string },
): Promise<Result<VerifyReport, Error>> {
  // 1. Envelope shape.
  let envelope: AttestEnvelope;
  try {
    envelope = JSON.parse(bundleRaw) as AttestEnvelope;
  } catch {
    return ok({
      state: "malformed",
      exitCode: 2,
      detail: "bundle is not valid JSON",
      identityPinned: false,
    });
  }
  if (
    envelope?.format !== ATTEST_FORMAT ||
    typeof envelope.manifest !== "object" ||
    envelope.manifest === null ||
    typeof envelope.signature?.value !== "string" ||
    typeof envelope.manifest.signer?.publicKey !== "string"
  ) {
    return ok({
      state: "malformed",
      exitCode: 2,
      detail: `bundle is not a ${ATTEST_FORMAT} envelope`,
      identityPinned: false,
    });
  }

  // 2. Signature over the re-stringified manifest, with the embedded key.
  const signerPem = envelope.manifest.signer.publicKey;
  const keyId = keyIdOf(signerPem);
  const bytes = manifestBytes(envelope.manifest);
  // BOTH keyId fields must bind to the embedded key — a cosmetic
  // signer.keyId that names a different key is a confusion vector.
  if (
    keyId !== envelope.signature.keyId ||
    keyId !== envelope.manifest.signer.keyId ||
    !verifyBytes(signerPem, bytes, envelope.signature.value)
  ) {
    return ok({
      state: "signature-invalid",
      exitCode: 1,
      detail: "signature does not verify over the manifest bytes",
      keyId,
      identityPinned: false,
    });
  }

  // 3. Identity pinning.
  const identityPinned = opts.pubkeyPem !== undefined;
  if (opts.pubkeyPem !== undefined && !samePublicKey(signerPem, opts.pubkeyPem)) {
    return ok({
      state: "key-mismatch",
      exitCode: 1,
      detail:
        "signature is valid but the embedded key is not the pinned one — " +
        "right bundle shape, wrong signer",
      keyId,
      identityPinned: true,
    });
  }

  // 4. Signature-only mode.
  if (opts.vaultRoot === undefined) {
    return ok({
      state: "verified",
      exitCode: 0,
      detail: identityPinned
        ? "signature verified against the pinned key (no vault checked)"
        : "identity unpinned: signature proves integrity, not signer (no vault checked)",
      keyId,
      identityPinned,
    });
  }

  // 5. Per-doc content against the vault copy. Doc paths come from the
  // (attacker-suppliable) bundle: an absolute or escaping path would turn
  // the match/modified report into a one-bit file oracle OUTSIDE the vault,
  // so any such path makes the whole bundle malformed — never read.
  const vaultRoot = opts.vaultRoot;
  for (const doc of envelope.manifest.docs) {
    const abs = resolve(vaultRoot, doc.path);
    const rel = relative(resolve(vaultRoot), abs);
    if (isAbsolute(doc.path) || rel.startsWith("..") || isAbsolute(rel) || rel === "") {
      return ok({
        state: "malformed",
        exitCode: 2,
        detail: `manifest names a path outside the vault: ${doc.path}`,
        keyId,
        identityPinned,
      });
    }
  }
  const match: string[] = [];
  const modified: string[] = [];
  const missing: string[] = [];
  for (const doc of envelope.manifest.docs) {
    try {
      const raw = await readFile(resolve(vaultRoot, doc.path), "utf-8");
      if (sha256Hex(raw) === doc.contentHash) match.push(doc.path);
      else modified.push(doc.path);
    } catch {
      missing.push(doc.path);
    }
  }
  const listed = new Set(envelope.manifest.docs.map((d) => d.path));
  const present = await loadDocuments(vaultRoot);
  const unlisted = present.ok ? present.value.map((d) => d.path).filter((p) => !listed.has(p)) : [];

  // 6. Head anchoring (informational).
  let headKnown = false;
  if (await isGitRepo(vaultRoot)) {
    headKnown = await blobExists(vaultRoot, envelope.manifest.headCommit);
  }

  const drift = modified.length > 0 || missing.length > 0 || unlisted.length > 0 || !headKnown;
  return ok({
    state: drift ? "content-drift" : "verified",
    exitCode: drift ? 4 : 0,
    detail: drift
      ? "signature valid; the vault has moved since attestation (stale, not forged)"
      : "signature valid and every listed doc matches the vault copy",
    keyId,
    identityPinned,
    docs: { match, modified, missing, unlisted },
    headKnown,
  });
}
