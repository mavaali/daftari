import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { DOC_URI_PREFIX, readResource } from "../../src/resources.js";
import { vaultRead } from "../../src/tools/read.js";
import {
  vaultAppend,
  vaultDeprecate,
  vaultMerge,
  vaultPromote,
  vaultSetConfidence,
  vaultSetTier,
  vaultSupersede,
  vaultUnsupersede,
} from "../../src/tools/write.js";

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

const PUBLIC_WRITER_PROMOTER: AccessContext = {
  user: "human:test",
  roleName: "public-writer",
  role: { read: ["public"], write: ["public"], promote: true, ratify: false },
};

describe("canonical-path & collection RBAC on write lifecycle tools", () => {
  it("denies aliased public/../restricted writes across all lifecycle write tools", async () => {
    const secretContent =
      '---\ntitle: Secret\ndomain: accumulation\ncollection: ""\nstatus: draft\nconfidence: medium\ncreated: 2026-01-01\nupdated: 2026-01-01\nupdated_by: human:admin\nprovenance: direct\nsources: []\nsuperseded_by: null\nttl_days: null\n---\n\nsecret body\n';
    const supersededContent = secretContent.replace("status: draft", "status: superseded");
    writeFileSync(join(vault, "restricted", "secret.md"), secretContent, "utf-8");
    writeFileSync(join(vault, "restricted", "superseded.md"), supersededContent, "utf-8");
    writeFileSync(
      join(vault, "public", "successor.md"),
      secretContent.replace('collection: ""', 'collection: "public"'),
      "utf-8",
    );

    const alias = "public/../restricted/secret.md";
    const supersededAlias = "public/../restricted/superseded.md";

    const results = await Promise.all([
      vaultAppend(
        vault,
        { path: alias, section: "injected", agent: "human:test" },
        PUBLIC_WRITER_PROMOTER,
      ),
      vaultPromote(vault, { path: alias, agent: "human:test" }, PUBLIC_WRITER_PROMOTER),
      vaultDeprecate(
        vault,
        { path: alias, agent: "human:test", reason: "test" },
        PUBLIC_WRITER_PROMOTER,
      ),
      vaultSetConfidence(
        vault,
        { path: alias, confidence: "high", agent: "human:test", reason: "test" },
        PUBLIC_WRITER_PROMOTER,
      ),
      vaultSetTier(
        vault,
        { path: alias, tier: "source", agent: "human:test", reason: "test" },
        PUBLIC_WRITER_PROMOTER,
      ),
      vaultSupersede(
        vault,
        { old_path: alias, new_path: "public/successor.md", agent: "human:test" },
        PUBLIC_WRITER_PROMOTER,
      ),
      vaultUnsupersede(
        vault,
        { path: supersededAlias, agent: "human:test", reason: "test" },
        PUBLIC_WRITER_PROMOTER,
      ),
      vaultMerge(
        vault,
        {
          path_a: alias,
          path_b: "public/successor.md",
          target_path: "public/merged.md",
          body: "merged",
          agent: "human:test",
        },
        PUBLIC_WRITER_PROMOTER,
      ),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("access denied");
    }
    expect(readFileSync(join(vault, "restricted", "secret.md"), "utf-8")).toBe(secretContent);
    expect(readFileSync(join(vault, "restricted", "superseded.md"), "utf-8")).toBe(
      supersededContent,
    );
  });

  it("denies vault_promote on a direct path in a collection the role cannot write", async () => {
    const restrictedDraft =
      "---\ntitle: Restricted Draft\ndomain: accumulation\ncollection: restricted\nstatus: draft\nconfidence: medium\ncreated: 2026-01-01\nupdated: 2026-01-01\nupdated_by: human:admin\nprovenance: direct\nsources: []\nsuperseded_by: null\nttl_days: null\n---\n\nbody\n";
    writeFileSync(join(vault, "restricted", "draft.md"), restrictedDraft, "utf-8");

    const res = await vaultPromote(
      vault,
      { path: "restricted/draft.md", agent: "human:test" },
      PUBLIC_WRITER_PROMOTER,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("access denied");
    expect(readFileSync(join(vault, "restricted", "draft.md"), "utf-8")).toBe(restrictedDraft);
  });
});
