# MCP 2026-07-28 readiness — design

2026-07-26. Status: **proposed — awaiting Mihir's review; implementation not
started.**
The final "stateless MCP" protocol revision (2026-07-28, RC published
2026-05-21) lands two days after this spec's date. This document settles
what daftari adopts, what it defers, and what it will never adopt.

## Why

What the 2026-07-28 revision changes, from the RC:

- The `initialize` handshake and `Mcp-Session-Id` headers are **removed**;
  client info moves into `_meta` on every request. Servers become
  per-request stateless and can sit behind round-robin load balancers.
- Sampling, Roots, and Logging are formally **deprecated** (SEP-2577), with
  guidance that servers should never have adopted sampling — call provider
  APIs directly.
- Elicitation is reworked into a stateless `InputRequiredResult`: the server
  returns a prompt plus opaque state, the client resubmits with the answer.
- Tool schemas expand to full **JSON Schema 2020-12**; `structuredContent`
  may be any JSON value.
- **Tasks** graduate to a standalone extension: `tools/call` may return a
  durable task handle, polled via `tasks/get`/`list`/`cancel`/`result`, with
  per-tool `execution.taskSupport` declarations.
- A `resource_link` content type — handles, not payloads.

Where daftari actually stands today, from the code:

- `package.json` pins `@modelcontextprotocol/sdk` at `^1.29.0` — a
  Streamable-HTTP-era SDK. Adopting 2026-07-28 means a major-line bump; the
  work below assumes the SDK ships the stateless transport and Tasks types.
- `src/server.ts` registers exactly **two** request handlers — ListTools and
  CallTool — and declares `capabilities: { tools: {} }`. No resources, no
  prompts, no elicitation, no `outputSchema` on any tool; every result is
  one `text` block, `JSON.stringify(result.value, null, 2)`.
- `src/serve/index.ts` (spec 2026-07-20) is built on exactly the machinery
  the revision deletes: a `sessions` map keyed by `Mcp-Session-Id`, an
  `isInitializeRequest` gate, a session-id-is-not-a-credential re-check.
- `src/cli.ts` shows `sleep`, `consolidate`, `audit`, and `eval` are
  **CLI-only** — minutes-long maintenance passes no MCP client can invoke
  today, and that would time out any synchronous `tools/call` if they could.

## Decision 1 — `daftari serve` goes stateless; identity is per REQUEST, resolved every time

The 2026-07-20 spec's Decision 2 bound identity per MCP session because a
session was the smallest unit the transport offered. The session is gone;
the principle survives with a smaller word in it: **identity is per request,
resolved on every request, against the same config-declared map**. Nothing
about `.daftari/config.yaml` changes: the `server.auth.tokens` and
`server.auth.oauth` blocks, the fail-loud gates in `validateServeStartup`,
the constant-time `matchToken`, and the reject-never-guest rule all carry
over verbatim.

Credentials stay in the `Authorization` header where they belong. `_meta`
carries client *info* (name, version) for diagnostics; it is client-asserted
and never trusted for identity — the bearer token is the credential. The
`authenticate` function in `src/serve/index.ts` is already shaped for this;
it stops being a session-open ceremony and becomes the first line of every
request. The session table dies, and with it the code that existed only to
compensate for transport state: the `sessions: Map<string, LiveSession>` and
its `existing.user !== access.user` re-check (vacuous when every request
authenticates itself), and the `isInitializeRequest` gate (there is no
initialize).

`createServer(vaultRoot, access, toolsConfig)` already parameterizes the
access context, which is why the 2026-07-20 migration was cheap and why this
one is too. One `Server` per request would work but wastes allocation; the
registry is static and the closure varies only over identity, so serve keeps
a **per-identity cache**:

```ts
// One Server per resolved identity — keyed on user:roleName, the only
// inputs the closure varies over.
const byIdentity = new Map<string, Server>();
function serverFor(access: AccessContext): Server {
  const key = `${access.user} ${access.roleName}`;
  const s = byIdentity.get(key) ?? createServer(vaultRoot, access, config.tools);
  byIdentity.set(key, s);
  return s;
}
```

The cache is bounded by the config: the set of resolvable identities is the
token list plus the OAuth subjects table — declared, finite, no eviction
needed. RBAC staying config-driven does load-bearing work here. And the
stateless transport does NOT change one thing: **single-holder is the
process lock's job, not the transport's**. Two daftari processes on the same
vault is what `.daftari/process.lock` refuses (2026-07-20 Decision 4),
stateless wire or not; multi-instance stays out of scope exactly as before.

stdio (`src/index.ts`) is untouched — `--user`/`--role` bind identity for
the process lifetime; there is no header to resolve per-request. Serve
speaks the 2026-07-28 revision only: no dual-stacking (the precedent set by
refusing the deprecated HTTP+SSE transport); lagging clients use stdio. And
since #5 is itself not yet implemented, the ideal outcome is that serve is
*built* stateless and the session-map code above is never written.

## Decision 2 — docs and collections become MCP resources

`capabilities` gains `resources: {}` and the server registers templates:

```json
{
  "resourceTemplates": [
    { "uriTemplate": "daftari://doc/{+path}", "name": "Vault document", "mimeType": "text/markdown" },
    { "uriTemplate": "daftari://collection/{name}", "name": "Collection listing", "mimeType": "application/json" }
  ]
}
```

Resources are not a convenience feature here; they are the protocol-level
statement of the first house rule — **markdown with YAML frontmatter is the
source of truth**. A client that speaks resources can pin and re-read a doc
as a thing with an identity, instead of re-running a search and hoping the
same text comes back. `resources/read` returns the file verbatim,
frontmatter included — the metadata layer IS part of the document.

The invariant that gates all of it: **`resources/list` is a doc list, and
doc lists never name docs in unreadable collections** (2026-07-14 spec:
omission over redaction, no existence leak). Listing filters through the
same `canRead` predicate as `vault_list`; an unreadable doc is absent, never
present-but-forbidden. `resources/read` on an unreadable path returns the
same not-found shape as a nonexistent path — a distinguishable "forbidden"
IS the existence leak. Collection resources list only readable collections,
and resources resolve against the caller's access context exactly as tools
do (Decision 1). Templates themselves are safe to advertise — a URI *shape*
names no document.

Tension and edge data do **not** become resources: they are derived,
disclosure-coarsened views (none/some/many, never exact counts), and stable
URIs would invite clients to treat them as documents. They stay behind
their tools, where the coarsening already lives.

## Decision 3 — `outputSchema` everywhere; compact `content`, full `structuredContent`, `resource_link` for bodies

Today `ToolDefinition` (src/tools/read.ts) has `inputSchema` and nothing
else; every result ships as pretty-printed JSON in a text block. Search and
lint are the worst token offenders — `vault_search` returns full chunk
bodies for every hit, serialized twice over, and vault-wide `vault_lint`
output is a wall.

`ToolDefinition` grows one field:

```ts
  inputSchema: Record<string, unknown>;   // now full JSON Schema 2020-12
  outputSchema: Record<string, unknown>;  // REQUIRED — no tool ships without one
```

Required, not optional — the handlers already return typed values
(`Result<T, Error>`, house rule), so an unschematized output is a type we
were too lazy to write down. JSON Schema 2020-12 means the frontmatter enums
(`status`, `confidence`, `domain`) appear as enums on the wire, and clients
can validate before parsing.

The CallTool bridge in `src/server.ts` splits its response into three
channels:

- **`structuredContent`** — the full typed result, verbatim, matching
  `outputSchema` (any JSON value now, so hit lists need no wrapper object);
- **`content`** — a compact, model-facing summary: for search, rank + path +
  score + snippet; for lint, counts by severity and the top findings;
- **`resource_link`** entries — for every doc a result references, a link to
  `daftari://doc/{path}` (Decision 2) instead of the body. Handles, not
  payloads: the agent reads the two docs it actually needs at full fidelity
  via `resources/read`, instead of receiving twenty bodies it will truncate
  in context anyway.

Links inherit read-gating — a search can only surface docs the caller can
read (already true), so every emitted link is readable by construction.
Tests mirror src/ as always; every tool's test asserts its output validates
against its own schema.

## Decision 4 — the maintenance passes become Tasks; fast tools stay synchronous

`sleep`, `consolidate`, `audit`, and `eval` are today CLI-only
(`src/cli.ts`) because they are minutes-long — the exact shape the Tasks
extension exists for. Each gains a task-only MCP tool (`vault_sleep`,
`vault_consolidate`, `vault_audit`, `vault_eval`):

```json
{ "name": "vault_sleep", "execution": { "taskSupport": "required" } }
```

`tools/call` returns a durable task handle immediately; the pass runs
in-process, against the vault the process lock guarantees we exclusively
hold; `tasks/get` reports progress through the plumbing
`makeProgressReporter` feeds today; `tasks/result` returns the report shaped
per Decision 3. Task state lives in `.daftari/index.db` — ephemeral by
design; a restart forgets unfinished tasks, and the passes are idempotent
because the CLI can be re-run. One maintenance pass at a time per vault, as
today: calling a pass while one runs returns the *running* task's handle
rather than an error — the caller wanted the pass to happen, and it is
happening.

Gating, in order of severity:

- **The Tension Court is NOT exposed. Full stop.** `daftari court` stays
  CLI-only; court/docket code never takes an access context (house rule),
  and exposing any court surface via MCP requires revisiting the 2026-07-14
  edge-graph spec first. The Tasks extension changes none of this.
- The four task tools are **full-tier only** — free, since full is never
  enumerated in `src/server.ts` and new tools are full-tier by default.
- RBAC: the passes stage under the loop-principal model — `consolidate` runs
  as its own agent principal, its proposals land in the staged-action queue
  for ratification, never as direct canon writes. The task tools require a
  role holding the loop grants, and `tasks/list` shows a caller only tasks
  its own identity started (a task list is a doc list in disguise; omission
  over redaction applies).
- The advisory rule is untouched: task-run passes report and stage; they do
  not fix and do not ratify.

Everything fast — the whole current registry — stays synchronous
(`taskSupport` omitted); a task handle for a 40ms read is ceremony.

## Decision 5 — `vault_ratify` speaks form-mode elicitation

`vault_ratify` (src/tools/staged-actions.ts) is the human approve/reject
gate for the staged-action queue. Today the calling agent relays the
question however it likes — the approval UX is whatever the client
improvises. The reworked stateless elicitation (SEP-1330/SEP-1034) lets the
server hand the client a *form*: `vault_ratify` called without a decision
returns an `InputRequiredResult` —

```json
{
  "prompt": "Ratify staged action a-91: promote _drafts/helios-margins.md to canonical?",
  "schema": {
    "type": "object",
    "required": ["decision"],
    "properties": {
      "decision": { "enum": ["approve", "reject"], "default": "reject" }
    }
  },
  "state": "<opaque: action id + vault HEAD sha, HMAC-signed>"
}
```

The client renders the form, the human answers, the client resubmits with
the answer and the opaque state. The state carries the action id and vault
HEAD at proposal time, signed so it round-trips untampered; a resubmit
against a moved HEAD re-checks the action is still pending and conflict-free
(the existing dispatch path already re-validates). The server remembers
nothing between the two requests; the default is `reject`, so the safe
answer is the preselected one.

This is the strongest protocol-level expression of the house's advisory
posture: **the server proposes, the human disposes**, and now the wire
format itself says so. RBAC is unchanged — the resubmitted decision is
enforced against the requester's `ratify` grant exactly as today, and a
direct call with the decision inline keeps working for clients that don't
do elicitation.

## Decision 6 — sampling: never. Stated once, here, so it stops being implicit

Daftari has never used MCP sampling and now formally never will. SEP-2577
deprecates it with guidance matching what this codebase already does: the
LLM-calling features — `eval`'s judging, `consolidate`'s synthesis,
`audit --semantic` — call the provider directly through the pinned
`@anthropic-ai/sdk` (^0.110.0), CLI-side, on the operator's own key.

This was implicit; making it a decision makes it enforceable, and the
reasons are daftari's, not just the SEP's: sampling routes the server's LLM
calls through whichever client happens to be connected, so a shared serve
would have maintenance quality vary by client and the vault's epistemics
depend on an unpinned, uninspectable model. The witness track records and
eval baselines assume the judging model is an operator choice; it stays one.
Decision 4's task tools *trigger* the passes over MCP; their LLM calls still
go direct — the transport never carries inference in either direction.

## Out of scope

- The **MCP Apps UI extension** — a ratification UI is a separate spec, if
  ever.
- **Registry / server-card publication.** `package.json` already carries
  `mcpName: io.github.mavaali/daftari`; publishing metadata is a release
  concern, not a protocol-readiness one.
- Replacements for deprecated Roots/Logging — daftari uses neither.
- Multi-instance serve behind a real load balancer — Decision 1 removes the
  transport obstacle; the process lock and local locks remain the
  architectural one, deliberately (2026-07-20 Decision 3).
- Any court surface over MCP (restated from Decision 4; it bears restating).

## Kill condition

[HYPOTHESIS] This spec bets that the final 2026-07-28 revision matches the
2026-05-21 RC in the load-bearing places. Per decision:

- If the final revision **retains sessions**, or ships a session-optional
  transport that major clients standardize on, Decision 1 reverts to the
  2026-07-20 per-session model — fully specified there, nothing lost.
- If the **Tasks extension slips** from final publication, or the pinned SDK
  line does not ship it within a release cycle, Decision 4's four tools do
  not ship; the passes remain CLI-only — today's world, costing the wait.
- If stateless **elicitation** lands materially different from
  `InputRequiredResult` (e.g. server-held state), Decision 5 ships only the
  direct-call form of `vault_ratify` (today's behavior) until re-specified.
- Decisions 2, 3, and 6 carry no protocol risk worth naming — resources and
  `structuredContent` predate this revision, and "never sample" cannot be
  invalidated by a spec that deprecates sampling.

Each decision lands as its own PR, in the order written; Decision 1 gates
only Decision 4 (tasks ride the new transport's types).
