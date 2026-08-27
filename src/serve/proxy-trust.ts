// Trusted-proxy resolution for the public request path (security finding F4).
//
// X-Forwarded-For is client-controllable and therefore only trustworthy when
// the request reached us THROUGH a proxy we operate. A boolean "trust the
// header" flag is a footgun: a direct attacker forges the header to move their
// rate-limit / auth-penalty key onto an arbitrary IP — evading their own limit
// or framing a victim into lockout. Instead we take an explicit set of
// trusted-proxy CIDRs. The header is honored only when the immediate socket
// peer is inside one of them, and the real client is the first hop from the
// RIGHT that is not itself a trusted proxy (each proxy APPENDS the peer it saw,
// so any left-side entries are attacker-supplied).

import { isIP } from "node:net";

export interface CidrRange {
  base: bigint;
  bits: number;
  version: 4 | 6;
}

// A dual-stack listener reports IPv4 peers as IPv4-mapped IPv6
// (`::ffff:203.0.113.9`); collapse that to the bare IPv4 so a v4 CIDR matches.
function normalizeMappedV4(ip: string): string {
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  return match ? match[1] : ip;
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    acc = (acc << 8n) | BigInt(n);
  }
  return acc;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const withoutZone = ip.split("%", 1)[0] ?? ip;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (segment: string): bigint[] | null => {
    if (segment === "") return [];
    const out: bigint[] = [];
    const groups = segment.split(":");
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.includes(".")) {
        // An embedded IPv4 tail (e.g. ::ffff:1.2.3.4) occupies two groups.
        if (i !== groups.length - 1) return null;
        const v4 = ipv4ToBigInt(group);
        if (v4 === null) return null;
        out.push((v4 >> 16n) & 0xffffn, v4 & 0xffffn);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
        out.push(BigInt(Number.parseInt(group, 16)));
      }
    }
    return out;
  };
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  const filled = head.length + tail.length;
  let groups: bigint[];
  if (halves.length === 2) {
    if (filled > 8) return null;
    groups = [...head, ...Array<bigint>(8 - filled).fill(0n), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let acc = 0n;
  for (const g of groups) acc = (acc << 16n) | g;
  return acc;
}

function ipToBigInt(ip: string, version: 4 | 6): bigint | null {
  return version === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
}

/** Parse "addr" (implicit host route) or "addr/prefix"; null if malformed. */
export function parseCidr(spec: string): CidrRange | null {
  const slash = spec.indexOf("/");
  const ipStr = normalizeMappedV4(slash === -1 ? spec : spec.slice(0, slash));
  const family = isIP(ipStr);
  if (family === 0) return null;
  const version: 4 | 6 = family === 4 ? 4 : 6;
  const max = version === 4 ? 32 : 128;
  let bits = max;
  if (slash !== -1) {
    const raw = spec.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw)) return null;
    bits = Number(raw);
    if (bits > max) return null;
  }
  const value = ipToBigInt(ipStr, version);
  if (value === null) return null;
  const hostBits = BigInt(max - bits);
  return { base: (value >> hostBits) << hostBits, bits, version };
}

export function ipInCidr(ip: string, cidr: CidrRange): boolean {
  const normalized = normalizeMappedV4(ip);
  const family = isIP(normalized);
  if (family === 0) return false;
  const version: 4 | 6 = family === 4 ? 4 : 6;
  if (version !== cidr.version) return false;
  const value = ipToBigInt(normalized, version);
  if (value === null) return false;
  const max = version === 4 ? 32 : 128;
  const hostBits = BigInt(max - cidr.bits);
  return (value >> hostBits) << hostBits === cidr.base;
}

export function ipInAnyCidr(ip: string, cidrs: CidrRange[]): boolean {
  return cidrs.some((cidr) => ipInCidr(ip, cidr));
}

/** Parse a config list of CIDR strings, dropping any that fail to parse. */
export function parseTrustedProxies(specs: string[]): CidrRange[] {
  const out: CidrRange[] = [];
  for (const spec of specs) {
    const cidr = parseCidr(spec);
    if (cidr !== null) out.push(cidr);
  }
  return out;
}

/**
 * The client IP to attribute a public request to. Honors X-Forwarded-For only
 * when the immediate peer is a trusted proxy, then returns the first hop from
 * the right that is not itself a trusted proxy. Falls back to the socket
 * address whenever the header cannot be trusted or no client can be attributed.
 */
export function resolvePublicRemote(
  socketRemote: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxies: CidrRange[],
): string {
  const fallback = socketRemote ?? "unknown";
  if (trustedProxies.length === 0 || socketRemote === undefined) return fallback;
  if (!ipInAnyCidr(socketRemote, trustedProxies)) return fallback;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  if (typeof header !== "string") return fallback;
  const hops = header
    .split(",")
    .map((hop) => hop.trim().replace(/^\[|\]$/g, ""))
    .filter((hop) => hop.length > 0);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (isIP(normalizeMappedV4(hop)) === 0) return fallback;
    if (!ipInAnyCidr(hop, trustedProxies)) return hop;
  }
  return fallback;
}
