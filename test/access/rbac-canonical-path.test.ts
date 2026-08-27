import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { DOC_URI_PREFIX, readResource } from "../../src/resources.js";
import { vaultRead } from "../../src/tools/read.js";

// Finding F1 (mavaali-beads-3p4.1): RBAC read bypass through noncanonical
// paths. The filesystem read canonicalizes `..` (public/../restricted →
// restricted), but both read surfaces derived the RBAC collection from the
// RAW caller path, so the first segment `public` was checked while the
// canonical `restricted/secret.md` was returned. The bypass only surfaces
// when the target has no usable `collection` frontmatter, so the path-segment
// fallback in collectionOf() activates — hence the metadata variants below.

// A role that may read `public` but NOT `restricted`.
const PUBLIC_READER: AccessContext = {
  user: "human:test",
  roleName: "public-reader",
  role: { read: ["public"], write: [], promote: false, ratify: false },
};

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-f1-"));
  mkdirSync(join(vault, "public"), { recursive: true });
  mkdirSync(join(vault, "restricted"), { recursive: true });
  writeFileSync(join(vault, "public", "allowed.md"), "# Public\n\nreadable\n", "utf-8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

// Each variant is a `restricted/secret.md` whose collection metadata is
// missing / empty / non-string, forcing collectionOf()'s path fallback.
const VARIANTS: Array<{ name: string; body: string }> = [
  { name: "no frontmatter", body: "# Secret\n\ntop secret\n" },
  { name: "empty collection", body: '---\ncollection: ""\n---\n\ntop secret\n' },
  {
    name: "non-string collection",
    body: "---\ncollection: 123\n---\n\ntop secret\n",
  },
];

describe("F1: canonical-path RBAC on vault_read", () => {
  for (const variant of VARIANTS) {
    it(`denies the .. alias for a ${variant.name} restricted doc`, async () => {
      writeFileSync(join(vault, "restricted", "secret.md"), variant.body, "utf-8");

      // Sanity: the direct path is denied.
      const direct = await vaultRead(vault, "restricted/secret.md", PUBLIC_READER);
      expect(direct.ok).toBe(false);

      // The alias must ALSO be denied — it resolves to the same restricted doc.
      const aliased = await vaultRead(vault, "public/../restricted/secret.md", PUBLIC_READER);
      expect(aliased.ok).toBe(false);
      if (aliased.ok) return;
      expect(aliased.error.message).toContain("access denied");
    });
  }

  it("still allows a genuine public read", async () => {
    const ok = await vaultRead(vault, "public/allowed.md", PUBLIC_READER);
    expect(ok.ok).toBe(true);
  });
});

describe("F1: canonical-path RBAC on resources/read", () => {
  for (const variant of VARIANTS) {
    it(`denies the .. alias for a ${variant.name} restricted doc`, async () => {
      writeFileSync(join(vault, "restricted", "secret.md"), variant.body, "utf-8");

      const direct = await readResource(
        vault,
        `${DOC_URI_PREFIX}restricted/secret.md`,
        PUBLIC_READER,
      );
      expect(direct.ok).toBe(false);

      // The resource surface reports denial as not-found (no existence leak);
      // the key assertion is simply that the secret does not come back.
      const aliased = await readResource(
        vault,
        `${DOC_URI_PREFIX}public/../restricted/secret.md`,
        PUBLIC_READER,
      );
      expect(aliased.ok).toBe(false);
    });
  }
});
