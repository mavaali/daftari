// release-metadata.test.ts — slrf: server.json (MCP registry) and
// manifest.json (MCPB) must carry package.json's version and the registered
// tool list. They drifted to 1.32.0 / 3.13.1 while npm shipped 3.16.0 — the
// registry then rejects or mislabels the publish. Fix drift with
// `npm run sync:release` (after `npm run build`).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { registeredToolNames } from "../src/server.js";

const read = (f: string) => JSON.parse(readFileSync(resolve(f), "utf-8"));
const pkg = read("package.json");
const serverJson = read("server.json");
const manifest = read("manifest.json");

describe("release metadata stays in sync with package.json", () => {
  it("server.json version and npm package version match", () => {
    expect(serverJson.version).toBe(pkg.version);
    for (const p of serverJson.packages) {
      expect(p.identifier).toBe(pkg.name);
      expect(p.version).toBe(pkg.version);
    }
  });

  it("server.json name matches package.json mcpName (registry ownership check)", () => {
    expect(serverJson.name).toBe(pkg.mcpName);
  });

  it("manifest.json version matches", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("manifest.json lists every registered tool", () => {
    expect((manifest.tools ?? []).map((t: { name: string }) => t.name).sort()).toEqual(
      registeredToolNames().sort(),
    );
  });
});
