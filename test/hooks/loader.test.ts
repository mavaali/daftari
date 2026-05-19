import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHook, loadHooks } from "../../src/hooks/loader.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = join(projectRoot, "node_modules", ".bin", "tsx");
const probeScript = join(projectRoot, "test", "fixtures", "hook-loader-probe.mts");

// Drives the hook loader in a real Node process. Vitest's module runner caches
// dynamic import() by path and ignores the loader's `?t=<mtime>` cache-busting
// query, so the loader's hot-reload can only be observed outside vitest. The
// probe writes `v2Source` over the hook mid-run; see hook-loader-probe.mts.
function runProbe(
  vault: string,
  v2Source: string,
): { message1: string; message2: string; stableRef: boolean } {
  writeHookFile(
    vault,
    ".daftari/hooks/probe.mjs",
    "export default function probe() { return [{ field: 'v', message: 'first version' }]; }\n",
  );
  const out = execFileSync(tsxBin, [probeScript, vault, ".daftari/hooks/probe.mjs", v2Source], {
    encoding: "utf8",
  });
  return JSON.parse(out);
}

const V2_SOURCE =
  "export default function probe() { return [{ field: 'v', message: 'second version' }]; }\n";

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

  it("picks up edits to a hook file without a server restart", () => {
    const result = runProbe(vault, V2_SOURCE);
    expect(result.message1).toBe("first version");
    expect(result.message2).toBe("second version");
  });

  it("returns the same hook module when the file is unchanged", () => {
    const result = runProbe(vault, V2_SOURCE);
    expect(result.stableRef).toBe(true);
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
