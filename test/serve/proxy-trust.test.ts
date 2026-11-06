// F4: X-Forwarded-For is only trustworthy from a KNOWN proxy. The old boolean
// trust_proxy honored the header from any peer and took its leftmost (most
// spoofable) hop, so a direct attacker could forge their apparent source —
// evading their own rate/penalty key or framing a victim IP into lockout. The
// replacement takes a set of trusted-proxy CIDRs: the header is honored only
// when the immediate socket peer is inside one, and the real client is the
// first hop from the RIGHT that is not itself a trusted proxy (proxies append
// the peer they saw, so left-side entries are client-controlled).

import { describe, expect, it } from "vitest";
import { ipInAnyCidr, parseCidr, resolvePublicRemote } from "../../src/serve/proxy-trust.js";
import { requireDefined } from "../../src/test-utils/require-defined.js";

describe("parseCidr / ipInAnyCidr", () => {
  it("matches IPv4 addresses inside a CIDR and rejects those outside", () => {
    const c = requireDefined(parseCidr("10.0.0.0/24"));
    expect(ipInAnyCidr("10.0.0.7", [c])).toBe(true);
    expect(ipInAnyCidr("10.0.1.7", [c])).toBe(false);
  });

  it("treats a bare IPv4 as a /32 host route", () => {
    const c = requireDefined(parseCidr("127.0.0.1"));
    expect(ipInAnyCidr("127.0.0.1", [c])).toBe(true);
    expect(ipInAnyCidr("127.0.0.2", [c])).toBe(false);
  });

  it("matches IPv6 CIDRs and normalizes IPv4-mapped IPv6 to IPv4", () => {
    const v6 = requireDefined(parseCidr("2001:db8::/32"));
    expect(ipInAnyCidr("2001:db8::1", [v6])).toBe(true);
    expect(ipInAnyCidr("2001:dead::1", [v6])).toBe(false);
    // A dual-stack loopback peer arrives as ::ffff:127.0.0.1 — a v4 CIDR must
    // still match it.
    const v4 = requireDefined(parseCidr("127.0.0.1/32"));
    expect(ipInAnyCidr("::ffff:127.0.0.1", [v4])).toBe(true);
  });

  it("rejects malformed CIDRs and out-of-range prefixes", () => {
    expect(parseCidr("not-an-ip")).toBeNull();
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0/-1")).toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
  });
});

describe("resolvePublicRemote", () => {
  const trusted = [requireDefined(parseCidr("10.0.0.0/24"))];

  it("returns the client hop when the peer is a trusted proxy", () => {
    // Peer 10.0.0.5 is our proxy; it appended the client 203.0.113.9.
    expect(resolvePublicRemote("10.0.0.5", "203.0.113.9", trusted)).toBe("203.0.113.9");
  });

  it("walks right-to-left past chained trusted proxies to the real client", () => {
    // client, edge-proxy, inner-proxy(=peer). Both proxies are trusted.
    expect(resolvePublicRemote("10.0.0.5", "203.0.113.9, 10.0.0.4", trusted)).toBe("203.0.113.9");
  });

  it("ignores a forged left-side hop the client pre-populated", () => {
    // Attacker sent XFF: "1.2.3.4"; the trusted proxy appended their real IP.
    expect(resolvePublicRemote("10.0.0.5", "1.2.3.4, 203.0.113.9", trusted)).toBe("203.0.113.9");
  });

  it("ignores the header entirely when the peer is NOT a trusted proxy", () => {
    // Direct attacker spoofing XFF — must fall back to the socket address.
    expect(resolvePublicRemote("198.51.100.7", "203.0.113.9", trusted)).toBe("198.51.100.7");
  });

  it("falls back when there are no trusted proxies configured", () => {
    expect(resolvePublicRemote("10.0.0.5", "203.0.113.9", [])).toBe("10.0.0.5");
  });

  it("falls back on a malformed forwarded hop", () => {
    expect(resolvePublicRemote("10.0.0.5", "attacker.example", trusted)).toBe("10.0.0.5");
  });

  it("falls back when every hop is a trusted proxy (no client to attribute)", () => {
    expect(resolvePublicRemote("10.0.0.5", "10.0.0.4", trusted)).toBe("10.0.0.5");
  });
});
