// Attestation signing primitives (#298): Ed25519 via node:crypto — no new
// dependency, the sibling of utils/hash.ts. Key material lives on disk at a
// path named by DAFTARI_ATTEST_KEY (or --key), NEVER in .daftari/config.yaml:
// config is committed vault state, and secrets never ride the vault (the
// server.auth.tokens env-var precedent). Unset env = signing off everywhere;
// set-but-unusable = loud failure at the entry point.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";

export interface AttestKey {
  privateKey: KeyObject;
  publicKeyPem: string;
  keyId: string;
}

// 16 hex of sha256 over the public key's DER (SPKI) bytes — enough to name a
// key in logs and bundles, useless for reconstruction.
export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export function generateAttestKeys(
  outDir: string,
): Result<{ keyPath: string; pubPath: string }, Error> {
  const keyPath = join(outDir, "attest.key");
  const pubPath = join(outDir, "attest.pub");
  if (existsSync(keyPath) || existsSync(pubPath)) {
    return err(
      new Error(`attest keygen: refusing to overwrite existing key material in ${outDir}`),
    );
  }
  try {
    mkdirSync(outDir, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));
    return ok({ keyPath, pubPath });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`attest keygen failed: ${reason}`));
  }
}

export function loadAttestKey(path: string): Result<AttestKey, Error> {
  let pem: string;
  try {
    pem = readFileSync(path, "utf-8");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read attest key at ${path}: ${reason}`));
  }
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      return err(
        new Error(
          `attest key at ${path} is ${privateKey.asymmetricKeyType ?? "unknown"}, expected ed25519`,
        ),
      );
    }
    const publicKeyPem = createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString();
    return ok({ privateKey, publicKeyPem, keyId: keyIdOf(publicKeyPem) });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`attest key at ${path} is not a usable private key: ${reason}`));
  }
}

export function signBytes(key: AttestKey, bytes: Buffer | string): string {
  const data = typeof bytes === "string" ? Buffer.from(bytes, "utf-8") : bytes;
  // Ed25519 signs the message directly — algorithm argument is null.
  return cryptoSign(null, data, key.privateKey).toString("base64");
}

export function verifyBytes(
  publicKeyPem: string,
  bytes: Buffer | string,
  signatureB64: string,
): boolean {
  try {
    const data = typeof bytes === "string" ? Buffer.from(bytes, "utf-8") : bytes;
    return cryptoVerify(
      null,
      data,
      createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}
