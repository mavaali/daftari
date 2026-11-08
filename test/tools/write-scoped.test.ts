// Scoped addressing on the write path (2026-11-08 spec): vault_write takes
// scope + key as an alternative to path, derives the path itself, and makes
// a second write update the same note — with base_version required once the
// note exists, so concurrent writers cannot silently clobber each other.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultWrite, writeTools } from "../../src/tools/write.js";
import { log } from "../../src/utils/git.js";
import { withInjectedRace } from "../helpers/inject-race.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:ci";
const SCOPE = "repo::github.com/acme/checkout";
const KEY = "tests-need-local-postgres";
const PATH = "scopes/repo/github.com/acme/checkout/tests-need-local-postgres.md";

function fm(overrides: Record<string, unknown> = {}) {
  return {
    title: "Tests need a local Postgres",
    domain: "accumulation",
    status: "draft",
    confidence: "medium",
    created: "2026-11-08",
    provenance: "direct",
    tags: [],
    ...overrides,
  };
}

function scoped(extra: Record<string, unknown> = {}) {
  return {
    scope: SCOPE,
    key: KEY,
    body: "Run `docker compose up db` before `npm test`.\n",
    frontmatter: fm(),
    agent: AGENT,
    ...extra,
  };
}

function role(read: string[], write: string[]): AccessContext {
  return { user: "u", roleName: "bot", role: { read, write, promote: false, ratify: false } };
}

describe("vault_write scoped addressing", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("creates the note at the derived path with scope/key/collection in frontmatter", async () => {
    const r = await vaultWrite(vault, scoped());
    expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toBe(PATH);
    expect(r.value.action).toBe("create");

    const read = await vaultRead(vault, PATH);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.frontmatter.scope).toBe(SCOPE);
    expect(read.value.frontmatter.key).toBe(KEY);
    expect(read.value.frontmatter.collection).toBe("scopes");
  });

  it("create-then-update via scope+key touches one file with two commits", async () => {
    const created = await vaultWrite(vault, scoped());
    expect(created.ok).toBe(true);
    const read = await vaultRead(vault, PATH);
    if (!read.ok) throw read.error;

    const updated = await vaultWrite(
      vault,
      scoped({
        body: "Use the testcontainers fixture instead.\n",
        base_version: read.value.version,
      }),
    );
    expect(updated.ok, updated.ok ? "" : updated.error.message).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.path).toBe(PATH);
    expect(updated.value.action).toBe("update");

    const dir = join(vault, "scopes/repo/github.com/acme/checkout");
    expect(readdirSync(dir)).toEqual([`${KEY}.md`]);
    const history = await log(vault, { path: PATH });
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.value).toHaveLength(2);

    const after = await vaultRead(vault, PATH);
    if (!after.ok) throw after.error;
    expect(after.value.content).toContain("testcontainers");
  });

  it("rejects an update of an existing scoped note without base_version", async () => {
    expect((await vaultWrite(vault, scoped())).ok).toBe(true);
    const r = await vaultWrite(vault, scoped({ body: "clobber\n" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/base_version/);
    expect(r.error.message).toMatch(/vault_read/);
    expect(r.error.message).toMatch(/'version'/);
    const read = await vaultRead(vault, PATH);
    if (read.ok) expect(read.value.content).not.toContain("clobber");
  });

  it("rejects an update with a stale base_version", async () => {
    expect((await vaultWrite(vault, scoped())).ok).toBe(true);
    const first = await vaultRead(vault, PATH);
    if (!first.ok) throw first.error;
    const writerA = await vaultWrite(
      vault,
      scoped({ body: "writer A\n", base_version: first.value.version }),
    );
    expect(writerA.ok).toBe(true);
    const writerB = await vaultWrite(
      vault,
      scoped({ body: "writer B\n", base_version: first.value.version }),
    );
    expect(writerB.ok).toBe(false);
    if (!writerB.ok) expect(writerB.error.message).toMatch(/^stale write:/);
  });

  it("refuses path together with scope/key", async () => {
    const r = await vaultWrite(vault, scoped({ path: PATH }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/exactly one of 'path' or 'scope' \+ 'key'/);
  });

  it("refuses scope without key (and key without scope) as arguments", async () => {
    const a = await vaultWrite(vault, scoped({ key: undefined }));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.message).toMatch(/'key'/);
    const b = await vaultWrite(vault, scoped({ scope: undefined }));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.message).toMatch(/'scope'/);
  });

  it("refuses scope without key in frontmatter on an explicit-path write", async () => {
    const r = await vaultWrite(vault, {
      path: "pricing/half.md",
      body: "x\n",
      frontmatter: fm({ collection: "pricing", scope: SCOPE }),
      agent: AGENT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/key/);
  });

  it("refuses traversal-shaped scopes before touching disk", async () => {
    for (const scope of ["repo::../../etc", "repo::/abs", "repo::a//b", "repo::./a", "repo::a b"]) {
      const r = await vaultWrite(vault, scoped({ scope }));
      expect(r.ok, scope).toBe(false);
    }
    expect(existsSync(join(vault, "scopes"))).toBe(false);
  });

  it("refuses an explicit-path write whose scope/key derive elsewhere", async () => {
    const r = await vaultWrite(vault, {
      path: "pricing/elsewhere.md",
      body: "x\n",
      frontmatter: fm({ collection: "scopes", scope: SCOPE, key: KEY }),
      agent: AGENT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain(PATH);
    expect(existsSync(join(vault, "pricing/elsewhere.md"))).toBe(false);
  });

  it("refuses an unscoped explicit-path write into scopes/", async () => {
    const r = await vaultWrite(vault, {
      path: "scopes/repo/squat/k.md",
      body: "x\n",
      frontmatter: fm({ collection: "scopes" }),
      agent: AGENT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/reserved/);
  });

  it("accepts an explicit-path write whose scope/key derive to that path", async () => {
    const r = await vaultWrite(vault, {
      path: PATH,
      body: "x\n",
      frontmatter: fm({ collection: "scopes", scope: SCOPE, key: KEY }),
      agent: AGENT,
    });
    expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
  });

  it("rejects a path-addressed update of an existing scoped note without base_version", async () => {
    const c = await vaultWrite(vault, scoped());
    expect(c.ok, c.ok ? "" : c.error.message).toBe(true);
    const r = await vaultWrite(vault, {
      path: PATH,
      body: "overwrite\n",
      frontmatter: fm({ collection: "scopes", scope: SCOPE, key: KEY }),
      agent: AGENT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/base_version/);
  });

  it("refuses a scoped write whose frontmatter names a different collection", async () => {
    const r = await vaultWrite(vault, scoped({ frontmatter: fm({ collection: "pricing" }) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/collection/);
  });

  it("refuses a scoped write that would land on a note holding a different address", async () => {
    // Sanitization is many-to-one: '@' and '-' both land on '-'. The second
    // address must not silently take over the first one's file.
    const first = await vaultWrite(vault, scoped({ scope: "user::a-b.com" }));
    expect(first.ok).toBe(true);
    const second = await vaultWrite(vault, scoped({ scope: "user::a@b.com" }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toMatch(/already holds/);
  });

  it("denies a role without write on the 'scopes' collection", async () => {
    const r = await vaultWrite(vault, scoped(), role(["*"], ["pricing"]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe("access denied: role 'bot' cannot write to collection 'scopes'");
    }
    expect(existsSync(join(vault, "scopes"))).toBe(false);
  });

  it("allows a role with write on 'scopes'", async () => {
    const r = await vaultWrite(vault, scoped(), role(["scopes"], ["scopes"]));
    expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
  });

  it("stages a propose-only role's scoped write at the derived path with scope/key in the payload", async () => {
    const proposer: AccessContext = {
      user: "u",
      roleName: "proposer",
      role: { read: ["*"], write: ["scopes"], promote: false, ratify: false, proposeOnly: true },
    };
    const r = await vaultWrite(vault, scoped(), proposer);
    expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
    if (!r.ok) return;
    expect(r.value.action).toBe("staged");
    expect(r.value.path).toBe(PATH);
    expect(r.value.validation.valid).toBe(true);
    expect(existsSync(join(vault, PATH))).toBe(false);
  });

  it("keeps non-scoped writes last-write-wins without base_version", async () => {
    const args = {
      path: "pricing/plain.md",
      body: "one\n",
      frontmatter: fm({ collection: "pricing" }),
      agent: AGENT,
    };
    expect((await vaultWrite(vault, args)).ok).toBe(true);
    expect((await vaultWrite(vault, { ...args, body: "two\n" })).ok).toBe(true);
  });

  it("refuses a scoped create racing a concurrent create (checked inside the lock)", async () => {
    // Writer B creates the note between writer A's existence pre-check and A's
    // lock. A started as a create (no base_version needed), so only the
    // in-lock re-check stands between A and a silent overwrite of B.
    const r = await withInjectedRace(
      join(vault, PATH),
      async () => {
        const b = await vaultWrite(vault, scoped({ body: "writer B\n" }));
        if (!b.ok) throw b.error;
      },
      () => vaultWrite(vault, scoped({ body: "writer A\n" })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/base_version/);
    const read = await vaultRead(vault, PATH);
    if (!read.ok) throw read.error;
    expect(read.value.content).toContain("writer B");
  });

  it("advertises scope and key in the vault_write input schema; path is no longer required", () => {
    const tool = writeTools.find((t) => t.name === "vault_write");
    const schema = tool?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties.scope).toBeDefined();
    expect(schema.properties.key).toBeDefined();
    expect(schema.required).not.toContain("path");
  });
});
