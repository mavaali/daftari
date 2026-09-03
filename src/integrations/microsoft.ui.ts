// Task U20 (Requirement R9): the server-rendered Microsoft picker `/ui` page
// — msal-browser + File Picker v8 in a popup, CSP, and the static-asset
// serving that backs it. Kept OUT of routes.ts's HTTP plumbing and OUT of
// serve/index.ts's generic board/HTML helpers: this module owns everything
// Microsoft-specific about the page (HTML, CSP, asset resolution), and
// routes.ts only wires it to the two GET endpoints.
//
// @azure/msal-browser is BROWSER-ONLY. It is never imported here (or
// anywhere under src/) — this module only reads its vendored build off disk
// as opaque bytes and serves it as a static asset. That keeps it out of the
// server's own module graph / tsc build entirely.

import { readFileSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// The vendored msal-browser/msal-common build + this page's own glue and
// payload-serializer live alongside this module's compiled output (see
// package.json's `files` — "src/integrations/microsoft/assets" ships
// alongside "dist" so this resolves in both dev (running from src/) and an
// installed package (running from dist/)).
const ASSETS_ROOT = resolve(HERE, "microsoft", "assets");

// design §5.1: default-src/script-src both 'self' (no inline script — the
// page loads only its own vendored msal-browser + glue asset), connect-src
// widened only to the two hosts a picker round-trip actually talks to, and
// form-action widened to SharePoint since the picker's own internal forms
// post there. Exported verbatim so a test can assert byte-for-byte equality.
export const MICROSOFT_UI_CSP =
  "default-src 'self'; script-src 'self'; " +
  "connect-src 'self' https://login.microsoftonline.com https://*.sharepoint.com; " +
  "form-action 'self' https://*.sharepoint.com";

// Same Entra host the OAuth adapter (microsoft.ts) authorizes/exchanges
// against and the CSP's connect-src names — msal-browser's `authority` is
// just that host plus the tenant.
const MICROSOFT_AUTHORITY_HOST = "https://login.microsoftonline.com";

export function microsoftUiAuthority(tenantId: string): string {
  return `${MICROSOFT_AUTHORITY_HOST}/${tenantId}`;
}

export interface MicrosoftUiPageConfig {
  provider: "microsoft";
  clientId: string;
  authority: string;
  pickerHost: string;
  collections: string[];
}

function escHtml(value: string): string {
  return value.replace(
    /[<>&"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] as string,
  );
}

function escAttr(value: string): string {
  return escHtml(value).replace(/'/g, "&#39;");
}

// The picker `/ui` page. No inline `<script>` — CSP `script-src 'self'`
// forbids it — so all behavior lives in the externally-loaded glue.js
// (config is handed across via a `data-config` attribute, read by glue.js at
// startup, not by inline JS here).
export function renderMicrosoftUiPage(config: MicrosoftUiPageConfig): string {
  const options = config.collections
    .map((collection) => `<option value="${escAttr(collection)}">${escHtml(collection)}</option>`)
    .join("");
  const dataConfig = escAttr(
    JSON.stringify({
      clientId: config.clientId,
      authority: config.authority,
      pickerHost: config.pickerHost,
      provider: config.provider,
    }),
  );
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Enroll Microsoft 365 content</title></head>` +
    `<body>` +
    `<main id="microsoft-picker-root" data-config='${dataConfig}'>` +
    `<h1>Enroll Microsoft 365 content</h1>` +
    `<label for="collection-select">Collection</label>` +
    `<select id="collection-select">${options}</select>` +
    `<button type="button" id="select-files-button">Select files</button>` +
    `<p id="picker-status" role="status"></p>` +
    `<label><input type="checkbox" id="audience-ack">` +
    `I acknowledge the audience this content will be visible to.</label>` +
    `<button type="button" id="enroll-button" disabled>Enroll</button>` +
    `</main>` +
    `<script type="module" src="/integrations/${config.provider}/ui/assets/glue.js"></script>` +
    `</body></html>`
  );
}

// Path-traversal-safe resolution of a requested asset filename against the
// vendored/glue assets directory. Rejects (returns null, never throws) an
// absolute-looking request or one that escapes ASSETS_ROOT after
// normalization — the two shapes a `../../etc/passwd` or `%2e%2e` traversal
// attempt takes once the route layer has already `decodeURIComponent`-ed the
// path segment.
export function resolveMicrosoftUiAssetPath(requested: string): string | null {
  if (requested.length === 0) return null;
  // A leading slash (or backslash, for a Windows deploy) makes path.resolve
  // treat the segment as absolute and IGNORE the base directory entirely —
  // reject before that footgun rather than relying on the startsWith check
  // below to catch it after the fact.
  if (requested.startsWith("/") || requested.startsWith("\\") || requested.includes("\0")) {
    return null;
  }
  const candidate = resolve(ASSETS_ROOT, requested);
  if (candidate !== ASSETS_ROOT && !candidate.startsWith(ASSETS_ROOT + sep)) return null;
  return candidate;
}

const JS_EXTENSIONS = new Set([".js", ".mjs"]);

// `text/javascript` per the current WHATWG/IANA-registered MIME type for JS
// modules (`application/javascript` is the legacy alias U20's spec also
// accepts).
export function contentTypeForMicrosoftUiAsset(path: string): string | null {
  return JS_EXTENSIONS.has(extname(path)) ? "text/javascript; charset=utf-8" : null;
}

export interface MicrosoftUiAsset {
  contentType: string;
  body: Buffer;
}

// Reads and returns an asset by its request-relative filename, or null when
// the file doesn't exist / traversal was attempted / the extension isn't a
// served JS asset. The route layer maps null to a 404 — never a 500, since a
// bad filename is caller error, not a server fault.
export function readMicrosoftUiAsset(requested: string): MicrosoftUiAsset | null {
  const path = resolveMicrosoftUiAssetPath(requested);
  if (path === null) return null;
  const contentType = contentTypeForMicrosoftUiAsset(path);
  if (contentType === null) return null;
  try {
    return { contentType, body: readFileSync(path) };
  } catch {
    return null;
  }
}
