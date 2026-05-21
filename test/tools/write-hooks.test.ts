import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";
import { vaultAppend, vaultWrite } from "../../src/tools/write.js";
import { configPath } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// Each test in this file goes through the full write path — dynamic hook
// ESM import, frontmatter validation, indexDocument (which now hits the
// pluggable embedding provider's lookup + lazy model warm). Under heavy
// parallel test load on CI the default 5s timeout is occasionally too
// tight on the slowest runners. 30s is well below the reindex/embedding
// tests' 60s ceiling and gives consistent headroom.
vi.setConfig({ testTimeout: 30_000 });

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

// Writes a verbatim .daftari/config.yaml — the transform tests exercise the
// `pre_write_transform` block and schema extensions, neither of which the
// pre_write-only writeHookConfig helper above can express.
function writeRawConfig(vault: string, yaml: string): void {
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(configPath(vault), yaml);
}

// Parses a freshly written document straight off disk so a test can assert on
// what was actually serialized, not on the WriteResult's view of it.
function readDoc(vault: string, relPath: string): ReturnType<typeof parseDocument> {
  return parseDocument(readFileSync(join(vault, relPath), "utf-8"));
}

describe("vault_write — pre-write transform hooks", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("derives a built-in field from an extension field (issue #32 kill condition)", async () => {
    writeRawConfig(
      vault,
      [
        "schema_extensions:",
        "  decision_status:",
        "    type: string",
        "hooks:",
        "  pre_write_transform:",
        "    - path: .daftari/hooks/derive-status.mjs",
        "",
      ].join("\n"),
    );
    writeHookFile(
      vault,
      ".daftari/hooks/derive-status.mjs",
      "export default function deriveStatus(fm) {\n" +
        "  if (fm.decision_status === 'ACTIVE') return { status: 'canonical' };\n" +
        "  return {};\n" +
        "}\n",
    );

    const fm: Record<string, unknown> = newFrontmatter({ decision_status: "ACTIVE" });
    delete fm.status;

    const result = await vaultWrite(vault, {
      path: "pricing/decision.md",
      body: "# decision\n",
      frontmatter: fm,
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const onDisk = readDoc(vault, "pricing/decision.md");
    expect(onDisk.ok).toBe(true);
    if (!onDisk.ok) return;
    expect(onDisk.value.frontmatter.status).toBe("canonical");
    expect(onDisk.value.raw.decision_status).toBe("ACTIVE");
  });

  it("a transform overrides a user-supplied value", async () => {
    writeRawConfig(
      vault,
      ["hooks:", "  pre_write_transform:", "    - path: .daftari/hooks/force.mjs", ""].join("\n"),
    );
    writeHookFile(
      vault,
      ".daftari/hooks/force.mjs",
      "export default function force() { return { status: 'canonical' }; }\n",
    );

    const result = await vaultWrite(vault, {
      path: "pricing/forced.md",
      body: "# f\n",
      frontmatter: newFrontmatter({ status: "draft" }),
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const onDisk = readDoc(vault, "pricing/forced.md");
    if (!onDisk.ok) return;
    expect(onDisk.value.frontmatter.status).toBe("canonical");
  });

  it("two transforms on the same field — last declared wins", async () => {
    writeRawConfig(
      vault,
      [
        "hooks:",
        "  pre_write_transform:",
        "    - path: .daftari/hooks/set-canonical.mjs",
        "    - path: .daftari/hooks/set-draft.mjs",
        "",
      ].join("\n"),
    );
    writeHookFile(
      vault,
      ".daftari/hooks/set-canonical.mjs",
      "export default () => ({ status: 'canonical' });\n",
    );
    writeHookFile(
      vault,
      ".daftari/hooks/set-draft.mjs",
      "export default () => ({ status: 'draft' });\n",
    );

    const result = await vaultWrite(vault, {
      path: "pricing/lastwins.md",
      body: "# l\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const onDisk = readDoc(vault, "pricing/lastwins.md");
    if (!onDisk.ok) return;
    expect(onDisk.value.frontmatter.status).toBe("draft");
  });

  it("a transform that sets an invalid enum value is caught by validation", async () => {
    writeRawConfig(
      vault,
      ["hooks:", "  pre_write_transform:", "    - path: .daftari/hooks/bad-status.mjs", ""].join(
        "\n",
      ),
    );
    writeHookFile(
      vault,
      ".daftari/hooks/bad-status.mjs",
      "export default () => ({ status: 'not_a_valid_value' });\n",
    );

    const result = await vaultWrite(vault, {
      path: "pricing/badenum.md",
      body: "# b\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("invalid frontmatter");
    expect(result.error.message).toContain("status");
    expect(result.error.message).toContain("not_a_valid_value");
  });

  it("a transform throw blocks the write; later transforms still run", async () => {
    writeRawConfig(
      vault,
      [
        "hooks:",
        "  pre_write_transform:",
        "    - path: .daftari/hooks/throw-one.mjs",
        "    - path: .daftari/hooks/throw-two.mjs",
        "",
      ].join("\n"),
    );
    writeHookFile(
      vault,
      ".daftari/hooks/throw-one.mjs",
      "export default function one() { throw new Error('boom-one'); }\n",
    );
    writeHookFile(
      vault,
      ".daftari/hooks/throw-two.mjs",
      "export default function two() { throw new Error('boom-two'); }\n",
    );

    const result = await vaultWrite(vault, {
      path: "pricing/throwers.md",
      body: "# t\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(".daftari/hooks/throw-one.mjs");
    expect(result.error.message).toContain("transform hook threw: boom-one");
    expect(result.error.message).toContain(".daftari/hooks/throw-two.mjs");
    expect(result.error.message).toContain("transform hook threw: boom-two");
  });

  it("blocks the write when a transform returns null", async () => {
    writeRawConfig(
      vault,
      ["hooks:", "  pre_write_transform:", "    - path: .daftari/hooks/null.mjs", ""].join("\n"),
    );
    writeHookFile(vault, ".daftari/hooks/null.mjs", "export default () => null;\n");

    const result = await vaultWrite(vault, {
      path: "pricing/nullret.md",
      body: "# n\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(".daftari/hooks/null.mjs");
    expect(result.error.message).toContain("non-object (got null)");
  });

  it("blocks the write when a transform returns an array", async () => {
    writeRawConfig(
      vault,
      ["hooks:", "  pre_write_transform:", "    - path: .daftari/hooks/array.mjs", ""].join("\n"),
    );
    writeHookFile(vault, ".daftari/hooks/array.mjs", "export default () => ['nope'];\n");

    const result = await vaultWrite(vault, {
      path: "pricing/arrayret.md",
      body: "# a\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("non-object (got array)");
  });

  it("blocks the write when a transform returns a string", async () => {
    writeRawConfig(
      vault,
      ["hooks:", "  pre_write_transform:", "    - path: .daftari/hooks/string.mjs", ""].join("\n"),
    );
    writeHookFile(vault, ".daftari/hooks/string.mjs", "export default () => 'nope';\n");

    const result = await vaultWrite(vault, {
      path: "pricing/stringret.md",
      body: "# s\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("non-object (got string)");
  });

  it("backward compat — a pre_write validator still blocks the write", async () => {
    writeRawConfig(
      vault,
      ["hooks:", "  pre_write:", "    - path: .daftari/hooks/validator.mjs", ""].join("\n"),
    );
    writeHookFile(
      vault,
      ".daftari/hooks/validator.mjs",
      "export default () => [{ field: 'title', message: 'still-blocks' }];\n",
    );

    const result = await vaultWrite(vault, {
      path: "pricing/compat.md",
      body: "# c\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("still-blocks");
  });

  it("transforms run before pre_write validators see the frontmatter", async () => {
    writeRawConfig(
      vault,
      [
        "hooks:",
        "  pre_write_transform:",
        "    - path: .daftari/hooks/make-canonical.mjs",
        "  pre_write:",
        "    - path: .daftari/hooks/require-canonical.mjs",
        "",
      ].join("\n"),
    );
    writeHookFile(
      vault,
      ".daftari/hooks/make-canonical.mjs",
      "export default () => ({ status: 'canonical' });\n",
    );
    writeHookFile(
      vault,
      ".daftari/hooks/require-canonical.mjs",
      "export default function req(fm) {\n" +
        "  if (fm.status !== 'canonical') return [{ field: 'status', message: 'must be canonical' }];\n" +
        "  return [];\n" +
        "}\n",
    );

    const result = await vaultWrite(vault, {
      path: "pricing/phase.md",
      body: "# p\n",
      frontmatter: newFrontmatter({ status: "draft" }),
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const onDisk = readDoc(vault, "pricing/phase.md");
    if (!onDisk.ok) return;
    expect(onDisk.value.frontmatter.status).toBe("canonical");
  });

  it("a transform sees a prior transform's output", async () => {
    writeRawConfig(
      vault,
      [
        "hooks:",
        "  pre_write_transform:",
        "    - path: .daftari/hooks/first.mjs",
        "    - path: .daftari/hooks/second.mjs",
        "",
      ].join("\n"),
    );
    writeHookFile(
      vault,
      ".daftari/hooks/first.mjs",
      "export default () => ({ status: 'draft' });\n",
    );
    writeHookFile(
      vault,
      ".daftari/hooks/second.mjs",
      "export default function second(fm) {\n" +
        "  return fm.status === 'draft' ? { status: 'canonical' } : {};\n" +
        "}\n",
    );

    const fm: Record<string, unknown> = newFrontmatter();
    delete fm.status;

    const result = await vaultWrite(vault, {
      path: "pricing/chain.md",
      body: "# ch\n",
      frontmatter: fm,
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const onDisk = readDoc(vault, "pricing/chain.md");
    if (!onDisk.ok) return;
    expect(onDisk.value.frontmatter.status).toBe("canonical");
  });

  it("surfaces a transform hook load failure (missing file) as an error", async () => {
    writeRawConfig(
      vault,
      [
        "hooks:",
        "  pre_write_transform:",
        "    - path: .daftari/hooks/missing-transform.mjs",
        "",
      ].join("\n"),
    );

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

describe("vault_append — pre-write transform hooks", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("applies a transform on append", async () => {
    const seed = await vaultWrite(vault, {
      path: "pricing/appendt.md",
      body: "# a\n\nseed.\n",
      frontmatter: newFrontmatter({ status: "draft" }),
      agent: AGENT,
    });
    expect(seed.ok).toBe(true);

    writeRawConfig(
      vault,
      [
        "hooks:",
        "  pre_write_transform:",
        "    - path: .daftari/hooks/append-canonical.mjs",
        "",
      ].join("\n"),
    );
    writeHookFile(
      vault,
      ".daftari/hooks/append-canonical.mjs",
      "export default () => ({ status: 'canonical' });\n",
    );

    const result = await vaultAppend(vault, {
      path: "pricing/appendt.md",
      section: "## more\n\ntext.",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const onDisk = readDoc(vault, "pricing/appendt.md");
    if (!onDisk.ok) return;
    expect(onDisk.value.frontmatter.status).toBe("canonical");
  });
});
