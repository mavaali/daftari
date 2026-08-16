// `daftari attest` (#298) — operator-only CLI, the court/sync posture: no
// access context, never exposed over MCP (the bundle names every doc path —
// existence disclosure — and exercises operator key material).
//
// Exit codes (the verify contract): 0 verified/produced · 1 cryptographic or
// authenticity failure · 2 usage/malformed · 3 runtime · 4 signature-valid-
// but-content-drifted.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFlag } from "../index.js";
import { SERVER_VERSION } from "../server.js";
import { dataHome } from "../utils/config.js";
import { buildManifest, outPathInsideVault, signManifest } from "./bundle.js";
import { generateAttestKeys, loadAttestKey } from "./sign.js";
import { verifyBundle } from "./verify.js";

const HELP = `daftari attest — signed vault attestation bundles (#298).

Usage:
  daftari attest [--vault <path>] [--out <path>] [--key <path>]
  daftari attest verify <bundle.json> [--vault <path>] [--pubkey <pem-file>] [--key <path>]
  daftari attest keygen [--out <dir>]

The signing key is an Ed25519 private key (PKCS#8 PEM) at the path named by
DAFTARI_ATTEST_KEY (or --key). Keys never live in config.yaml — config is
committed vault state. The bundle is an OUTPUT artifact: writing it inside
the vault root is refused, so it can never become a second source of truth.

What a signature proves: the bundle is byte-identical to what the keyholder
produced, and the content hashes / sealed git history are the keyholder's
snapshot claims. It does NOT prove per-principal authorship or freshness —
the signer is the vault OPERATOR.
`;

function resolveKeyPath(argv: string[]): string | null {
  return parseFlag(argv, "key") ?? process.env.DAFTARI_ATTEST_KEY ?? null;
}

export async function runAttest(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (argv[0] === "keygen") {
    const outDir = parseFlag(argv, "out") ?? join(dataHome(), "daftari", "keys");
    const made = generateAttestKeys(outDir);
    if (!made.ok) {
      process.stderr.write(`daftari attest: ${made.error.message}\n`);
      return 2;
    }
    process.stdout.write(
      `wrote ${made.value.keyPath} (0600) and ${made.value.pubPath}\n` +
        `export DAFTARI_ATTEST_KEY=${made.value.keyPath}\n`,
    );
    return 0;
  }

  if (argv[0] === "verify") {
    const bundlePath = argv[1];
    if (!bundlePath || bundlePath.startsWith("--")) {
      process.stderr.write("daftari attest verify: a bundle path is required\n");
      return 2;
    }
    let bundleRaw: string;
    try {
      bundleRaw = readFileSync(bundlePath, "utf-8");
    } catch (e) {
      process.stderr.write(`daftari attest verify: cannot read ${bundlePath}: ${String(e)}\n`);
      return 2;
    }
    let pubkeyPem: string | undefined;
    const pubkeyPath = parseFlag(argv, "pubkey");
    const keyPath = resolveKeyPath(argv);
    if (pubkeyPath) {
      try {
        pubkeyPem = readFileSync(pubkeyPath, "utf-8");
      } catch (e) {
        process.stderr.write(`daftari attest verify: cannot read --pubkey: ${String(e)}\n`);
        return 2;
      }
    } else if (keyPath && existsSync(keyPath)) {
      // --key lets verify derive the expected public key from the private one.
      const key = loadAttestKey(keyPath);
      if (key.ok) pubkeyPem = key.value.publicKeyPem;
    }
    const vaultFlag = parseFlag(argv, "vault");
    const report = await verifyBundle(bundleRaw, {
      ...(vaultFlag ? { vaultRoot: resolve(vaultFlag) } : {}),
      ...(pubkeyPem !== undefined ? { pubkeyPem } : {}),
    });
    if (!report.ok) {
      process.stderr.write(`daftari attest verify: ${report.error.message}\n`);
      return 3;
    }
    const r = report.value;
    process.stdout.write(`${r.state}: ${r.detail}\n`);
    if (r.keyId) process.stdout.write(`keyId: ${r.keyId}${r.identityPinned ? " (pinned)" : ""}\n`);
    if (r.docs) {
      process.stdout.write(
        `docs: ${r.docs.match.length} match` +
          (r.docs.modified.length > 0 ? `, modified: ${r.docs.modified.join(", ")}` : "") +
          (r.docs.missing.length > 0 ? `, missing: ${r.docs.missing.join(", ")}` : "") +
          (r.docs.unlisted.length > 0 ? `, unlisted: ${r.docs.unlisted.join(", ")}` : "") +
          `\n`,
      );
      if (r.headKnown === false) process.stdout.write("head: unknown to this repository\n");
    }
    return r.exitCode;
  }

  // Default: produce a signed bundle.
  const vaultRoot = resolve(parseFlag(argv, "vault") ?? process.cwd());
  const keyPath = resolveKeyPath(argv);
  if (!keyPath) {
    process.stderr.write(
      "daftari attest: no signing key — set DAFTARI_ATTEST_KEY or pass --key " +
        "(generate one with `daftari attest keygen`)\n",
    );
    return 2;
  }
  const key = loadAttestKey(keyPath);
  if (!key.ok) {
    process.stderr.write(`daftari attest: ${key.error.message}\n`);
    return 2;
  }

  const manifest = await buildManifest(vaultRoot, { daftariVersion: SERVER_VERSION });
  if (!manifest.ok) {
    process.stderr.write(`daftari attest: ${manifest.error.message}\n`);
    return manifest.error.message.includes("dirty") ? 2 : 3;
  }
  const envelope = signManifest(manifest.value, key.value);

  const head8 = manifest.value.headCommit.slice(0, 8);
  const outPath = resolve(parseFlag(argv, "out") ?? `daftari-attestation-${head8}.json`);
  if (outPathInsideVault(vaultRoot, outPath)) {
    process.stderr.write(
      `daftari attest: refusing to write the bundle inside the vault root ` +
        `(${outPath}) — an attestation is an output artifact, never vault state\n`,
    );
    return 2;
  }
  writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`);
  process.stdout.write(
    `attested ${manifest.value.totals.docs} docs at ${head8} → ${outPath} ` +
      `(keyId ${key.value.keyId})\n`,
  );
  return 0;
}
