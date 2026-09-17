// U1 — household vault topology fixture. Proves that three sovereign daftari
// vaults (alice-private, bob-private, shared), each with a real
// .daftari/config.yaml, load cleanly via daftari's own config loader and
// encode the 1Password private+shared model: each private vault's
// `federation.principals` grants read to its owner only (deny-all-guest for
// everyone else, including the other spouse and any "*" wildcard); the
// shared vault grants read to both.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/utils/config.js";

const VAULTS_ROOT = join(__dirname, "vaults");
const alicePrivate = join(VAULTS_ROOT, "alice-private");
const bobPrivate = join(VAULTS_ROOT, "bob-private");
const shared = join(VAULTS_ROOT, "shared");

describe("gharonda household vault topology (U1)", () => {
  it("loads alice-private's config with no validation error", () => {
    const config = loadConfig(alicePrivate);
    expect(config.ok).toBe(true);
  });

  it("loads bob-private's config with no validation error", () => {
    const config = loadConfig(bobPrivate);
    expect(config.ok).toBe(true);
  });

  it("loads shared's config with no validation error", () => {
    const config = loadConfig(shared);
    expect(config.ok).toBe(true);
  });

  it("alice-private grants read only to human:alice — not bob, not guest/*", () => {
    const config = loadConfig(alicePrivate);
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    const principals = config.value.federation?.principals;
    expect(principals).toBeDefined();
    expect(principals?.["human:alice"]).toBeDefined();
    expect(principals?.["human:bob"]).toBeUndefined();
    expect(principals?.["*"]).toBeUndefined();
  });

  it("bob-private grants read only to human:bob — not alice, not guest/*", () => {
    const config = loadConfig(bobPrivate);
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    const principals = config.value.federation?.principals;
    expect(principals).toBeDefined();
    expect(principals?.["human:bob"]).toBeDefined();
    expect(principals?.["human:alice"]).toBeUndefined();
    expect(principals?.["*"]).toBeUndefined();
  });

  it("shared grants read to both human:alice and human:bob", () => {
    const config = loadConfig(shared);
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    const principals = config.value.federation?.principals;
    expect(principals).toBeDefined();
    expect(principals?.["human:alice"]).toBeDefined();
    expect(principals?.["human:bob"]).toBeDefined();
  });
});
