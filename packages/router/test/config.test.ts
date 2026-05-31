import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const SAMPLE = `
router:
  transport: stdio
vaults:
  a:
    path: /tmp/a
    user: agent
    role: admin
    description: "vault a"
  b:
    path: /tmp/b
    user: agent
    role: reader
    description: "vault b"
defaults:
  search_limit: 5
`;

describe("parseConfig", () => {
  it("parses transport, vaults, defaults", () => {
    const cfg = parseConfig(SAMPLE);
    expect(cfg.transport).toBe("stdio");
    expect(cfg.vaults.length).toBe(2);
    expect(cfg.vaults[0]).toMatchObject({
      name: "a",
      path: "/tmp/a",
      user: "agent",
      role: "admin",
      description: "vault a",
    });
    expect(cfg.defaults.searchLimit).toBe(5);
  });

  it("expands ~ to HOME in vault paths", () => {
    const cfg = parseConfig(`
router: { transport: stdio }
vaults:
  a: { path: ~/vaults/x, user: u, role: admin, description: d }
`);
    expect(cfg.vaults[0].path.startsWith("~")).toBe(false);
  });

  it("rejects vault names containing ':'", () => {
    expect(() =>
      parseConfig(`
router: { transport: stdio }
vaults:
  "a:b": { path: /tmp/x, user: u, role: admin, description: d }
`),
    ).toThrow(/colon/);
  });

  it("rejects empty vaults map", () => {
    expect(() => parseConfig(`router: { transport: stdio }\nvaults: {}\n`)).toThrow(
      /at least one vault/,
    );
  });
});
