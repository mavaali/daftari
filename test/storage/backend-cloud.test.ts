// The s3 and azure backend client logic (#6): pagination, prefix stripping,
// and not-found mapping. The real SDKs are optional peer deps that are never
// installed here, so vi.mock supplies fake modules and the dynamic import in
// createBackend resolves to them — exercising the code inside the backends,
// not just the missing-dependency refusal (which test/storage/backend.test.ts
// keeps, un-mocked).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackend } from "../../src/storage/backend.js";

// One shared object store per fake SDK, reset between tests.
const s3Store = new Map<string, Buffer>();
const azureStore = new Map<string, Buffer>();

vi.mock("@aws-sdk/client-s3", () => {
  const PAGE = 2; // small page size so list() must paginate
  function S3Client(_opts: unknown) {
    return {
      send: async (cmd: { kind: string; input: Record<string, unknown> }) => {
        const key = cmd.input.Key as string;
        if (cmd.kind === "get") {
          const found = s3Store.get(key);
          if (!found) {
            const e = new Error("no such key");
            (e as { name: string }).name = "NoSuchKey";
            throw e;
          }
          return { Body: { transformToByteArray: async () => new Uint8Array(found) } };
        }
        if (cmd.kind === "put") {
          s3Store.set(key, Buffer.from(cmd.input.Body as Buffer));
          return {};
        }
        if (cmd.kind === "delete") {
          s3Store.delete(key);
          return {};
        }
        // list: paginate sorted keys under Prefix
        const prefix = (cmd.input.Prefix as string) ?? "";
        const all = [...s3Store.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = cmd.input.ContinuationToken ? Number(cmd.input.ContinuationToken) : 0;
        const page = all.slice(start, start + PAGE);
        const truncated = start + PAGE < all.length;
        return {
          Contents: page.map((k) => ({ Key: k })),
          IsTruncated: truncated,
          NextContinuationToken: truncated ? String(start + PAGE) : undefined,
        };
      },
    };
  }
  const command = (kind: string) =>
    function Command(input: Record<string, unknown>) {
      return { kind, input };
    };
  return {
    S3Client,
    GetObjectCommand: command("get"),
    PutObjectCommand: command("put"),
    DeleteObjectCommand: command("delete"),
    ListObjectsV2Command: command("list"),
  };
});

vi.mock("@azure/storage-blob", () => {
  function containerClient() {
    return {
      getBlockBlobClient: (name: string) => ({
        uploadData: async (data: Buffer) => {
          azureStore.set(name, Buffer.from(data));
        },
        downloadToBuffer: async () => {
          const found = azureStore.get(name);
          if (!found) {
            const e = new Error("not found");
            (e as { statusCode: number }).statusCode = 404;
            throw e;
          }
          return found;
        },
        deleteIfExists: async () => {
          azureStore.delete(name);
        },
      }),
      listBlobsFlat: ({ prefix }: { prefix: string }) => {
        const names = [...azureStore.keys()].filter((k) => k.startsWith(prefix)).sort();
        return (async function* () {
          for (const name of names) yield { name };
        })();
      },
    };
  }
  return {
    BlobServiceClient: {
      fromConnectionString: (_conn: string) => ({ getContainerClient: () => containerClient() }),
    },
  };
});

describe("s3 backend client logic (mocked SDK)", () => {
  beforeEach(() => {
    s3Store.clear();
  });

  it("round-trips with a prefix, maps NoSuchKey to null, paginates list", async () => {
    const created = await createBackend({ backend: "s3", bucket: "b", prefix: "team/" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const backend = created.value;

    expect((await backend.put("tree/a.md", Buffer.from("a"))).ok).toBe(true);
    expect(s3Store.has("team/tree/a.md")).toBe(true); // prefix applied on the wire

    const got = await backend.get("tree/a.md");
    expect(got.ok && got.value?.toString()).toBe("a");
    const missing = await backend.get("tree/nope.md");
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.value).toBeNull();

    // 5 keys with page size 2 → three pages; keys come back prefix-stripped.
    for (const n of ["b", "c", "d", "e"]) {
      await backend.put(`tree/${n}.md`, Buffer.from(n));
    }
    const listed = await backend.list("tree/");
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.sort()).toEqual([
        "tree/a.md",
        "tree/b.md",
        "tree/c.md",
        "tree/d.md",
        "tree/e.md",
      ]);
    }

    expect((await backend.delete("tree/a.md")).ok).toBe(true);
    const afterDelete = await backend.get("tree/a.md");
    if (afterDelete.ok) expect(afterDelete.value).toBeNull();
  });
});

describe("azure backend client logic (mocked SDK)", () => {
  beforeEach(() => {
    azureStore.clear();
    process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
  });

  afterEach(() => {
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  });

  it("round-trips with a prefix, maps 404 to null, strips prefix on list", async () => {
    const created = await createBackend({ backend: "azure", container: "c", prefix: "team" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const backend = created.value;

    expect((await backend.put("tree/a.md", Buffer.from("a"))).ok).toBe(true);
    expect(azureStore.has("team/tree/a.md")).toBe(true);

    const got = await backend.get("tree/a.md");
    expect(got.ok && got.value?.toString()).toBe("a");
    const missing = await backend.get("tree/nope.md");
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.value).toBeNull();

    await backend.put("tree/b.md", Buffer.from("b"));
    const listed = await backend.list("tree/");
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.sort()).toEqual(["tree/a.md", "tree/b.md"]);

    expect((await backend.delete("tree/a.md")).ok).toBe(true);
    const afterDelete = await backend.get("tree/a.md");
    if (afterDelete.ok) expect(afterDelete.value).toBeNull();
  });

  it("without the connection string env var the backend refuses", async () => {
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    const created = await createBackend({ backend: "azure", container: "c" });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.message).toContain("AZURE_STORAGE_CONNECTION_STRING");
  });
});
