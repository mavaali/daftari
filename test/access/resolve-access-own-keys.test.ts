// resolve-access-own-keys.test.ts — a role name that is only an inherited
// Object key (`--role constructor`, `default_role: toString`) must resolve to
// the deny-all guest, not to Object.prototype members that crash permits().
import { describe, expect, it } from "vitest";
import { resolveAccess } from "../../src/access/rbac.js";
import type { DaftariConfig } from "../../src/utils/config.js";

const config = { roles: { admin: { read: ["*"], write: ["*"] } } } as unknown as DaftariConfig;

describe("resolveAccess — own keys only", () => {
  it("resolves a declared role", () => {
    expect(resolveAccess(config, "me", "admin").role).not.toBeNull();
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "treats inherited key %s as an unknown role (deny-all)",
    (name) => {
      expect(resolveAccess(config, "me", name).role).toBeNull();
    },
  );
});
