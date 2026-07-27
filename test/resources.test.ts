// MCP resources (spec 2026-07-26, Decision 2).
//
// The tests that matter here are the disclosure ones: a resource listing is a
// doc list, and doc lists never name docs in unreadable collections. Reading an
// unreadable doc must be indistinguishable from reading one that does not
// exist — a distinguishable "forbidden" IS the existence leak.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessContext } from "../src/access/rbac.js";
import { guestAccess } from "../src/access/rbac.js";
import {
  COLLECTION_URI_PREFIX,
  collectionUri,
  DOC_URI_PREFIX,
  docUri,
  listResources,
  readResource,
  resourceTemplates,
} from "../src/resources.js";
import { cleanupVault, makeTempVault } from "./helpers/temp-vault.js";

const PRICING_ANALYST: AccessContext = {
  user: "human:ana",
  roleName: "pricing-analyst",
  role: { read: ["pricing"], write: [], promote: false, ratify: false },
};

const FULL_READER: AccessContext = {
  user: "human:root",
  roleName: "reader",
  role: { read: ["*"], write: [], promote: false, ratify: false },
};

let vault: string;

beforeAll(() => {
  vault = makeTempVault();
});

afterAll(() => {
  cleanupVault(vault);
});

describe("resource templates", () => {
  it("advertises the doc and collection templates unconditionally — a URI shape names no document", () => {
    const templates = resourceTemplates();
    const uris = templates.map((t) => t.uriTemplate);
    expect(uris).toContain(`${DOC_URI_PREFIX}{+path}`);
    expect(uris).toContain(`${COLLECTION_URI_PREFIX}{name}`);
  });
});

describe("resources/list is a doc list, and doc lists obey RBAC", () => {
  it("a full reader sees documents and collections", async () => {
    const result = await listResources(vault, FULL_READER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const docs = result.value.filter((r) => r.uri.startsWith(DOC_URI_PREFIX));
    expect(docs.length).toBeGreaterThan(0);
    expect(result.value.some((r) => r.uri.startsWith(COLLECTION_URI_PREFIX))).toBe(true);
  });

  it("never names a document in a collection the role cannot read", async () => {
    const result = await listResources(vault, PRICING_ANALYST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const resource of result.value) {
      expect(
        resource.uri.includes("competitive-intel"),
        `leaked an unreadable doc: ${resource.uri}`,
      ).toBe(false);
    }
    // ...and it does surface the collection it CAN read, so the filter is
    // doing real work rather than emptying the list.
    expect(result.value.some((r) => r.uri.includes("pricing"))).toBe(true);
  });

  it("the deny-all guest sees nothing at all", async () => {
    const result = await listResources(vault, guestAccess());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

describe("resources/read", () => {
  it("returns the document verbatim, frontmatter included", async () => {
    const list = await listResources(vault, FULL_READER);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const doc = list.value.find((r) => r.uri.startsWith(DOC_URI_PREFIX));
    expect(doc).toBeDefined();
    if (!doc) return;

    const read = await readResource(vault, doc.uri, FULL_READER);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.mimeType).toBe("text/markdown");
    // Frontmatter IS part of the document — the metadata layer is not stripped.
    expect(read.value.text.startsWith("---")).toBe(true);
  });

  it("an unreadable doc and a nonexistent doc return the IDENTICAL error", async () => {
    // Find a doc the pricing analyst may not read, via a full reader's listing.
    const list = await listResources(vault, FULL_READER);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const forbidden = list.value.find((r) => r.uri.includes("competitive-intel"));
    expect(forbidden, "fixture must contain a doc outside the analyst's grant").toBeDefined();
    if (!forbidden) return;

    const denied = await readResource(vault, forbidden.uri, PRICING_ANALYST);
    const missing = await readResource(vault, docUri("pricing/no-such-doc.md"), PRICING_ANALYST);

    expect(denied.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (denied.ok || missing.ok) return;
    // The whole point: same shape, differing only in the URI echoed back.
    expect(denied.error.message).toBe(`resource not found: ${forbidden.uri}`);
    expect(missing.error.message).toMatch(/^resource not found: /);
    expect(denied.error.message.replace(forbidden.uri, "")).toBe(
      missing.error.message.replace(docUri("pricing/no-such-doc.md"), ""),
    );
  });

  it("refuses to escape the vault root", async () => {
    const traversal = await readResource(vault, `${DOC_URI_PREFIX}../../etc/passwd`, FULL_READER);
    expect(traversal.ok).toBe(false);
    if (traversal.ok) return;
    expect(traversal.error.message).toMatch(/^resource not found: /);
  });

  it("an unknown URI scheme is a not-found, not a distinct error", async () => {
    const bogus = await readResource(vault, "daftari://tension/abc123", FULL_READER);
    expect(bogus.ok).toBe(false);
    if (bogus.ok) return;
    expect(bogus.error.message).toMatch(/^resource not found: /);
  });

  it("a collection resource lists only the docs the role may read", async () => {
    const readable = await readResource(vault, collectionUri("pricing"), PRICING_ANALYST);
    expect(readable.ok).toBe(true);
    if (!readable.ok) return;
    const payload = JSON.parse(readable.value.text) as {
      collection: string;
      count: number;
      documents: { path: string }[];
    };
    expect(payload.collection).toBe("pricing");
    expect(payload.count).toBeGreaterThan(0);

    // A collection outside the grant is not found — same rule as documents.
    const denied = await readResource(vault, collectionUri("competitive-intel"), PRICING_ANALYST);
    expect(denied.ok).toBe(false);
  });
});
