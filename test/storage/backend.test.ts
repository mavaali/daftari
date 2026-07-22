// The backend factory's startup gates (#6): endpoint hygiene and the
// optional-SDK failure path. The fs backend's own contract lives in
// test/storage/backends/fs.test.ts, mirroring src/.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBackend, validateEndpoint } from "../../src/storage/backend.js";

describe("backend factory gates (#6)", () => {
  it("requires https endpoints, with loopback http as the sole escape hatch", () => {
    expect(validateEndpoint("https://s3.example.com").ok).toBe(true);
    expect(validateEndpoint("http://127.0.0.1:9000").ok).toBe(true);
    expect(validateEndpoint("http://[::1]:9000").ok).toBe(true);
    expect(validateEndpoint("http://minio.internal:9000").ok).toBe(false);
    expect(validateEndpoint("not a url").ok).toBe(false);
  });

  it("an endpoint on a non-s3 backend refuses instead of being silently ignored", async () => {
    const azure = await createBackend({
      backend: "azure",
      container: "c",
      endpoint: "https://azurite.local",
    });
    expect(azure.ok).toBe(false);
    if (!azure.ok) expect(azure.error.message).toContain("AZURE_STORAGE_CONNECTION_STRING");
  });

  it("the fs backend honors prefix (nested under path) and confines it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daftari-fs-prefix-"));
    try {
      const prefixed = await createBackend({ backend: "fs", path: dir, prefix: "team-a" });
      expect(prefixed.ok).toBe(true);
      if (!prefixed.ok) return;
      expect((await prefixed.value.put("tree/x.md", Buffer.from("x"))).ok).toBe(true);
      expect(existsSync(join(dir, "team-a", "tree", "x.md"))).toBe(true);

      const escaping = await createBackend({ backend: "fs", path: dir, prefix: "../out" });
      expect(escaping.ok).toBe(false);
      if (!escaping.ok) expect(escaping.error.message).toContain("escapes the fs path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing optional cloud SDK is a clear install instruction, not a crash", async () => {
    // The test environment never installs the optional SDKs, so this
    // exercises the real failure path an operator hits.
    const s3 = await createBackend({ backend: "s3", bucket: "b" });
    expect(s3.ok).toBe(false);
    if (!s3.ok) expect(s3.error.message).toContain("npm install @aws-sdk/client-s3");
  });
});
