export type ParsedSourceRef =
  | { kind: "vault"; raw: string; target: string }
  | { kind: "repo"; raw: string; target: string }
  | { kind: "external"; raw: string }
  | { kind: "distill"; raw: string }
  | { kind: "opaque"; raw: string }
  | { kind: "legacy"; raw: string; target: string };

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// `sources` is a provenance channel, not exclusively a vault-edge channel.
// Prefixes make the address space explicit; unprefixed values retain legacy
// compatibility and become vault dependencies only when they actually resolve.
export function parseSourceRef(value: string): ParsedSourceRef {
  const raw = value.trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith("vault:")) return { kind: "vault", raw, target: raw.slice(6).trim() };
  if (lower.startsWith("repo:")) return { kind: "repo", raw, target: raw.slice(5).trim() };
  if (/^(https?:|mailto:)/i.test(raw)) return { kind: "external", raw };
  if (lower.startsWith("distill:")) return { kind: "distill", raw };
  if (URI_SCHEME.test(raw)) return { kind: "opaque", raw };
  return { kind: "legacy", raw, target: raw };
}
