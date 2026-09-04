// Versioned AES-256-GCM persistence for provider tokens and connector metadata.
// The envelope is local, git-ignored state under .daftari; source document text
// is deliberately never written here.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import type {
  IntegrationState,
  OAuthState,
  ProviderName,
  ProviderState,
  SourceState,
} from "./types.js";

const STATE_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const stateTransactions = new Map<string, Promise<void>>();

interface StateEnvelope {
  version: number;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export function emptyIntegrationState(): IntegrationState {
  return { providers: {}, oauthStates: {} };
}

export function integrationStatePath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "integrations.state.enc");
}

/** Serializes every read/await/write transaction over the vault-wide encrypted envelope. */
export async function withIntegrationStateLock<T>(
  vaultRoot: string,
  action: () => Promise<T> | T,
): Promise<T> {
  const previous = stateTransactions.get(vaultRoot) ?? Promise.resolve();
  let release = (): void => undefined;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => turn);
  stateTransactions.set(vaultRoot, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (stateTransactions.get(vaultRoot) === tail) stateTransactions.delete(vaultRoot);
  }
}

function validKey(key: Buffer): Result<void, Error> {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    return err(new Error("integration state encryption key must be exactly 32 bytes"));
  }
  return ok(undefined);
}

// A base64 decoder is deliberately permissive (it accepts missing padding and
// ignores some invalid characters). Re-encoding and comparing byte-for-byte
// makes this an exact configuration format, so a typo cannot silently select a
// different key before AES-GCM is constructed.
export function resolveIntegrationStateKey(
  encryptionKeyEnv: string,
  environment: NodeJS.ProcessEnv = process.env,
): Result<Buffer, Error> {
  if (typeof encryptionKeyEnv !== "string" || encryptionKeyEnv.trim().length === 0) {
    return err(new Error("integration state encryption key environment variable must be named"));
  }
  const encoded = environment[encryptionKeyEnv];
  if (typeof encoded !== "string" || encoded.length === 0) {
    return err(
      new Error(
        `integration state encryption key environment variable ${encryptionKeyEnv} is not set`,
      ),
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.toString("base64") !== encoded) {
    return err(
      new Error(
        `integration state encryption key environment variable ${encryptionKeyEnv} must be canonical base64`,
      ),
    );
  }
  const keyResult = validKey(key);
  if (!keyResult.ok) return keyResult;
  return ok(key);
}

function asBase64(
  value: unknown,
  field: keyof Omit<StateEnvelope, "version">,
): Result<Buffer, Error> {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return err(new Error(`integration state envelope has an invalid ${field}`));
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0)
    return err(new Error(`integration state envelope has an invalid ${field}`));
  return ok(decoded);
}

function isProviderName(value: unknown): value is ProviderName {
  return value === "google" || value === "notion" || value === "m365";
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function validSourceState(value: unknown): value is SourceState {
  if (!isStringRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.revision === "string" &&
    typeof value.contentHash === "string" &&
    typeof value.available === "boolean" &&
    typeof value.lastSeenAt === "string" &&
    validOptionalString(value.lastDistillRunId)
  );
}

function validEnrollmentRecord(value: unknown): boolean {
  return (
    isStringRecord(value) &&
    typeof value.ref === "string" &&
    (value.kind === "file" || value.kind === "folder") &&
    typeof value.label === "string" &&
    typeof value.targetCollection === "string" &&
    typeof value.enrolledAt === "string" &&
    typeof value.enrolledBy === "string"
  );
}

function validProviderState(value: unknown): value is ProviderState {
  if (
    !isStringRecord(value) ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string"
  ) {
    return false;
  }
  if (
    !validOptionalString(value.accessTokenExpiresAt) ||
    !validOptionalString(value.cursor) ||
    !validOptionalString(value.webhookSetupToken) ||
    (value.webhookSetupToken !== undefined && value.webhookSetupToken.length < 16)
  )
    return false;
  if (
    value.enrollment !== undefined &&
    (!Array.isArray(value.enrollment) || !value.enrollment.every(validEnrollmentRecord))
  )
    return false;
  if (value.adapterData !== undefined && !isStringRecord(value.adapterData)) return false;
  if (!isStringRecord(value.sources) || !Object.values(value.sources).every(validSourceState))
    return false;
  if (value.webhook === undefined) return true;
  if (value.webhookSetupToken !== undefined) return false;
  return (
    isStringRecord(value.webhook) &&
    typeof value.webhook.id === "string" &&
    typeof value.webhook.secret === "string" &&
    validOptionalString(value.webhook.expiresAt) &&
    (value.webhook.verificationRequired === undefined ||
      typeof value.webhook.verificationRequired === "boolean")
  );
}

function validOAuthState(value: unknown): value is OAuthState {
  return (
    isStringRecord(value) &&
    isProviderName(value.provider) &&
    typeof value.callbackNonce === "string" &&
    typeof value.pkceVerifier === "string" &&
    typeof value.expiresAt === "string"
  );
}

function parseState(value: unknown): Result<IntegrationState, Error> {
  if (
    !isStringRecord(value) ||
    !isStringRecord(value.providers) ||
    !isStringRecord(value.oauthStates)
  ) {
    return err(new Error("integration state plaintext has an invalid shape"));
  }
  for (const [provider, state] of Object.entries(value.providers)) {
    if (!isProviderName(provider) || !validProviderState(state)) {
      return err(new Error("integration state plaintext has an invalid provider entry"));
    }
  }
  if (!Object.values(value.oauthStates).every(validOAuthState)) {
    return err(new Error("integration state plaintext has an invalid OAuth entry"));
  }
  return ok(value as unknown as IntegrationState);
}

function readEnvelope(vaultRoot: string): Result<StateEnvelope | null, Error> {
  const path = integrationStatePath(vaultRoot);
  if (!existsSync(path)) return ok(null);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isStringRecord(raw) || raw.version !== STATE_VERSION) {
      return err(new Error("integration state envelope has an unsupported version"));
    }
    const nonce = asBase64(raw.nonce, "nonce");
    if (!nonce.ok) return nonce;
    const ciphertext = asBase64(raw.ciphertext, "ciphertext");
    if (!ciphertext.ok) return ciphertext;
    const tag = asBase64(raw.tag, "tag");
    if (!tag.ok) return tag;
    if (nonce.value.length !== NONCE_BYTES || tag.value.length !== TAG_BYTES) {
      return err(new Error("integration state envelope has invalid AES-GCM parameters"));
    }
    return ok({
      version: STATE_VERSION,
      nonce: nonce.value.toString("base64"),
      ciphertext: ciphertext.value.toString("base64"),
      tag: tag.value.toString("base64"),
    });
  } catch {
    return err(new Error("cannot read integration state envelope"));
  }
}

export function readIntegrationState(
  vaultRoot: string,
  key: Buffer,
): Result<IntegrationState, Error> {
  const keyResult = validKey(key);
  if (!keyResult.ok) return keyResult;
  const envelope = readEnvelope(vaultRoot);
  if (!envelope.ok) return envelope;
  if (envelope.value === null) return ok(emptyIntegrationState());

  try {
    const nonce = Buffer.from(envelope.value.nonce, "base64");
    const ciphertext = Buffer.from(envelope.value.ciphertext, "base64");
    const tag = Buffer.from(envelope.value.tag, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return parseState(JSON.parse(plaintext.toString("utf8")) as unknown);
  } catch {
    return err(new Error("cannot decrypt integration state"));
  }
}

export function writeIntegrationState(
  vaultRoot: string,
  state: IntegrationState,
  key: Buffer,
): Result<void, Error> {
  if (typeof vaultRoot !== "string" || vaultRoot.trim().length === 0) {
    return err(new Error("writeIntegrationState requires a non-empty vaultRoot"));
  }
  const keyResult = validKey(key);
  if (!keyResult.ok) return keyResult;
  const parsedState = parseState(state);
  if (!parsedState.ok) return parsedState;

  let tempPath: string | undefined;
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(parsedState.value), "utf8"),
      cipher.final(),
    ]);
    const envelope: StateEnvelope = {
      version: STATE_VERSION,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    const path = integrationStatePath(vaultRoot);
    mkdirSync(dirname(path), { recursive: true });
    tempPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
    tempPath = undefined;
    return ok(undefined);
  } catch {
    if (tempPath !== undefined) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Preserve the primary state-write failure. The ignore rule keeps a
        // best-effort cleanup failure out of version control.
      }
    }
    return err(new Error("cannot write encrypted integration state"));
  }
}
