// Reusable injected-transport harness for Microsoft adapter tests (U12, R40
// backbone). Every Microsoft unit test (U13-U18) imports from here instead of
// hitting live Graph/Entra endpoints — mirrors the prefix-keyed fixture
// pattern already used by test/integrations/google.test.ts.

import type { MicrosoftHttpTransport } from "../../src/integrations/microsoft.js";
import type { MicrosoftProviderConfig, ProviderState } from "../../src/integrations/types.js";

/**
 * Fixture responses keyed by a URL prefix. Each request consumes (shifts) the
 * next queued Response for the first matching prefix, so tests can script a
 * sequence of pages/replies against the same endpoint.
 */
export type MicrosoftFixtures = Record<string, Response[]>;

// Scripts CANNED RESPONSES only, matched by URL prefix — `init` (method,
// headers, body) is received but discarded, so this cannot assert what a
// caller sent. U13 (token-exchange request body) and U16 (webhook signature
// headers) need to assert on the request, not just script the response: use
// a bespoke inline transport with a `requests` capture array instead (see
// the pattern in test/integrations/google.test.ts), not this helper.
export function createFixtureTransport(fixtures: MicrosoftFixtures): MicrosoftHttpTransport {
  return async (url) => {
    const match = Object.entries(fixtures).find(([prefix]) => url.startsWith(prefix));
    if (match === undefined) throw new Error(`unexpected request: ${url}`);
    const response = match[1].shift();
    if (response === undefined) throw new Error(`no fixture left for: ${url}`);
    return response;
  };
}

/** A generic JSON Graph-style response. */
export function jsonFixture(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A plain-text response (e.g. a delta-page continuation body, a raw download). */
export function textFixture(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
}

/** A 3xx redirect (Graph's `/content` download endpoint redirects to a SAS URL). */
export function redirectFixture(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** A `/me` Graph response, for smoke-testing the transport seam end-to-end. */
export function meFixture(overrides: Record<string, unknown> = {}): Response {
  return jsonFixture({
    id: "user-1",
    displayName: "Test User",
    userPrincipalName: "test.user@example.com",
    ...overrides,
  });
}

/** A minimal, valid ProviderState for constructing adapter calls in tests. */
export function microsoftProviderState(
  overrides: Partial<ProviderState> = {},
  sources: ProviderState["sources"] = {},
): ProviderState {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    sources,
    ...overrides,
  };
}

/** A minimal, valid MicrosoftProviderConfig for constructing the adapter in tests. */
export function microsoftProviderConfig(
  overrides: Partial<MicrosoftProviderConfig> = {},
): MicrosoftProviderConfig {
  return {
    clientIdEnv: "MICROSOFT_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
    tenantId: "test-tenant",
    scopeProfile: "sharepoint",
    collections: ["distill"],
    includeSpeakerNotes: true,
    ...overrides,
  };
}
