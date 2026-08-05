# Context packs and progressive tool disclosure — design

2026-07-26. Status: **proposed — awaiting Mihir's review; implementation not
started.**
Builds on #103/#104 (tool-exposure tiers) and the 2026-07-14 edge-graph
existence-disclosure spec. Two coupled features, one problem: what a daftari
session costs the calling agent's context window — before the first document
is ever read, and again on every retrieval loop after that.

## Why

The registry in `src/server.ts` holds **33 tools**. Serialized the way
`ListTools` ships them (name, description, inputSchema, annotations), the
full surface measures **~50.6 KB ≈ 12,700 tokens** [DATA — measured from the
definition arrays in `src/tools/*.ts`; chars/4]. That is ~6% of a 200K
window spent before the agent has read a single document, and the two
biggest contributors are exactly the tools most sessions never call:
`write.ts`'s lifecycle battery (~2,600 tokens across eight tools) and
`curation.ts`'s tension suite (~2,300 across six). The six `CORE_TOOLS`
together cost ~2,400 tokens — the long tail is four-fifths of the bill.

Six percent sounds survivable until you notice the trend lines, ours and
everyone else's:

- The registry **doubled since #103 was written** — the default-tier comment
  in `src/utils/config.ts` says so in as many words. Every feature spec on
  this shelf adds tools; none remove any. 6% is the floor, not the ceiling.
- [TRAINING] The wider MCP ecosystem hit this wall in 2026. GitHub's
  official MCP server costs ~42,000 tokens of tool definitions — over a
  fifth of a 200K window — and is the standing example in every complaint
  thread. Perplexity dropped MCP internally citing a reported 72% context
  tax. Anthropic's code-execution-with-MCP write-up reports 150K→2K drops
  from the same medicine proposed here: a lightweight index (~80 tokens per
  entry) with full schemas loaded on demand. On-demand disclosure is the
  accepted mechanism now, not an exotic one.
- [TRAINING] The second cost is retrieval, not definitions. Practitioners
  report flat CLAUDE.md/MEMORY.md memory files hitting a ceiling: the agent
  either swallows the whole file every session or plays twenty questions
  with search. Anthropic's context-editing work reported 84% token savings
  on long tasks by curating what stays in the window. A vault that answers
  "what do I need for this task" with "run six searches and read eleven
  docs" is charging the agent's window for daftari's assembly work.

Tiers (#103) already attack the first cost, but bluntly: `tier: core` is a
static amputation. A core-tier session that suddenly needs
`vault_tension_blast` has no in-band path to it — the operator edits config
and restarts. That is why the default stayed `full` ("hiding tools is an
explicit operator choice, never an upgrade surprise") and why the lean tiers
go mostly unused. Decision 1 fixes the amputation; Decisions 2–4 attack the
retrieval cost.

## Decision 1 — `vault_tools`: the long tail moves behind an index

A new always-advertised tool joins `CORE_TOOLS`:

```
vault_tools
  description: List every tool this vault offers (one line each), or expand
    named tools to their full schemas. Call with no arguments to browse;
    call with names before first use of a non-core tool.
  inputSchema:
    { expand?: string[] }   // omitted → index mode
```

- **Index mode** returns `{ name, oneLine }` per registered tool — the
  one-liner is a new required field on `ToolDefinition`, capped at ~120
  chars, so the whole index for 33 tools costs ~1,000 tokens, not 12,700.
- **Expand mode** returns the full `ListTools`-shaped definition for the
  named tools. Unknown names are reported per-name, not an error for the
  batch (same posture as include/exclude's unknown-name warning in #104).

This works only because #103 already made it safe: **`CallTool` accepts
every registered name regardless of what `ListTools` advertised** — the
comment in `src/server.ts` is explicit that a cached tool name from a prior
session keeps working across a tier change. `vault_tools` is therefore pure
advertisement plumbing; no handler, no RBAC surface, no access context. It
reads the same static registry `resolveToolExposure` reads. Tool
*definitions* are not documents — there is nothing to existence-filter, and
every role sees the same index (an unreadable collection is enforced at
call time, as today).

### The default flips to `core`

`tools.tier` keeps its three values; no new config key. (`tools_surface`
was considered and rejected — two knobs steering one exposure is how
configs rot.) What changes is the default, in two steps:

1. **Next minor:** `vault_tools` ships, joins every tier including `core`,
   default stays `full`. Startup logs the measured cost of the advertised
   surface and notes the upcoming default change.
2. **Next major:** default becomes `core`. Advertised surface: the six
   `CORE_TOOLS` + `vault_tools` + `vault_context` (Decision 2) —
   **~3,300 tokens, a 74% cut**.

Arguing the flip, because #103 deliberately argued the opposite: the
upgrade-surprise objection was correct when a lean tier *removed
capability*. With `vault_tools` present it removes nothing — every tool
remains callable (the #103 invariant) and discoverable in-band (new).
What an upgrade changes is advertisement only, and a default whose honest
description is "spend 12,700 tokens per session advertising tools you will
not call" is not a posture worth preserving out of caution. Existing
clients are covered three ways: cached names keep working, `tier: full` is
one config line, and the major-version boundary plus startup notice make
the change loud. `standard` remains for operators who want the lifecycle
battery advertised without the curation tail.

## Decision 2 — `vault_context`: the task-shaped brief

The flagship. One call replaces the search→read→read→search loop for task
orientation:

```
vault_context
  description: Assemble a token-budgeted brief for a task: the most
    relevant current documents, with open tensions, staleness, and
    provenance flagged inline. Selects and annotates only — never
    synthesizes. Cites paths; drill in with vault_read.
  inputSchema:
    { task: string,            // free-text task description
      budget?: number }        // token budget for the brief; default 4000,
                               // clamped to [500, 20000]
```

Output is a single markdown brief plus a machine-readable manifest
(`included: [{path, score, reason}]`, `omitted_over_budget: n`,
`hidden_remainder: "none"|"some"|"many"`).

### Assembly pipeline — deterministic, ordered, RBAC-first

1. **Retrieve.** Run the existing hybrid ranker (`src/search/hybrid.ts`)
   on `task`, coverage pass included. Everything downstream consumes
   `HybridHit`s — the enrichment this tool needs is *already on that
   shape*: `decay`, `currentSource`, `contested`/`contestedCount`, the
   coarsened `pendingBrokenUpstream`/`hiddenPendingUpstream` buckets,
   `orphan`/`retiredStillLinked`. vault_context composes existing
   signals; it computes no new ones.
2. **RBAC-filter first, before any budgeting.** The caller's readable set
   is applied at the top of the pipeline, exactly as the tension surfaces
   do (#215): omission over redaction, no existence leak. A pack must
   never name, quote, or count docs in unreadable collections. Where
   filtering leaves a remainder attached to a readable neighborhood, it is
   reported coarsened — `none/some/many`, never an exact count — per the
   2026-07-14 spec's B′ rule; the small-cell argument applies to a brief's
   "3 related docs withheld" verbatim. `resolveCurrentSource` already
   degrades unreadable chain hops to a path-free `restricted` marker; the
   pack inherits that behavior untouched.
3. **Dedup on supersession chains.** A stale hit whose `currentSource`
   resolves is replaced by the chain head, annotated "supersedes N older
   docs matching this task"; the chain contributes one entry, once.
4. **Rank and cut to budget.** Fused hybrid score orders candidates;
   entries are appended greedily until the budget is spent. Each entry:
   title, path, snippet (chain-head content), then flag lines — open
   tensions inline (both claims + status, Decision 3), decay/staleness
   annotation, a one-line provenance note (author + last-write date from
   the index; `vault_provenance` remains the drill-down).
5. **Account in chars/4.** No tokenizer. A real tokenizer pins daftari to
   one model's vocabulary and adds a native or WASM dependency to every
   install, to gain precision the use case does not need — a brief cut at
   3,900 estimated tokens vs. 4,100 real is not a failure mode. chars/4 is
   deterministic, model-agnostic, and within ~±15% on English markdown;
   the assembler reserves 10% headroom (`budget * 0.9`) so overshoot stays
   inside the caller's stated budget. If a future embedding provider ships
   a tokenizer anyway, swapping the estimator is a one-function change.

### No LLM call — a hard line, not a tuning choice

Assembly is pure selection and templating over the index. In daftari, LLM
spend lives only behind operator-invoked cycles with declared budgets —
sleep's tension scan carries `maxLlmCalls` in config; eval and interview
are explicit CLI runs. No MCP tool handler spends today, and the read path
does not become the first: a retrieval tool that bills per call is a
retrieval tool agents learn not to call. Determinism is also what makes
Decision 4 measurable — same vault state, same task, same budget, same
pack, byte for byte. Reranking the candidate pool with the *caller's* model
is the caller's prerogative; the `RerankCandidate` pool (#3) already exists
for exactly that, on the caller's dime.

## Decision 3 — what the pack refuses to do

`vault_context` selects and annotates. It never synthesizes, merges, or
resolves — the store-and-point law, and the same line the curation engine
already holds (CLAUDE.md: vault_lint reports, it does not fix;
vault_tension_log records, it does not resolve).

- **A tension is two claims and a status.** When an included doc carries an
  open tension, the pack shows both claims, attribution, and
  `status: open` — never a blended sentence, never a winner. The moment a
  pack says "the deploy target is X (resolving a disagreement with Y)" it
  has ruled on a docket entry from a read-path tool, and the Tension Court
  is operator-only by written invariant.
- **Supersession points, it does not paraphrase.** `current-source.ts`'s
  header states the rule this tool inherits: daftari authors the RELATION,
  never the VALUE. The chain head's own content appears verbatim; the pack
  adds only the pointer and the hop count.
- **Annotations are index facts, not judgments.** Decay tier, staleness
  age, provenance line, contested count — all [DATA], reproducible from
  the index. The pack contains no sentence daftari composed *about* the
  truth of vault content.

The refusal is what keeps the tool on the read path at all. A synthesizing
pack would need the court's epistemics, an access story for blended content
spanning collections (whose collection is a merged claim in?), and an LLM.
A pointing pack needs none of those.

## Decision 4 — eval hook: answerable-from-pack rate

`src/eval/` already generates tiered question sets (retrieval,
cross_reference, contradiction) and runs a k-sample answerer against an
in-process tool surface (`src/eval/tool-surface.ts`), judged by LLM. Pack
quality plugs in as a second answerer condition, reusing the question set
and judge unchanged:

- **Pack condition:** for each question, build
  `vault_context({task: question, budget: B})` and hand the answerer the
  pack as its only context — no tools. Judge as usual.
- **Baseline condition:** today's tool-loop answerer, capped at N tool
  calls (strawman N=6, matching a search→read×4→search session).

Reported per tier: answerable-from-pack rate vs. baseline, and tokens
consumed per correct answer in each condition. The contradiction tier is
the honesty check — a pack that inlines both claims of a tension should
match the tool loop there, and a pack that quietly dropped tension flags
will crater on exactly that tier. `daftari eval --condition pack` gates the
default-flip in Decision 1: the flip ships only after pack-mode retrieval
holds within an agreed margin of the tool-loop baseline on the sample
vault.

## Out of scope

- **Code-mode / JS execution surface.** Anthropic's code-execution pattern
  (agents writing scripts against tool APIs) is the other road to the same
  savings; it brings a sandbox and an execution model daftari does not
  have. Revisit only if `vault_tools` proves insufficient.
- **Client-side caching protocol.** No ETags, no schema-version
  handshake, no client cache invalidation contract. `vault_tools` is cheap
  enough to call per session.
- **LLM-assisted pack assembly or reranking server-side** — Decision 2's
  hard line; the caller reranks if anyone does.
- **Per-role pack shaping** beyond RBAC filtering — no "role-tuned
  briefs"; RBAC stays config-driven roles over collections, nothing finer.
- **Tension Court content in packs** — court/docket code takes no access
  context; nothing operator-only enters a read-path brief (2026-07-14
  tripwire applies).

## Kill condition

[HYPOTHESIS] A deterministic, non-LLM pack assembled from existing hybrid
signals is good enough that agents stop hand-rolling the multi-search loop.
Kill condition, measured by Decision 4's harness: if pack-mode
answerable rate on the retrieval and cross_reference tiers falls more than
15 points below the N=6 tool-loop baseline after snippet/budget tuning —
i.e. selection-without-synthesis is the wrong altitude and only an LLM
summarization pass would close the gap — then `vault_context` is the wrong
tool for this vault, and the token problem gets re-attacked from the
code-mode side instead. Separately for Decision 1: if `tier: full` opt-outs
dominate after the default flip (operators voting that in-band discovery
does not work in practice), the default reverts and `vault_tools` stays as
an opt-in.
