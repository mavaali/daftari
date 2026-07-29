// newFence's collision handling, actually exercised.
//
// The test in index.test.ts that claimed to "force the collision path" by
// passing a byte-enumeration string did no such thing: `everyByte.repeat(4)` is
// 2048 characters containing 512 distinct 16-character substrings, against
// 16^16 ~ 1.8e19 possible nonces. A random nonce lands inside it with
// probability ~2.8e-17, so the retry loop and the widening loop never ran and
// the test passed on the first draw every time. Review caught it.
//
// A 64-bit nonce cannot be made to collide by choosing content — that is the
// entire security property. So the only honest way to reach these branches is
// to control the draw, which is what this file does. It lives apart from
// index.test.ts because it mocks node:crypto module-wide.

import { randomBytes as realRandomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Draws are served from this queue; anything left unqueued falls through to the
// real generator so an over-drawing implementation fails loudly rather than
// silently reusing the last value.
let queue: Buffer[] = [];
const sizes: number[] = [];

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: (n: number) => {
      sizes.push(n);
      const next = queue.shift();
      return next ?? actual.randomBytes(n);
    },
  };
});

const { newFence } = await import("../../src/fence/index.js");

const hex = (h: string) => Buffer.from(h, "hex");

beforeEach(() => {
  queue = [];
  sizes.length = 0;
});

describe("newFence collision handling", () => {
  it("redraws when the first nonce appears in the content", () => {
    const colliding = "aaaaaaaaaaaaaaaa"; // 16 hex chars = 8 bytes
    const clean = "bbbbbbbbbbbbbbbb";
    queue = [hex(colliding), hex(clean)];

    const fence = newFence(`body mentioning ${colliding} somewhere`);

    expect(fence.nonce).toBe(clean);
    expect(sizes).toEqual([8, 8]); // one redraw, still at the base width
  });

  it("keeps the nonce out of the content even after several collisions", () => {
    const c = ["aaaaaaaaaaaaaaaa", "cccccccccccccccc", "dddddddddddddddd"];
    const clean = "eeeeeeeeeeeeeeee";
    queue = [...c.map(hex), hex(clean)];

    const fence = newFence(c.join(" ... "));

    expect(fence.nonce).toBe(clean);
    expect(c.join(" ... ").includes(fence.nonce)).toBe(false);
  });

  it("widens the nonce when the retry budget is exhausted", () => {
    // Every 8-byte draw collides. After NONCE_RETRIES redraws the loop must
    // stop redrawing at the same width and double it instead — otherwise a
    // pathological `avoid` would spin forever or mint a colliding nonce.
    const eightByte = "abababababababab";
    const wide = "0123456789abcdef0123456789abcdef"; // 16 bytes
    queue = [...Array.from({ length: 5 }, () => hex(eightByte)), hex(wide)];

    const fence = newFence(eightByte);

    expect(fence.nonce).toBe(wide);
    expect(fence.nonce).toHaveLength(32);
    // 1 initial + 4 retries at 8 bytes, then one draw at the doubled width.
    expect(sizes).toEqual([8, 8, 8, 8, 8, 16]);
  });

  it("carries the widened nonce into both markers", () => {
    const eightByte = "abababababababab";
    const wide = "0123456789abcdef0123456789abcdef";
    queue = [...Array.from({ length: 5 }, () => hex(eightByte)), hex(wide)];

    const fence = newFence(eightByte);

    expect(fence.open("source-tier")).toContain(wide);
    expect(fence.close("source-tier")).toContain(wide);
  });

  it("does not redraw when the first nonce is already clean", () => {
    queue = [hex("0f0f0f0f0f0f0f0f")];
    const fence = newFence("content with no nonce in it");
    expect(fence.nonce).toBe("0f0f0f0f0f0f0f0f");
    expect(sizes).toEqual([8]);
  });

  it("uses the real generator by default", () => {
    // Guards the mock itself: if the fallthrough broke, every unqueued test
    // above would silently share one nonce.
    expect(newFence().nonce).not.toBe(newFence().nonce);
    expect(realRandomBytes(8).toString("hex")).toHaveLength(16);
  });
});
