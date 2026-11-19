// OAuth 2.1 discovery for `daftari serve` — the resource-server half of the
// MCP authorization handshake. Remote MCP clients (ChatGPT, claude.ai and the
// Claude apps, Claude Code) find the authorization server by reading an
// RFC 9728 protected-resource metadata document, located either through the
// `WWW-Authenticate: Bearer resource_metadata="…"` challenge on a 401
// (RFC 6750 §3) or by probing `/.well-known/oauth-protected-resource[/<mcp
// path>]` on the server's origin. Daftari never issues tokens: the document
// only points at the operator's IdP (`server.auth.oauth.issuer`).
//
// Everything here is derived from config alone — `server.public_base_url`
// and `server.auth.oauth.issuer` — never from Host or X-Forwarded-* headers.
// Identity and public URLs are config-declared, not request-derived (the
// same rule that confines X-Forwarded-For to `trusted_proxies`). Nothing
// from vault files, roles, subjects, or collections appears in the document.

import type { DaftariConfig } from "../utils/config.js";

export const WELL_KNOWN_PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";

export interface ProtectedResourceDocument {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
}

export interface DiscoveryEndpoints {
  // The MCP URL exactly as a user enters it in a client: `<public_base_url>/mcp`.
  resource: string;
  // Where the challenge header points: the path-aware well-known URL.
  metadataUrl: string;
  // Both RFC 9728 locations, matched exactly on the request pathname: the
  // origin-root form (Claude's fallback probe) and the path-aware form.
  wellKnownPaths: string[];
  // Pathnames that reach the MCP handler. `public_base_url` may carry a path
  // prefix that the proxy preserves on the wire (docs/integrations.md), so
  // `<prefix>/mcp` must route like bare `/mcp` or discovery hands clients a
  // URL that 404s.
  mcpPaths: string[];
  document: ProtectedResourceDocument;
}

// Null unless BOTH oauth and public_base_url are configured: tokens-only
// deployments have nothing to discover, and without a declared public URL
// there is no `resource` value daftari may honestly publish.
export function discoveryEndpoints(server: DaftariConfig["server"]): DiscoveryEndpoints | null {
  if (server.oauth === undefined || server.publicBaseUrl === undefined) return null;
  const base = new URL(server.publicBaseUrl);
  // A root base URL has pathname "/", which strips to "" — so this is "" at
  // the root and "/daftari" for https://host/daftari.
  const prefix = base.pathname.replace(/\/$/, "");
  const resourcePath = `${prefix}/mcp`;
  const resource = `${base.origin}${resourcePath}`;
  const metadataPath = `${WELL_KNOWN_PROTECTED_RESOURCE}${resourcePath}`;
  return {
    resource,
    metadataUrl: `${base.origin}${metadataPath}`,
    wellKnownPaths: [WELL_KNOWN_PROTECTED_RESOURCE, metadataPath],
    mcpPaths: resourcePath === "/mcp" ? ["/mcp"] : ["/mcp", resourcePath],
    document: {
      resource,
      authorization_servers: [server.oauth.issuer],
      bearer_methods_supported: ["header"],
    },
  };
}

// The RFC 6750 challenge for a Bearer 401. `error="invalid_token"` is added
// only when a credential was actually presented; a bare request gets the
// bare challenge. No `error_description` — the response body already does
// not distinguish expired / bad-signature / wrong-audience, and neither
// should the header.
export function challengeHeader(metadataUrl: string, bearerPresented: boolean): string {
  const challenge = `Bearer resource_metadata="${metadataUrl}"`;
  return bearerPresented ? `${challenge}, error="invalid_token"` : challenge;
}
