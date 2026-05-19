import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultAppend, vaultWrite } from "../../src/tools/write.js";
import { configPath } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";

function newFrontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Hook Test Doc",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    updated: "2026-05-01",
    updated_by: "agent:seed",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["pricing"],
    ...overrides,
  };
}

function writeHookConfig(vault: string, hookPaths: string[]): void {
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  const yaml = ["hooks:", "  pre_write:", ...hookPaths.map((p) => `    - path: ${p}`), ""].join(
    "\n",
  );
  writeFileSync(configPath(vault), yaml);
}

function writeHookFile(vault: string, relPath: string, source: string): void {
  const abs = join(vault, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, source);
}

describe("vault_write — pre-write hooks", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("passes when the hook returns no issues", async () => {
    writeHookConfig(vault, [".daftari/hooks/clean.mjs"]);
    writeHookFile(
      vault,
      ".daftari/hooks/clean.mjs",
      "export default function clean() { return []; }\n",
    );

    const result = await vaultWrite(vault, {
      path: "pricing/clean.md",
      body: "# clean\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
  });

  it("blocks the write when a hook reports an issue", async () => {
    writeHookConfig(vault, [".daftari/hooks/block.mjs"]);
    writeHookFile(
      vault,
      ".daftari/hooks/block.mjs",
      "export default function block() {\n" +
        "  return [{ field: 'title', message: 'banned word' }];\n" +
        "}\n",
    );

    const result = await vaultWrite(vault, {
      path: "pricing/blocked.md",
      body: "# blocked\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("invalid frontmatter");
    expect(result.error.message).toContain("banned word");
  });

  it("treats a hook throw as a blocking issue tagged with the hook path", async () => {
    writeHookConfig(vault, [".daftari/hooks/throws.mjs"]);
    writeHookFile(
      vault,
      ".daftari/hooks/throws.mjs",
      "export default function bad() { throw new Error('boom'); }\n",
    );

    const result = await vaultWrite(vault, {
      path: "pricing/thrower.md",
      body: "# t\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(".daftari/hooks/throws.mjs");
    expect(result.error.message).toContain("hook threw: boom");
  });

  it("aggregates issues from multiple hooks (no fail-fast)", async () => {
    writeHookConfig(vault, [".daftari/hooks/a.mjs", ".daftari/hooks/b.mjs"]);
    writeHookFile(
      vault,
      ".daftari/hooks/a.mjs",
      "export default () => [{ field: 'x', message: 'from-a' }];\n",
    );
    writeHookFile(
      vault,
      ".daftari/hooks/b.mjs",
      "export default () => [{ field: 'y', message: 'from-b' }];\n",
    );

    const result = await vaultWrite(vault, {
      path: "pricing/double.md",
      body: "# d\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("from-a");
    expect(result.error.message).toContain("from-b");
  });

  it("fires hooks with the right operation context", async () => {
    writeHookConfig(vault, [".daftari/hooks/op.mjs"]);
    writeHookFile(
      vault,
      ".daftari/hooks/op.mjs",
      [
        "export default function op(_fm, ctx) {",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: hook source body
        "  return [{ field: 'op', message: `saw:${ctx.operation}:${ctx.path}` }];",
        "}",
        "",
      ].join("\n"),
    );

    const create = await vaultWrite(vault, {
      path: "pricing/ctx.md",
      body: "# c\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(create.ok).toBe(false);
    if (create.ok) return;
    expect(create.error.message).toContain("saw:create:pricing/ctx.md");
  });

  it("surfaces a hook load failure (missing file) as an error", async () => {
    writeHookConfig(vault, [".daftari/hooks/does-not-exist.mjs"]);

    const result = await vaultWrite(vault, {
      path: "pricing/x.md",
      body: "# x\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message.toLowerCase()).toContain("not found");
  });
});

describe("vault_append — pre-write hooks", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  async function seedDoc(): Promise<void> {
    const seed = await vaultWrite(vault, {
      path: "pricing/appendable.md",
      body: "# a\n\nseeded.\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    if (!seed.ok) throw seed.error;
  }

  it("fires hooks on append with operation='append'", async () => {
    await seedDoc();
    writeHookConfig(vault, [".daftari/hooks/op.mjs"]);
    writeHookFile(
      vault,
      ".daftari/hooks/op.mjs",
      [
        "export default function op(_fm, ctx) {",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: hook source body
        "  return [{ field: 'op', message: `saw:${ctx.operation}` }];",
        "}",
        "",
      ].join("\n"),
    );

    const result = await vaultAppend(vault, {
      path: "pricing/appendable.md",
      section: "## extra\n\nmore.",
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("saw:append");
  });

  it("appends when hooks pass", async () => {
    await seedDoc();
    writeHookConfig(vault, [".daftari/hooks/clean.mjs"]);
    writeHookFile(vault, ".daftari/hooks/clean.mjs", "export default () => [];\n");

    const result = await vaultAppend(vault, {
      path: "pricing/appendable.md",
      section: "## extra\n\nmore.",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
  });
});
