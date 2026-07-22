// Pluggable storage backends (#6, spec Decision 3 —
// docs/superpowers/specs/2026-07-20-self-hosted-server-mode-design.md).
//
// The local git working copy is CANONICAL. A backend is nothing but a dumb,
// durable key-value target the sync engine pushes to: get/put/list/delete
// over opaque keys. No backend understands markdown, frontmatter, git, or
// locks — provenance stays git, the index stays local and ephemeral, and the
// single-instance process lock stays local SQLite.
//
// Shipped backends:
//   fs    — a local/mounted directory (also the test double)
//   s3    — Amazon S3 and every S3-compatible store (GCS interop endpoint,
//           MinIO, Cloudflare R2) via @aws-sdk/client-s3 (optional dep)
//   azure — Azure Blob Storage / ADLS Gen2 via @azure/storage-blob
//           (optional dep)
//
// The cloud SDKs are OPTIONAL peer dependencies loaded with a dynamic
// import at backend creation, so the core install stays light; a missing
// SDK is a clear startup error naming the install command, never a crash
// mid-sync. Credentials are never read from vault config — the SDKs use
// their standard environment/instance chains (AWS_*, AZURE_STORAGE_*).

import { err, ok, type Result } from "../frontmatter/types.js";
import type { StorageConfig } from "../utils/config.js";

export interface StorageBackend {
  // Human-readable target description for logs/errors ("s3://bucket/prefix").
  id: string;
  // Returns null (not an error) when the key does not exist.
  get(key: string): Promise<Result<Buffer | null, Error>>;
  put(key: string, data: Buffer): Promise<Result<void, Error>>;
  // All keys under the prefix, in no guaranteed order.
  list(prefix: string): Promise<Result<string[], Error>>;
  // Deleting a missing key succeeds — deletes are idempotent.
  delete(key: string): Promise<Result<void, Error>>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// A plaintext-http endpoint off-loopback hands the vault bytes (and, with
// some providers, signable credentials material) to any network-position
// attacker — the same posture as serve's OAuth URL gate: https only, with
// loopback http as the sole escape hatch (a local MinIO test store; Azurite
// is reached via its connection string, not this setting).
export function validateEndpoint(endpoint: string): Result<void, Error> {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return err(new Error(`storage.endpoint: '${endpoint}' is not a valid URL`));
  }
  const bare = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(bare))) {
    return err(
      new Error(
        `storage.endpoint: '${endpoint}' must use https ` +
          `(plain http is allowed only for loopback test stores)`,
      ),
    );
  }
  return ok(undefined);
}

// Dynamic import through a variable specifier so tsc does not require the
// optional SDK to be installed to compile, and bundlers do not force it into
// the graph. Returns the module or a friendly install instruction.
async function importOptional(pkg: string, forBackend: string): Promise<Result<unknown, Error>> {
  const specifier = pkg;
  try {
    return ok(await import(specifier));
  } catch {
    return err(
      new Error(
        `storage backend '${forBackend}' requires the optional dependency ` +
          `${pkg} — install it with: npm install ${pkg}`,
      ),
    );
  }
}

function joinPrefix(prefix: string | undefined, key: string): string {
  if (!prefix) return key;
  return `${prefix.replace(/\/+$/, "")}/${key}`;
}

// ---------------------------------------------------------------------------
// s3 — S3 and S3-compatibles (GCS interop, MinIO, R2)
// ---------------------------------------------------------------------------

interface S3ish {
  send(command: unknown): Promise<{
    Body?: { transformToByteArray(): Promise<Uint8Array> };
    Contents?: { Key?: string }[];
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  }>;
}

async function createS3Backend(config: StorageConfig): Promise<Result<StorageBackend, Error>> {
  const imported = await importOptional("@aws-sdk/client-s3", "s3");
  if (!imported.ok) return imported;
  const mod = imported.value as {
    S3Client: new (opts: Record<string, unknown>) => S3ish;
    GetObjectCommand: new (input: Record<string, unknown>) => unknown;
    PutObjectCommand: new (input: Record<string, unknown>) => unknown;
    DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
    ListObjectsV2Command: new (input: Record<string, unknown>) => unknown;
  };
  const bucket = config.bucket as string;
  const client = new mod.S3Client({
    ...(config.region ? { region: config.region } : {}),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
  });
  const full = (key: string) => joinPrefix(config.prefix, key);
  const id = `s3://${bucket}${config.prefix ? `/${config.prefix}` : ""}`;

  return ok({
    id,
    async get(key) {
      try {
        const res = await client.send(new mod.GetObjectCommand({ Bucket: bucket, Key: full(key) }));
        if (!res.Body) return ok(null);
        return ok(Buffer.from(await res.Body.transformToByteArray()));
      } catch (e) {
        const name = (e as { name?: string }).name;
        if (name === "NoSuchKey" || name === "NotFound") return ok(null);
        return err(new Error(`s3 get ${key}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
    async put(key, data) {
      try {
        await client.send(new mod.PutObjectCommand({ Bucket: bucket, Key: full(key), Body: data }));
        return ok(undefined);
      } catch (e) {
        return err(new Error(`s3 put ${key}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
    async list(prefix) {
      const keys: string[] = [];
      const strip = config.prefix ? `${config.prefix.replace(/\/+$/, "")}/` : "";
      let token: string | undefined;
      try {
        do {
          const res = await client.send(
            new mod.ListObjectsV2Command({
              Bucket: bucket,
              Prefix: full(prefix),
              ...(token ? { ContinuationToken: token } : {}),
            }),
          );
          for (const obj of res.Contents ?? []) {
            if (obj.Key)
              keys.push(strip && obj.Key.startsWith(strip) ? obj.Key.slice(strip.length) : obj.Key);
          }
          token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token);
        return ok(keys);
      } catch (e) {
        return err(new Error(`s3 list ${prefix}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
    async delete(key) {
      try {
        await client.send(new mod.DeleteObjectCommand({ Bucket: bucket, Key: full(key) }));
        return ok(undefined);
      } catch (e) {
        return err(new Error(`s3 delete ${key}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// azure — Azure Blob Storage / ADLS Gen2
// ---------------------------------------------------------------------------

interface AzureContainerish {
  getBlockBlobClient(name: string): {
    uploadData(data: Buffer): Promise<unknown>;
    downloadToBuffer(): Promise<Buffer>;
    deleteIfExists(): Promise<unknown>;
  };
  listBlobsFlat(opts: { prefix: string }): AsyncIterable<{ name: string }>;
}

async function createAzureBackend(config: StorageConfig): Promise<Result<StorageBackend, Error>> {
  const imported = await importOptional("@azure/storage-blob", "azure");
  if (!imported.ok) return imported;
  const mod = imported.value as {
    BlobServiceClient: {
      fromConnectionString(conn: string): {
        getContainerClient(name: string): AzureContainerish;
      };
    };
  };
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) {
    return err(
      new Error(
        "storage backend 'azure' requires the AZURE_STORAGE_CONNECTION_STRING " +
          "environment variable (credentials never live in vault config)",
      ),
    );
  }
  const container = config.container as string;
  let containerClient: AzureContainerish;
  try {
    containerClient =
      mod.BlobServiceClient.fromConnectionString(conn).getContainerClient(container);
  } catch (e) {
    return err(new Error(`azure: ${e instanceof Error ? e.message : String(e)}`));
  }
  const full = (key: string) => joinPrefix(config.prefix, key);
  const strip = config.prefix ? `${config.prefix.replace(/\/+$/, "")}/` : "";
  const id = `azure://${container}${config.prefix ? `/${config.prefix}` : ""}`;

  return ok({
    id,
    async get(key) {
      try {
        return ok(await containerClient.getBlockBlobClient(full(key)).downloadToBuffer());
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404) return ok(null);
        return err(new Error(`azure get ${key}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
    async put(key, data) {
      try {
        await containerClient.getBlockBlobClient(full(key)).uploadData(data);
        return ok(undefined);
      } catch (e) {
        return err(new Error(`azure put ${key}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
    async list(prefix) {
      const keys: string[] = [];
      try {
        for await (const blob of containerClient.listBlobsFlat({ prefix: full(prefix) })) {
          keys.push(
            strip && blob.name.startsWith(strip) ? blob.name.slice(strip.length) : blob.name,
          );
        }
        return ok(keys);
      } catch (e) {
        return err(
          new Error(`azure list ${prefix}: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    },
    async delete(key) {
      try {
        await containerClient.getBlockBlobClient(full(key)).deleteIfExists();
        return ok(undefined);
      } catch (e) {
        return err(new Error(`azure delete ${key}: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export async function createBackend(config: StorageConfig): Promise<Result<StorageBackend, Error>> {
  if (config.endpoint !== undefined) {
    // `endpoint` is an S3-family concept (MinIO, R2, GCS interop). The azure
    // client's endpoint travels inside AZURE_STORAGE_CONNECTION_STRING, and
    // fs has no endpoint at all — a setting that would be silently ignored
    // refuses instead.
    if (config.backend !== "s3") {
      return err(
        new Error(
          `storage.endpoint is only used by the s3 backend — for ${config.backend}, ` +
            (config.backend === "azure"
              ? "the endpoint is part of AZURE_STORAGE_CONNECTION_STRING"
              : "remove it"),
        ),
      );
    }
    const gate = validateEndpoint(config.endpoint);
    if (!gate.ok) return gate;
  }
  switch (config.backend) {
    case "fs": {
      const { createFsBackend } = await import("./backends/fs.js");
      return createFsBackend(config.path as string, config.prefix);
    }
    case "s3":
      return createS3Backend(config);
    case "azure":
      return createAzureBackend(config);
  }
}
