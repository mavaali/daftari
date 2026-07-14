# Dedup Is Not Epistemics

*Draft for waglesworld.com. All numbers are machine-generated and committed:
[demo + evidence](https://github.com/mavaali/daftari/tree/main/integrations/langgraph-store-demo).*

Agent memory vendors sell consolidation as understanding. It isn't. I planted
20 facts in a LangMem store and ran their consolidation with their
consolidation directives verbatim. It merged 4 of 5 duplicates and caught 0
of 14 contradictions. Given the chance to see the conflicts, it deleted the
evidence instead. That's the whole post. Receipts below.

Scope, up front: this tests langmem 0.0.30, which is pre-1.0 and says so.
The langgraph stack around it is post-1.0 and was rock solid. The critique
is about what consolidation IS, not about ship quality. And daftari, the
other tool in this post, is my project; discount accordingly, then run the
three commands and check.

## The tell: pricing memory as inventory

Look at how agent memory gets priced. ContextVault's tiers are gated by
memory count: 50 memories on the trial, 500 at $9.99 a month, 2,500 at
$49.99, unlimited on Enterprise. You upgrade when you accumulate. Their
marketing says nothing about deduplication, reconciliation, or consistency.
Not a criticism of one vendor; it's the category's business model showing.
A warehouse charges for pallets. It doesn't audit what's on them, and it
has no reason to tell you two pallets contradict each other.

Inventory pricing is honest, at least. The problem starts when a vendor
prices like a warehouse and markets like an auditor.

## The claim under test

LangMem's default prompt instructs its memory manager to "remove incorrect
or redundant memories while maintaining internal consistency." That's an
epistemics claim. Consistency maintenance, in writing, in the default prompt.

So I tested it as written. One honest disclosure: their default prompt
extracts user-profile memories, so I used their documented instructions
parameter to point extraction at org facts instead. The consolidation
directives, the part under test, stayed verbatim. Every prompt is in the
repo.

Four simulated agent sessions for a fictional
company: pricing, ops, support, docs. 20 planted facts among 30 benign ones.
Five near-duplicate pairs as the control group. Three pairwise
contradictions. Two temporal traps. And one four-way contradiction where no
single pair reveals the full inconsistency:

- Pricing sells 500 requests/sec, guaranteed on order forms.
- Ops hard-caps the gateway at 350.
- Support grants 800 rps bursts without asking ops.
- Public docs say every plan throttles at 200.

Embedding distance between these claims: 0.48 to 0.66 cosine. The
near-duplicate pairs sit at 0.81 to 0.93. Vector similarity will never pair
the contradictions. You need structure, not similarity.

## What their consolidation did

The control worked: 4 of 5 near-dup pairs merged. Their dedup is real.

The contradictions: 0 of 14 caught, in both full runs, across three
configurations (their documented per-agent namespaces, a shared namespace,
and a global single-context pass). Two failure modes, and you always get
exactly one of them:

1. **Namespace-scoped (their documented pattern): blind.** Consolidation
   can't see across agent namespaces. All 14 contradictions survive,
   unflagged, forever.
2. **Shared namespace (the charitable setup): destructive.** It saw the
   conflicts and resolved them by deleting one side. The 500 rps revenue
   guarantee: gone. The us-east-1 deploy region: gone. Recency won every
   arbitration. No flag, no tombstone, no audit trail. It also rewrote two
   conflicting capacity claims into one harmonized policy that nobody in
   any session ever stated.

Bonus finding: extraction invented a fact. It promoted the fictional
company's CTO to CTO of their biggest customer, and consolidation kept the
fabrication. Your memory layer generates confident wrong facts, then defends
them against correction.

## The counterexample that matters

Daftari read the same Postgres store through a read-only role and compiled
each memory into a claim note with provenance back to the store row. Then an
agent pass judged related notes for conflict. Same model as LangMem's run.
Same one-pair-at-a-time retrieval scope. No global view, ever.

Result: 3 of 3 pairwise contradictions logged, both temporal traps flagged
without being auto-resolved by recency, and at most one borderline flag on
the 30 benign facts across two runs (a filler fact that turned out to
genuinely tension with a planted one; it's in the committed report, not
swept under the rug).

And the four-way capacity conflict surfaced as one connected component
spanning all four sessions, assembled from three pairwise judgments that
never saw each other. The graph knows something no single LLM call knew.

That's the argument in one sentence: the intelligence isn't in the judge,
it's in the ledger. LangMem had the same judge and destroyed the evidence.
An append-only tension log turned three narrow observations into an
organizational diagnosis: your pricing, ops, support, and docs teams are
selling four different products.

## The retrofit play

Nobody migrates memory stores. You don't have to. LangMem's store is a
Postgres table; reading it is the whole integration. Daftari imported the
memories without LangMem's runtime, without write access, without touching
the producing system. One command, 49 claim notes, every note traceable to
its source row. Any memory store with a readable substrate gets the same
treatment: compile the claims, keep the provenance, grow the tension graph
on top.

Dedup makes stores smaller. Epistemics makes them honest. Different
products. The second one retrofits onto the first.

My take: if your memory vendor's consolidation "maintains internal
consistency," ask them one question. When two memories conflict, where does
the loser go? There are only three answers. It survives untouched (you have
a search index, not memory). It disappears (you have evidence destruction).
Or it's recorded as a conflict (you have epistemics). Price accordingly.

---

*Reproduce it: [three commands from a clean clone](https://github.com/mavaali/daftari/blob/main/integrations/langgraph-store-demo/DEMO.md).
Full planted-vs-detected tables: [RESULTS.md](https://github.com/mavaali/daftari/blob/main/integrations/langgraph-store-demo/RESULTS.md).
Think I misconfigured LangMem? The fixtures are committed and the repo takes
PRs. Show a configuration that catches the plants and I'll publish the
correction with your name on it.*
