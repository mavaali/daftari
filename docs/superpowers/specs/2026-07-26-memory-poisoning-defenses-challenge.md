## Adversarial review — 2026-07-26 memory-poisoning defenses design

Target: `2026-07-26-memory-poisoning-defenses-design.md`. Produced by the Jugalbandi
Challenger role ([jugalbandi-protocol](https://github.com/mavaali/jugalbandi-protocol)),
run in an isolated context whose only input was the design doc — no task framing, no
hint about which parts were thought weak. The role has no approval verb, so the absence
of praise here carries no information.

13 challenges: 4 `[STRUCTURAL]`, 4 `[ASSUMPTION]`, 5 `[MISSING]`. **Surfaced, not
resolved** — no disposition has been taken on any of them, and several may be
answerable by a sentence the design already intended. Line references verified against
the tree at time of review.

---

### [STRUCTURAL] One `tier` scalar is now carrying two orthogonal axes, and the doc that most needs both cannot have both

Decision 1 says the plain part out loud and then walks past it: the existing
vocabulary answers "who may rewrite this body," `untrusted` answers "how far
should a reader trust it." Those are independent properties, and `tier` is a
single enum value (`src/frontmatter/types.ts:28`, validated as
`optionalEnum<Tier>` at `src/frontmatter/schema.ts:240`). A document has one.

The collision is not hypothetical, it is the central case. `source` is defined
in the code as "raw ingested material, body is immutable to every writer"
(`src/frontmatter/types.ts:22-24`). Raw ingested material is *exactly* the
population Decision 1 wants quarantined — a fetched page, a PR body, a foreign
KB dump. Under this spec that doc must choose: keep `source` and be
unquarantined, or take `untrusted` and lose body immutability. The spec even
makes the wrong choice mandatory in one direction: import paths "default every
created doc to `untrusted`", so `daftari import` and OKF import now produce
foreign content that is *more* rewritable than before, because the tier slot
that used to be available for `source` is spent on the trust label.

Worse, the escape is a trap. To give an imported doc write protection, an
operator runs `vault_set_tier(source)` — which under Decision 3 is a promotion
out of quarantine requiring `ratify`, and which silently deletes the trust
signal. "Protect this from edits" and "I vouch for its content" become the same
irreversible act.

What breaks: quarantine and write-protection are mutually exclusive on every
doc. Cost: either a second frontmatter field (which the spec did not budget,
and which CLAUDE.md's "frontmatter is the metadata layer" rule permits but the
tier-change trap, the lint checks, and Decision 3's gate would all have to be
rewritten around) or a permanently mis-modeled corpus. This is the decision to
make before any of the other four, and the spec makes it by omission.

---

### [STRUCTURAL] Decision 2 describes content blocks the tool layer cannot emit, and the same response ships the body unfenced anyway

The spec writes "vault_read returns three [blocks]" as though handlers control
the MCP result shape. They do not. `ToolDefinition`
(`src/tools/read.ts:54-80`) lets a handler return a typed value plus an
optional `summarize?: (value: unknown) => string` — one string. The blocks are
assembled in the bridge at `src/server.ts:216-231`, which builds:

```
content: [ { type: "text", text: summary }, ...resource_links ]
structuredContent: result.value
```

Two consequences the spec never addresses.

First, implementing Decision 2 means changing `ToolDefinition` and the
three-channel bridge that a *prior* spec settled ("Three channels (spec
2026-07-26, Decision 3)" — `src/server.ts:203-210`). That is a cross-spec
change, on the same date, to the same file, and this document does not
acknowledge it exists. Every tool's `summarize` contract, the outputSchema
requirement, and the resource_link emission all sit on that interface.

Second, and fatally for the stated threat model: `structuredContent` is the
full `VaultReadResult`, and `VaultReadResult.content` is the document body as a
plain string (`src/tools/read.ts:101-104`). So the poisoned bytes arrive twice
in one response — once inside the nonce fence, once as a bare JSON string field
with no fence at all. The spec's own argument against out-of-band flags ("a
harness that pastes the returned text straight into context") condemns this: a
harness that renders `structuredContent` — and per MCP guidance many also
serialize it into a text block for compatibility — delivers the unenveloped
payload. Decision 2 as specified does not remove the attack, it adds a second
copy with a warning label on the first.

---

### [STRUCTURAL] `daftari://doc/` is an unenveloped full-fidelity read channel, and the design deliberately steers agents into it

`readDocResource` returns `{ uri, mimeType, text: file.value }` — the file's
raw bytes, frontmatter included, with the comment "Verbatim: frontmatter
included, bytes as they sit on disk" (`src/resources.ts:176-180`). No tier, no
fence, no nonce, no trust block.

This is not a forgotten side door. `src/server.ts:222-230` emits a
`resource_link` for every doc a tool result references, and the rationale in
the code is explicit: "so the agent reads the two it needs at full fidelity
instead of receiving twenty bodies it will truncate in context anyway." The
architecture's intended path for actually consuming a document body is the
resource surface. Decision 2 fences the summary channel and leaves the
full-fidelity channel bare.

The "Out of scope" list names themes, edges, and blast as surfaces that "return
paths and structure, not bodies." The resource surface returns bodies. It is
not listed, not scoped out, and not defended. Under this spec an agent that
searches, sees a quarantine fence, and then follows the resource_link to read
the doc properly ends up with an unlabeled payload — the defense degrades
exactly at the moment of highest-fidelity ingestion.

---

### [ASSUMPTION] Both new lint checks key on `updated_by`, which this same spec calls a free-text claim

Decision 1's `unquarantinedExternal` flags docs with `updated_by: agent:*`.
Decision 4's `instructionShaped` flags docs with `updated_by: agent:*`.
Decision 5 then explains, correctly, that "`updated_by` is the caller's
free-text *claim*; `principal` is ground truth" (`src/curation/provenance.ts:24-29`).

The code confirms the claim is unchecked: `src/tools/write.ts:948-952` stamps
`updated_by: agent.value` unconditionally, where `agent` is a required string
argument supplied by the caller. Nothing validates that an `agent:` prefix is
truthful or that a `human:` prefix is earned.

So a poisoning writer passes `agent: "human:mihir"` and both detectors go
permanently silent on its output. The spec's honesty backstop and its injection
heuristic are both opt-out, by a one-word change, for the only actor that
matters. This is a contradiction internal to the document: Decision 5 diagnoses
the exact weakness that Decisions 1 and 4 are built on.

The fix is not free — scoping the checks to `principal` from the curation log
means the checks depend on git-ignored local state (see below), which is a
different problem, not an absence of one. Either way the spec has to pick, and
it has not noticed there is a choice.

---

### [STRUCTURAL] A pre-write transform hook lifts any tier, before and around the guard Decision 1 leans on

Decision 1's one mechanical guarantee is that the tier-change trap
(`src/tools/write.ts:863-881`) extends to `untrusted`, "so a write cannot lift
quarantine as a side effect."

The trap runs at line 863. Twenty lines later the pre-write transform hooks run
and their output is merged straight into the frontmatter:
`Object.assign(rawFrontmatter, transformResult.merged)` (`src/tools/write.ts:907`).
The code's own comment says these hooks exist to "derive or override built-in
frontmatter fields the validator would otherwise reject." `tier` is a built-in
frontmatter field. A three-line hook module that returns `{ tier: "compiled" }`
lifts quarantine on every write, with no reason, no ratify grant, and a normal
provenance entry.

Hook modules are vault-supplied (`src/hooks/`, declared in `.daftari/config.yaml`),
which means they live in the same shared repository that the threat model
assumes a compromised writer can write to. Decision 3 spends four paragraphs
arguing that promotion must be a ratify-class verdict; the enforcement it
depends on is bypassed by a file in the vault.

This hole already exists for `source` and `manual` — which makes it worse, not
better: the spec asserts an existing guard is sound and builds a security
boundary on it without checking. Either hooks must be denied the `tier` key, or
the trap must be re-run after the hook merge, and neither appears in the design.

---

### [MISSING] Quarantine is bypassable with a text editor, and the spec never states its trust boundary

CLAUDE.md: "Git is the version control layer. Every write operation
auto-commits." The vault is a git working copy of markdown files. `daftari
backfill` exists specifically to adopt an operator's existing Obsidian vault,
i.e. direct file editing is a first-class supported workflow. The index is
declared ephemeral and rebuildable from the files at any time.

So: open the quarantined file, delete the `tier: untrusted` line, save, commit,
reindex. Quarantine lifted. No `ratify` grant, no reason string, no provenance
entry, no `tierDemotions` lint finding (that check reads frontmatter diffs from
the curation log, which never saw the edit), and no trace at all except a git
commit that looks like every other operator edit.

Everyone who can poison a shared vault via a compromised writer can also do
this, because both require the same capability: write access to the repo. The
spec's threat model is drawn from arXiv 2606.04329's "single compromised writer
contaminates every reader" — that writer has git push.

The design may well be fine with this — "defense in depth," "the tool path is
the boundary" — but the document never says so. It presents Decision 3's
asymmetry ("only a ratify-holder may promote out") as a property of the system
rather than a property of one code path. An unstated trust boundary is a
boundary that gets assumed wider than it is, by exactly the operator deciding
whether to trust a doc marked clean.

---

### [ASSUMPTION] "Straight from the indexed frontmatter; no new joins" is false — it is a schema bump that drops every embedding

Decision 5 bills the `HybridHit` additions as free: "Straight from the indexed
frontmatter; no new joins."

The `documents` table (`src/storage/index-db.ts:100-114`) has columns path,
title, collection, domain, status, confidence, updated, tags, content, tokens,
ttl_days, created, superseded_by. There is no `tier` column and no `updated_by`
column. Neither value is indexed at all.

Adding them means bumping `SCHEMA_VERSION` (currently `"9"`,
`src/storage/index-db.ts:57`). The code documents what a bump costs
(`src/storage/index-db.ts:394-422`): a clean rebuild that executes
`DROP TABLE ... documents_fts, embeddings_vec, documents, chunks_fts, chunks,
embeddings, derives_from_edges` and clears the vault manifest. **The
`embeddings` table is dropped.** Every chunk in every vault is re-embedded on
first run after upgrade.

For a local model that is a long stall on the first `daftari serve` start after
an update. For a hosted embedding provider it is a bill, silently incurred, on
upgrade day. The spec's own Decision 4 is careful to say "No LLM" and to price
the injection check honestly; Decision 5 hides a full re-embed behind "no new
joins." At minimum the design owes a sentence on whether these two columns are
worth a schema bump, or whether the tool handler should read tier/updated_by
from the returned docs' frontmatter (which search already does for other
enrichment — `currentSource`, `contested`, `pendingBrokenUpstream` are all
annotated by "the tool handler, not the ranker", `src/search/hybrid.ts:53-58`).

---

### [MISSING] `principal` — the "ground truth" half of Decision 5 — is absent precisely in the multi-writer scenario the spec is defending against

Decision 5's value proposition is the `agent` vs `principal` split: the claim
versus the authenticated fact. The spec notes one absence case ("The log is
local audit state (git-ignored), so `principal` is absent on a fresh clone").
It does not follow the consequence.

Two facts compound. `principal` is only recorded "when an AccessContext is
present" and is "Absent on servers run without --role"
(`src/curation/provenance.ts:26-29`) — that is every default stdio session.
And `.daftari/curation-log.jsonl` is git-ignored local state; the 2026-07-20
storage-backend decision recorded in CLAUDE.md keeps index and local state off
the sync path entirely, and backends "never understand markdown, git, or locks."

So on a vault shared across machines or synced through a backend — the shared
memory this entire spec is about — writes made anywhere else carry no
`principal` in *your* log. You get `absent` = unknown for every foreign write.
`principal` is populated when the writer was you, on this machine, with a role
configured; it is empty in the compromised-peer case. The ground truth arrives
only where it is not needed.

That is not a reason to drop Decision 5, but the spec presents `principal` as
the trustworthy signal that redeems `updated_by`, and it should say plainly
that on today's architecture the redemption is unavailable in the threat
scenario. Otherwise a reader concludes the trust block distinguishes real
identities from claimed ones, and it mostly returns `undefined`.

---

### [MISSING] The Decision 2 kill condition cannot be run on the harness it names

The kill condition is "a canary eval (a `daftari eval` fixture embedding a
benign directive in an untrusted doc) shows agents comply with embedded
instructions at the same rate with and without the envelope."

`daftari eval` cannot measure this. Its answerer loop drives an
**in-process** tool surface — `src/eval/tool-surface.ts:1-11`: "A thin adapter
over the existing src/tools/* handlers — no MCP serialization, no transport, no
stdio. The answerer calls these directly." The envelope from Decision 2 is
built in `src/server.ts`, in the transport bridge the eval harness explicitly
bypasses. A canary run today would measure the un-enveloped condition in both
arms and "prove" the null result the kill condition treats as fatal.

Separately, eval measures answer quality against generated questions in three
tiers — retrieval, cross_reference, contradiction (`src/eval/types.ts:9`) —
scored by an LLM judge. It has no notion of instruction-compliance rate, no
fixture concept, and its answerer is deliberately read-only with write tools
excluded, so "did the agent obey the embedded directive and call vault_write"
is unobservable by construction.

Decision 2 is the load-bearing decision (the spec itself says 1, 3, and 5 stand
without it and 2 does not). Its falsifiability rests on instrumentation that
does not exist, in a module whose design actively precludes it, and the spec
budgets nothing for building it.

---

### [MISSING] The rubber-stamp kill condition watches a surface that structurally excludes the promotions it wants to catch

Kill condition two: "the reviewThroughput and witness surfaces show
untrusted→trusted promotions approved near-100% with near-zero review latency."

`reviewThroughputSummary(actions: StagedAction[], now)`
(`src/curation/review-throughput.ts:69`) computes entirely over staged actions:
proposals, ratified, rejected, expired, pending, and decision latency from
`proposedAt`/`ratifiedAt`. It sees nothing else.

Decision 3 routes only *propose-only* roles through staging. A role that holds
`ratify` calls `vault_set_tier` directly (`src/tools/write.ts:1351+`), which
performs a frontmatter write and a provenance-log entry and never creates a
staged action. So the promotions performed by the population most able to
rubber-stamp — the ratify holders, acting unilaterally, with no proposal and no
latency to measure — are invisible to the instrument named in the kill
condition. `reviewThroughput` would report on the constrained minority and
stay silent on the unconstrained majority, which reads as a healthy signal.

Either the kill condition needs a new measurement over `curation-log.jsonl`
filtered to `tool: "vault_set_tier"` with an untrusted→other frontmatter diff
(feasible — `frontmatter_diff` is recorded — but unbuilt and unmentioned), or
Decision 3 must route all promotions through staging, which contradicts its own
"vault_ratify dispatches it through vault_set_tier's own gate" design.

---

### [ASSUMPTION] OKF import defaulting to `untrusted` reverses a decision already argued in the code, and the round-trip case is undefined

Decision 1 states OKF import defaults every created doc to `untrusted`. Two
problems in `src/okf/`.

First, `okfToDaftari` begins with a sidecar short-circuit: if the bundle
carries a `daftari` sidecar key, "that verbatim frontmatter is used directly
for an exact round-trip" (`src/okf/map.ts:288-291`, `hasDaftariSidecar` branch
returning the sidecar unchanged). The spec does not say which wins. If the
`untrusted` default applies, `daftari okf export` → `okf import` no longer
round-trips and a `source`-tier doc comes home quarantined. If the sidecar
wins, then the quarantine bypass for a hostile bundle is one YAML key — an
attacker authoring an OKF bundle simply includes a `daftari:` sidecar with
`tier: compiled` and skips quarantine entirely. Both readings are bad and the
spec picks neither.

Second, the codebase already litigated this and decided the other way, in
detail: "An `Attested Computation` is NOT auto-elevated to a write-protected
tier: `tier: source` is an enforcement mechanism whose only sanctioned grant
path is vault_set_tier (reason required, provenance-logged), and a foreign
bundle's self-declared `type` must not buy enforcement without that gate"
(`src/okf/map.ts:314-320`). The principle recorded there is that import never
sets `tier`, full stop, because tier is enforcement and enforcement is granted
only through the audited path. Decision 1 makes import set `tier` on every
document. That may be defensible — setting `untrusted` restricts rather than
grants — but the spec cites the neighboring line (`src/okf/import.ts:102`) as
if it were supportive and never engages the rule it is overturning.

---

### [ASSUMPTION] `ratify` is a global boolean; quarantine is per-document. One grant vouches for everything.

Decision 3 reuses `ratify` on the argument that "roles that may approve staged
actions may also parole documents, which is the same job."

`RoleConfig` (`src/utils/config.ts:29-40`) declares `read: string[]`,
`write: string[]` — per-collection — and `promote: boolean`, `ratify: boolean`
— global. So a role with `ratify: true` can lift quarantine on any document in
any collection it can write. There is no way to express "Ana vouches for
security/ imports, Ben vouches for finance/."

For staged actions that coarseness is tolerable: a proposal names a target the
ratifier can already see, and rejection is cheap. For quarantine it is the
whole question. "Who is qualified to vouch is an organizational decision" —
the spec's own words — and the config surface the spec proudly reuses ("zero
new config surface") cannot express the organizational decision at the
granularity the problem has. An org that wants domain-specific vouching has to
mint one role per collection and re-grant every writer, or accept that its
single reviewer role vouches for foreign content in domains nobody on it
understands.

The spec presents zero-new-config as a pure win. It is a scope reduction, and
the scope it drops is the one Decision 3 says matters.

---

### [MISSING] Growing `TIERS` is a forward-incompatible frontmatter change with no migration or rollback note

`TIERS` is validated as a closed enum at `src/frontmatter/schema.ts:240`
(`optionalEnum<Tier>("tier", TIERS)`). Adding a fourth member means documents
written by a new daftari carry a `tier` value that an older daftari reports as
a validation issue.

Nothing in the spec addresses mixed-version operation, which this codebase
plainly supports: a `daftari serve` deployment and colleagues' local stdio
instances against the same git-synced vault, on whatever version each installed.
Under this design an older client reading a quarantined doc gets a frontmatter
validation issue rather than a conservative default — quarantine degrades to
*noise*, not to caution, on precisely the clients that lack the read-path
envelope.

There is also no rollback story. Revert the release and the `tier: untrusted`
values stay in the markdown, in git, on every imported document, now invalid.
The spec's "Out of scope" list finds room for signed commits and tool-list
rug-pulls but not for the version skew its first decision creates.
