# Daftari: Positioning, Competitive Stock-Take, and Differentiation Ideas

*2026-07. A strategic self-audit: what the value prop actually is, who else
occupies the territory, whether Daftari has a right to exist, and a ranked set
of deliberately wacky ideas for widening the gap. Labels follow the house
convention: [DATA] read from this repo, [TRAINING] from model training
knowledge (verify before betting on it), [HYPOTHESIS] inference with a kill
condition.*

---

## 1. What Daftari is, in one breath

[DATA] A local MCP server over a directory of markdown + YAML frontmatter:
hybrid search, config-driven RBAC, file locks, git auto-commit, and a curation
layer — draft→canonical→deprecated lifecycle, TTL staleness, provenance,
first-class *tensions*, `derives_from` edges with earned (and decaying)
strength, staged actions ratified by humans, an advisory linter, a coherence
audit CLI, and an eval harness that scores how well an LLM can answer
multi-hop questions from the vault.

[DATA] The thesis (manifesto): **rent the brain, own the memory** — and the
law that holds it together: *a tension may never masquerade as a
supersession.* Resolve only by discovery, never by invention.

## 2. The value prop, decomposed

Three claims stack. Each is necessary; only the third is rare.

1. **Ownership & portability.** Plain markdown, git, MIT, local-first, any
   MCP client. [TRAINING] This is real but not unique — every markdown tool
   and several memory projects claim it. It is the *table stakes* claim.

2. **Multi-agent substrate.** RBAC, locks, attribution, agent principals,
   auto-commit. [TRAINING] Rare-ish. Most memory layers assume one agent and
   one trust level. But it is infrastructure, not a reason to switch.

3. **Epistemic discipline — non-collapsing memory.** Current (supersession
   edges), grounded (provenance, the vault never mints a value), contested
   (tensions held open). Plus the machinery that makes discipline cheap:
   blast radius of a contested doc, aging tiers, earned edge strength with
   half-life decay, shadow-mode calibration before any auto-write.
   [HYPOTHESIS] This is the moat. Nobody else treats *disagreement* and
   *staleness* as first-class objects with tooling. Kill condition: the
   manifesto's own — if held tensions never change a decision an agent would
   have made anyway, the moat is a philosophy seminar. The corpus-B
   contradiction benchmarks ([DATA] specs of 2026-06-27..29) exist to test
   exactly this; their result governs everything below.

One sentence version: **Mem0 remembers, Zep relates, Daftari testifies.** The
vault is the only memory layer built to answer not just "what do we know?"
but "how do we know it, is it still true, and who disagrees?"

## 3. Competitive map

[TRAINING] throughout this section — the landscape as of the model's
knowledge; re-verify names and features before quoting externally.

| Territory | Occupants | Their pitch | Why Daftari isn't that |
|---|---|---|---|
| Provider-native memory | ChatGPT memory, Claude projects/memory, Gemini, Copilot | Zero-setup, invisible | Non-portable by design; memory as moat for the *vendor*. Daftari is the structural opposite. |
| Memory-as-API | Mem0, Zep/Graphiti, Letta (MemGPT), LangMem, Cognee | One API call, auto-extracted facts, temporal graphs | They optimize *recall*; they collapse conflicts silently or by recency. Opaque stores; you can't `git log` your memory. |
| RAG / vector stacks | LlamaIndex, Pinecone/Chroma/Qdrant pipelines | Scale retrieval over corpora | Read-only knowledge; nobody writes back, nothing compounds, contradictions invisible. |
| Human PKM | Obsidian (+AI plugins), Logseq, Notion AI | Second brain for a human | Human supplies the judgment for free. Daftari's whole bar is that the consumer *can't*. In-place Obsidian adoption ([DATA] `daftari import obsidian`) makes this a beachhead, not a rival. |
| Flat agent memory files | AGENTS.md / CLAUDE.md convention, the reference "memory" MCP server | Dead simple | One file doesn't scale; JSON graph has no lifecycle, no provenance, no ACL. |
| Docs QA / lint | Vale-style linters, link checkers | CI hygiene | `daftari audit` overlaps here — a wedge/funnel, not the identity. |

**Where the real pressure comes from.** [HYPOTHESIS] Not from Mem0 et al.
adding "tension support" — collapsing is structural for them (their metric is
answer speed, not answer honesty). The mortal threats are:

- **Provider memory gets good enough.** If Claude/ChatGPT memory becomes
  agent-writable, exportable-enough, and reliable-enough, "own your memory"
  shrinks to a niche of the principled. Kill condition to watch: a provider
  ships a *portable export with provenance intact*.
- **Long context + cheap re-derivation.** If 100M-token contexts and fast
  models make it cheaper to re-read the primary sources every time than to
  maintain compiled memory, "compilation over retrieval" inverts. Kill
  condition: eval shows raw-source-stuffing beats the curated vault on the
  cortex metric at comparable cost.
- **The discipline tax.** 14 tools + frontmatter + ratification is a lot of
  ceremony. Agents (and users) default to the lazy path. If the vault only
  stays healthy when a diligent human tends it, it has quietly become a
  second brain again. This one is self-inflicted and fixable — see ideas 1
  and 6.

## 4. Right to exist — verdict

[HYPOTHESIS] Yes, and it is narrower and stronger than "agent memory": Daftari
is the only occupant of **memory an agent can be held accountable against**.
Ownership alone won't carry it (commodity), multi-agent substrate alone won't
(infrastructure), but the compound — *auditable, non-collapsing, portable
memory with a lifecycle* — has no second occupant. The manifesto's honest
framing is also the strategic one: the artifact is an existence proof; the
category ("current / grounded / contested, none flattened") is the thing meant
to travel. The right to exist is therefore earned by (a) surviving the
corpus-B kill test and (b) making the discipline cheap enough that the vault
stays healthy without a saint tending it.

## 5. Wacky ideas, ranked by leverage-per-wackiness

Each idea names why *only* Daftari can do it (else it's a feature request),
and a kill condition. Roughly ordered: do-soon wedges first, moonshots last.

### 1. The Epistemic Receipt — answers ship with a nutrition label

Every `vault_search`/read response already carries status, confidence,
provenance, decay banners, `currentSource`, tension flags ([DATA]). Compile
them into one signed, machine-readable **receipt** the agent must attach to
its answer: *"3 canonical sources (newest 2026-06-30), 1 open tension in the
blast radius, confidence: medium, chain verified."* Downstream tools — or a
human skimming a Slack reply — see at a glance whether an answer stands on
rock or sand. This weaponizes metadata nobody else has into a user-visible
artifact, and it makes the moat *demoable in one screenshot*. Kill condition:
receipts get ignored — if no consumer changes behavior on a red receipt, it's
decoration.

### 2. Belief archaeology — `daftari asof` and the counterfactual replay

Git + rebuildable index means the vault can answer **"what did we believe on
March 3?"** — check out a past commit, rebuild the ephemeral index, query.
Combine with the existing blast-radius machinery ([DATA] `vault_tension_blast`)
for the killer post-mortem tool: *"this fact turned out wrong — show every
doc, decision, and downstream write that inherited it, and when."* No
API-backed memory store can do this; it falls out of the architecture for
free. This is the feature you show a compliance officer or an incident
review. Kill condition: rebuild cost on large vaults makes time-travel
queries too slow to be casual — then it needs snapshot caching before it
markets itself.

### 3. Tension Court — common-law memory

Tensions currently wait in a log. Give them a *docket*: a weekly compiled
brief per tension (both sides' sources, blast radius, age, what a ruling
would unblock), a one-keystroke human ruling, and — the wacky part — the
ruling is recorded as **precedent** that future, similar tensions cite.
Agents searching the vault retrieve not just facts but *how this house
resolves this kind of dispute*. Memory grows case law. Nobody else can build
this because nobody else has tensions as objects. It also directly attacks
the discipline tax: curation becomes a 5-minute Monday ritual instead of a
virtue. Kill condition: rulings turn out to be one-off (no precedent ever
gets cited) — then keep the docket, drop the jurisprudence.

### 4. The vault as witness — agent track records

Every write carries a principal ([DATA] §11.6). Aggregate: which agent's
claims get contested most, whose edges survive re-derivation, whose
confidence calibrates. Publish per-principal **reliability curves** from the
ledger. In a multi-agent org this is the missing HR file: route high-stakes
writes to agents with earned trust, sandbox the ones that keep getting
contested — using *evidence the substrate already records*. Composes with the
existing trust-budget gate ([DATA] consolidate two-gate envelope). Kill
condition: in practice one agent does 95% of writes and the curves are flat.

### 5. Memory divorce kit — the model-swap stunt

Package the thesis as an event: one command imports provider memory exports
into a vault; then the live demo — an agent halfway through a multi-day task
**switches models mid-task** (Claude→GPT→local) with zero continuity loss,
scored by the existing eval harness ([DATA] `daftari eval`, OpenRouter
transport already landed). "Same memory, three brains" is the manifesto as
theater, and the eval score makes it a benchmark rather than a vibe. Kill
condition: continuity scores are actually mediocre across model families —
in which case this experiment was the cheapest possible way to find out.

### 6. Circadian memory — the vault that sleeps

Lean all the way into the cortex metaphor the specs already use ([DATA]
consolidation loop, decay half-lives, shadow mode). A nightly *sleep cycle*:
re-derive due edges, decay the untested, expire TTLs loudly, and — new — for
each load-bearing doc that decayed past threshold, **wake an agent to
re-verify it against its sources** and stage the diff for morning
ratification. The vault stops being a place agents write to and becomes a
thing that *metabolizes*. Marketing writes itself ("your agent sleeps on
it"), and it converts the discipline tax into a batch job. Kill condition:
unattended re-verification produces staged slop humans rubber-stamp —
watch the ratification-rejection rate; if it collapses toward zero approval
*or* zero scrutiny, the loop is theater.

### 7. Inter-daftar diplomacy — federated tensions

Historically, ledger-keepers reconciled books *across* trading houses. Two
vaults (already routable — [DATA] `packages/router`) exchange claims through
a treaty protocol: my `pricing/helios.md` disagrees with your
`pricing/helios.md` → a **cross-vault tension**, held open in both, resolved
only when either side produces a superseding source. Teams, vendors, even
competitors can dispute facts without merging repos or trusting each other's
conclusions — only each other's *provenance*. This is the multi-org story no
centralized memory API can tell, because it requires memory both parties own.
Kill condition: no two real vaults ever overlap enough to generate a
cross-vault tension worth holding.

### 8. Vault starters — sourdough for knowledge

Shareable, versioned seed vaults with live frontmatter and open
`questions_raised`: a competitive-intel starter, a compliance starter, an
incident-postmortem starter. Not templates — *cultures*: they come with
tensions pre-logged and coverage maps of what's unknown, so an agent pointed
at one starts compiling immediately. A community exchange of starters is
distribution the incumbents structurally can't copy (their memory isn't a
file you can fork). Kill condition: starters rot — if nobody re-ferments
(updates) a published starter within a quarter, it's a template graveyard.

### 9. The wager layer — confidence with skin in the game

`confidence: medium` is free to claim. Make it cost something: an agent
staking a claim allocates budget from the existing trust-budget mechanics
([DATA] §11.5); a contested-and-lost claim burns the stake, a survived
re-derivation pays it back with strength. Confidence fields become priced,
not vibes — a prediction market where the settlement layer is the
supersession edge. Genuinely wacky, deeply on-thesis (trust is a ledger —
literally). Kill condition: pricing turns agents conservative — if
stake-fear measurably drops write volume of *true* claims (eval recall
falls), the market is taxing the wrong behavior.

### 10. The Daftari speaks — the ledger-keeper as persona

The linter is advisory and easy to ignore. Give the advisory layer the voice
of the ledger-keeper: dry, margin-note nags with three centuries of attitude
("Entry 47 contradicts entry 12. I have recorded both, as is my duty. One of
you is wrong."). Zero new machinery — it's the lint report with a voice — but
it makes the epistemic discipline *legible and lovable*, and brand is a moat
clones can't fork. Kill condition: it reads as clippy-with-a-fez. Test on
real users before shipping the fez.

## 6. What to do first

[HYPOTHESIS] The compounding order: **1 → 2 → 3**. The Epistemic Receipt
makes the moat visible in every answer; belief archaeology makes it
irreplaceable after the first bad-fact incident; Tension Court makes the
discipline sustainable. Ideas 5 and 10 are cheap amplifiers of the story;
6, 4, 9 deepen the cortex once corpus-B validates that held tensions change
decisions; 7 and 8 are the ecosystem acts that only matter after there are
many vaults. And keep the manifesto's kill condition loaded at all times —
the fastest way to lose the right to exist is to stop trying to falsify it.
