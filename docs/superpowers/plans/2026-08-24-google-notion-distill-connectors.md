# Google Docs and Notion Distillation Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deployment-owned Google Docs and Notion connectors that discover accessible sources, continuously distill changed content into staged Daftari proposals, and preserve source lifecycle without storing raw text.

**Architecture:** A provider-neutral `src/integrations` engine owns encrypted local state, OAuth transaction handling, change reconciliation, and source lifecycle. Google and Notion adapters isolate provider HTTP and normalization. `serve` remains provider-agnostic and only registers routes plus a periodic fallback scheduler.

**Tech Stack:** TypeScript 6, Node built-in `crypto` and `fetch`, Vitest, and existing Daftari Result/distill modules.

**Spec:** `docs/superpowers/specs/2026-08-24-google-notion-distill-connectors-design.md`

## Global Constraints

- V1 permits one Google connection and one Notion connection per vault.
- Client IDs, client secrets, and state-encryption keys come only from named environment variables.
- Encrypt local integration state with AES-256-GCM; reject invalid 32-byte base64 keys.
- Do not persist fetched document bodies, provider response bodies, or credentials in Markdown or logs.
- Native Google Docs and Notion pages/databases only; PDFs are explicitly out of scope.
- Changed sources stage proposals through the existing distill path and never auto-ratify, overwrite, retire, or delete Daftari knowledge.
- Webhooks are preferred with `server.public_base_url`; polling is the localhost fallback.
- Remote deletion/access loss records an unavailable review event and never alters derived documents.

---

### Task 1: Configuration and encrypted integration state

**Files:**
- Create: `src/integrations/types.ts`
- Create: `src/integrations/state.ts`
- Create: `test/integrations/state.test.ts`
- Modify: `src/utils/config.ts`
- Modify: `test/utils/config.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces `IntegrationConfig`, `ProviderState`, `SourceState`, `readIntegrationState`, and `writeIntegrationState`.
- Consumes `Result<T, Error>` and `DaftariConfig`.

- [x] **Step 1: Write the failing state and config tests**

```ts
it("rejects a client secret declared directly in YAML", () => {
  writeConfig("integrations:\n  encryption_key_env: KEY\n  google:\n    client_id_env: ID\n    client_secret: leaked\n");
  expect(loadConfig(vault).ok).toBe(false);
});

it("round-trips encrypted credentials without plaintext on disk", () => {
  expect(writeIntegrationState(vault, state("refresh-token"), KEY).ok).toBe(true);
  expect(readFileSync(integrationStatePath(vault), "utf8")).not.toContain("refresh-token");
  expect(readIntegrationState(vault, KEY)).toEqual(ok(state("refresh-token")));
});
```

- [x] **Step 2: Run the focused tests and confirm red**

Run: `npx vitest run test/integrations/state.test.ts test/utils/config.test.ts`

Expected: FAIL because the integration config and state exports do not exist.

- [x] **Step 3: Write the minimal implementation**

```ts
export interface IntegrationConfig {
  encryptionKeyEnv: string;
  pollingIntervalMinutes: number;
  google?: IntegrationProviderConfig;
  notion?: IntegrationProviderConfig;
}

export function writeIntegrationState(vaultRoot: string, state: IntegrationState, key: Buffer): Result<void, Error> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return writeEnvelope(vaultRoot, { version: 1, nonce, ciphertext, tag: cipher.getAuthTag() });
}
```

- [x] **Step 4: Run focused tests and commit**

Run: `npx vitest run test/integrations/state.test.ts test/utils/config.test.ts`

Expected: PASS.

```bash
git add src/integrations/types.ts src/integrations/state.ts test/integrations/state.test.ts src/utils/config.ts test/utils/config.test.ts .gitignore
git commit -m "feat: add encrypted integration state"
```

### Task 2: OAuth transactions and the provider-neutral engine

**Files:**
- Create: `src/integrations/oauth.ts`
- Create: `src/integrations/engine.ts`
- Create: `test/integrations/oauth.test.ts`
- Create: `test/integrations/engine.test.ts`

**Interfaces:**
- Consumes the Task 1 config/state and injected provider adapters.
- Produces `beginAuthorization`, `completeAuthorization`, `reconcileProvider`, and `startPeriodicIntegrationSync`.

- [x] **Step 1: Write the failing OAuth and reconciliation tests**

```ts
it("rejects a replayed OAuth state before exchanging code", async () => {
  const started = beginAuthorization(vault, "google", config, env, now);
  expect(started.ok).toBe(true);
  expect((await completeAuthorization(vault, "google", started.value.state, "code", deps)).ok).toBe(true);
  expect((await completeAuthorization(vault, "google", started.value.state, "code", deps)).ok).toBe(false);
});

it("does not invoke distillation when a normalized source hash is unchanged", async () => {
  await reconcileProvider(vault, googleAdapter, deps);
  expect(deps.distill).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run the focused tests and confirm red**

Run: `npx vitest run test/integrations/oauth.test.ts test/integrations/engine.test.ts`

Expected: FAIL because the engine and OAuth exports do not exist.

- [x] **Step 3: Write the minimal implementation**

```ts
export interface ProviderAdapter {
  readonly name: ProviderName;
  authorizationUrl(input: AuthorizationRequest): string;
  exchangeCode(input: CodeExchange): Promise<Result<ProviderTokens, Error>>;
  discover(state: ProviderState): Promise<Result<RemoteSource[], Error>>;
  fetch(source: RemoteSource, state: ProviderState): Promise<Result<NormalizedRemoteSource, Error>>;
}

export async function reconcileProvider(vaultRoot: string, adapter: ProviderAdapter, deps: EngineDeps): Promise<Result<ReconcileOutcome, Error>> {
  // Fetch, normalize, hash, stage changed sources, and write only state metadata.
}
```

- [x] **Step 4: Run focused tests and commit**

Run: `npx vitest run test/integrations/oauth.test.ts test/integrations/engine.test.ts`

Expected: PASS.

```bash
git add src/integrations/oauth.ts src/integrations/engine.ts test/integrations/oauth.test.ts test/integrations/engine.test.ts
git commit -m "feat: add provider-neutral integration engine"
```

### Task 3: Google Docs adapter

**Files:**
- Create: `src/integrations/google.ts`
- Create: `test/integrations/google.test.ts`

**Interfaces:**
- Implements `ProviderAdapter` for `google`.
- Produces only native Google Docs sources and deterministic normalized text.

- [x] **Step 1: Write the failing Google adapter tests**

```ts
it("discovers only native Google Docs through the Drive change cursor", async () => {
  const result = await adapter.discover(state);
  expect(result.value.map((source) => source.id)).toEqual(["doc-1"]);
});

it("normalizes document paragraphs", async () => {
  const result = await adapter.fetch(remoteDoc("doc-1"), state);
  expect(result.value.text).toBe("Title\n\nFirst paragraph\nSecond paragraph");
});
```

- [x] **Step 2: Run the focused test and confirm red**

Run: `npx vitest run test/integrations/google.test.ts`

Expected: FAIL because `GoogleDocsAdapter` does not exist.

- [x] **Step 3: Write the minimal implementation**

```ts
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

function sourceId(fileId: string): string {
  return `google:${fileId}`;
}

function normalizeGoogleDocument(document: GoogleDocument): string {
  return document.body.content.flatMap(paragraphText).filter(Boolean).join("\n");
}
```

- [x] **Step 4: Run the focused test and commit**

Run: `npx vitest run test/integrations/google.test.ts`

Expected: PASS.

```bash
git add src/integrations/google.ts test/integrations/google.test.ts
git commit -m "feat: add Google Docs integration adapter"
```

### Task 4: Notion adapter

**Files:**
- Create: `src/integrations/notion.ts`
- Create: `test/integrations/notion.test.ts`

**Interfaces:**
- Implements `ProviderAdapter` for `notion`.
- Produces normalized recursive page content and page/database event targets.

- [x] **Step 1: Write the failing Notion adapter tests**

```ts
it("discovers accessible pages and requests discovery after database changes", async () => {
  const result = await adapter.discover(state);
  expect(result.value.map((source) => source.id)).toEqual(["page-1", "page-2"]);
});

it("renders nested blocks into deterministic text", async () => {
  const result = await adapter.fetch(remotePage("page-1"), state);
  expect(result.value.text).toBe("Project plan\n\n- Ship connector\n  - Add tests");
});
```

- [x] **Step 2: Run the focused test and confirm red**

Run: `npx vitest run test/integrations/notion.test.ts`

Expected: FAIL because `NotionAdapter` does not exist.

- [x] **Step 3: Write the minimal implementation**

```ts
async function collectBlocks(pageId: string, cursor?: string): Promise<NotionBlock[]> {
  // Paginate block children and recurse only through has_children blocks.
}

function sourceId(pageId: string): string {
  return `notion:${pageId}`;
}
```

- [x] **Step 4: Run the focused test and commit**

Run: `npx vitest run test/integrations/notion.test.ts`

Expected: PASS.

```bash
git add src/integrations/notion.ts test/integrations/notion.test.ts
git commit -m "feat: add Notion integration adapter"
```

### Task 5: Serve wiring, webhook handling, polling, and unavailable-source review

**Files:**
- Create: `src/integrations/routes.ts`
- Create: `src/integrations/review.ts`
- Create: `test/integrations/routes.test.ts`
- Create: `test/integrations/review.test.ts`
- Modify: `src/serve/index.ts`
- Modify: `test/serve/serve.test.ts`

**Interfaces:**
- Consumes `IntegrationEngine` and the existing authenticated serve router.
- Produces OAuth callback/webhook routes plus a polling stop function.

- [x] **Step 1: Write the failing route and lifecycle tests**

```ts
it("returns 202 for a verified webhook and queues one targeted refresh", async () => {
  const response = await request("POST", "/integrations/google/webhook", validGoogleHeaders);
  expect(response.status).toBe(202);
  expect(engine.enqueue).toHaveBeenCalledTimes(1);
});

it("records an unavailable source without changing derived markdown", () => {
  appendUnavailableReview(vault, unavailable("google:doc-1", "permission_denied"));
  expect(readFileSync(reviewPath(vault), "utf8")).toContain("permission_denied");
  expect(existsSync(join(vault, "claims", "derived.md"))).toBe(true);
});
```

- [x] **Step 2: Run focused tests and confirm red**

Run: `npx vitest run test/integrations/routes.test.ts test/integrations/review.test.ts test/serve/serve.test.ts`

Expected: FAIL because route/review exports do not exist.

- [x] **Step 3: Write the minimal implementation**

```ts
if (url.pathname.startsWith("/integrations/")) {
  const handled = await handleIntegrationRoute(req, res, url, integrationEngine);
  if (handled) return;
}

const stopIntegrations = startPeriodicIntegrationSync(vaultRoot, integrationEngine, config.integrations.pollingIntervalMinutes);
installShutdownHandlers(vaultRoot, () => stopIntegrations());
```

- [x] **Step 4: Run focused tests and commit**

Run: `npx vitest run test/integrations/routes.test.ts test/integrations/review.test.ts test/serve/serve.test.ts`

Expected: PASS.

```bash
git add src/integrations/routes.ts src/integrations/review.ts test/integrations/routes.test.ts test/integrations/review.test.ts src/serve/index.ts test/serve/serve.test.ts
git commit -m "feat: wire continuous integration sync into serve"
```

### Task 6: Documentation, review, verification, and pull request

**Files:**
- Modify: `docs/deployment.md`
- Modify: `docs/README.md`
- Modify: `README.md` only if its integration pointer needs an entry

**Interfaces:**
- Documents config, env variables, callback routes, webhook/poll operation, source retention, and PDF limitation.

- [x] **Step 1: Add deployment and operator documentation**

```markdown
`daftari serve` exposes integration callbacks only when integrations are configured. A public HTTPS callback enables webhooks; localhost deployments retain full functionality through polling. Fetched source text is discarded after the distill attempt.
```

- [ ] **Step 2: Run the complete quality gate**

Run: `npm run build && npm run lint && npm test`

Expected: all checks exit 0. If an existing non-feature failure remains, add its exact command/output to a separate Beads issue and do not attribute it to this feature.

- [ ] **Step 3: Request and apply independent review**

Review the complete diff against the spec. Fix critical and important findings, then rerun Step 2.

- [ ] **Step 4: Commit, push, open PR, and enable auto-merge**

```bash
git add docs src test
git commit -m "feat: add continuous Docs and Notion distillation"
git push -u origin codex/google-notion-distill
gh pr create --fill --base main
gh pr merge --auto --squash
```
