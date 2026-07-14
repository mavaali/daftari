# Dedup Is Not Epistemics

*Draft stub for waglesworld.com. Numbers are real and committed; see the
[demo repo](https://github.com/.../integrations/langgraph-store-demo).
[STUB: ContextVault section needs Mihir's sourcing before publish.]*

Agent memory vendors sell consolidation as understanding. It isn't. I planted
20 facts in a LangMem store and ran their consolidation. It merged 4 of 5
duplicates and caught 0 of 14 contradictions. Given the chance to see the
conflicts, it deleted the evidence instead. That's the whole post. Details
below.

## The tell: pricing memory as inventory

[STUB: ContextVault pricing argument. The shape: they price per memory
stored. Inventory pricing. If your revenue grows with stored memories, you
have no incentive to reconcile them, only to accumulate them. A warehouse
charges for pallets; it doesn't audit what's on them.]

## The claim under test

LangMem's default prompt instructs its manager to "remove incorrect or
redundant memories while maintaining internal consistency." That's an
epistemics claim. Consistency maintenance, in writing, in the default prompt.

So I tested it as written. Four simulated agent sessions for a fictional
company: pricing, ops, support, docs. 20 planted facts. Five near-duplicate
pairs as the control group. Three pairwise contradictions. Two temporal traps.
One four-way contradiction where no single pair reveals the full inconsistency:

- Pricing sells 500 requests/sec, guaranteed on order forms.
- Ops hard-caps the gateway at 350.
- Support grants 800 rps bursts without asking ops.
- Public docs say every plan throttles at 200.

Embedding distance between these: 0.48 to 0.66. Vector similarity will never
pair them. You need structure, not similarity.

## What their consolidation did

The control worked: 4 of 5 near-dup pairs merged. Their dedup is real.

The contradictions: 0 of 14 caught, in any configuration, in any run. Two
failure modes, and you get exactly one of them:

1. **Namespace-scoped (their documented pattern): blind.** Consolidation can't
   see across agent namespaces. All 14 contradictions survive untouched.
2. **Shared namespace (the charitable setup): destructive.** It saw the
   conflicts and resolved them by deleting one side. The 500 rps revenue
   guarantee: gone. The us-east-1 deploy region: gone. Recency won every
   arbitration. No flag, no tombstone, no audit trail. It also rewrote two
   conflicting capacity claims into one harmonized policy that nobody in any
   session ever stated.

Bonus finding: extraction invented a fact. It promoted the CTO of the fictional
company to CTO of their biggest customer, and consolidation kept the
fabrication. Your memory layer is generating confident wrong facts and then
defending them against correction.

## The counterexample that matters

Daftari read the same Postgres store through a read-only role and compiled
each memory into a claim note with provenance back to the store row. Then an
agent pass judged related notes for conflict. Same model as LangMem's run.
Same one-pair-at-a-time retrieval scope. No global view, ever.

Result: 9 tensions logged, 0 false positives across ~30 filler facts. And the
four-way capacity conflict surfaced as one connected component spanning all
four sessions, assembled from three pairwise judgments that never saw each
other. The graph knows something no single LLM call knew.

That's the argument in one sentence: the intelligence isn't in the judge, it's
in the ledger. LangMem had the same judge and destroyed the evidence. A
tension log that only appends turned three narrow observations into an
organizational diagnosis: your pricing, ops, support, and docs teams are
selling four different products.

## The retrofit play

Nobody migrates memory stores. You don't have to. The store is a Postgres
table; reading it is store-agnosticism. Daftari imported LangMem's memories
without LangMem's runtime, without write access, without touching the
producing system. Any agent memory store with a readable substrate gets the
same treatment: compile the claims, keep the provenance, grow the tension
graph on top.

Dedup makes stores smaller. Epistemics makes them honest. They're different
products, and the second one retrofits onto the first.

My take: if your memory vendor's consolidation "maintains internal
consistency," ask them one question. When two memories conflict, where does
the loser go?

[STUB: closing CTA, repo link, RESULTS.md numbers table.]
