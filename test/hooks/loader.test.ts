import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHook, loadHooks } from "../../src/hooks/loader.js";

// Writes a hook module file inside a temp vault and returns the absolute
// path. Hooks are real .mjs files loaded via dynamic import.
function writeHookFile(vault: string, relPath: string, source: string): void {
  const abs = join(vault, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, source);
}

describe("hooks loader", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-hook-loader-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("loads a hook whose default export is a function", async () => {
    writeHookFile(
      vault,
      ".daftari/hooks/passthrough.mjs",
      "export default function passthrough() { return []; }\n",
    );
    const result = await loadHook(vault, { path: ".daftari/hooks/passthrough.mjs" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value.hook).toBe("function");
    expect(result.value.declaration.path).toBe(".daftari/hooks/passthrough.mjs");
  });

  it("rejects a hook file that does not exist", async () => {
    const result = await loadHook(vault, { path: ".daftari/hooks/missing.mjs" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("not found");
  });

  it("rejects a hook whose default export is not a function", async () => {
    writeHookFile(vault, ".daftari/hooks/not-a-fn.mjs", "export default { not: 'a function' };\n");
    const result = await loadHook(vault, { path: ".daftari/hooks/not-a-fn.mjs" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must export a default function");
  });

  it("rejects a hook path that escapes the vault root", async () => {
    const result = await loadHook(vault, { path: "../escape.mjs" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("escapes vault root");
  });

  it("rejects an absolute hook path", async () => {
    const result = await loadHook(vault, { path: "/etc/passwd" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("vault-root-relative");
  });

  it("surfaces a syntax error in a hook module as a load failure", async () => {
    writeHookFile(vault, ".daftari/hooks/broken.mjs", "export default function( {\n");
    const result = await loadHook(vault, { path: ".daftari/hooks/broken.mjs" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("failed to load hook");
  });

  it("loads multiple hooks in declared order", async () => {
    writeHookFile(vault, ".daftari/hooks/a.mjs", "export default function a() { return []; }\n");
    writeHookFile(vault, ".daftari/hooks/b.mjs", "export default function b() { return []; }\n");
    const result = await loadHooks(vault, [
      { path: ".daftari/hooks/b.mjs" },
      { path: ".daftari/hooks/a.mjs" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((h) => h.declaration.path)).toEqual([
      ".daftari/hooks/b.mjs",
      ".daftari/hooks/a.mjs",
    ]);
  });

  it("loadHooks fails fast on the first broken declaration", async () => {
    writeHookFile(vault, ".daftari/hooks/ok.mjs", "export default function ok() { return []; }\n");
    const result = await loadHooks(vault, [
      { path: ".daftari/hooks/ok.mjs" },
      { path: ".daftari/hooks/missing.mjs" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("missing.mjs");
  });
});
