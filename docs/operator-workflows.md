# Operator workflows

Daftari's MCP tools handle the document loop. The CLI gives an operator the
cross-document views needed to decide what deserves attention: stale beliefs,
open tensions, missing evidence, historical blast radius, and the health of the
curation process itself.

All workflows in this guide preserve the core boundary: reports may rank,
summarize, and propose; they do not silently edit the documents under review.

## Choose a workflow

| Need | Command or tool | Result |
|---|---|---|
| See the vault's epistemic state in a browser | `daftari view` | Read-only dashboard, document pages, graph, and search |
| Build the nightly review queue | `daftari sleep` | Wake queue, Morning Report, and run-ledger entry |
| Decide open contradictions | `daftari court` | Ranked docket, case briefs, and recorded rulings |
| Ask the owner what the vault cannot infer | `daftari interview` | Verbatim source transcript tied to the prompting gaps |
| Reconstruct a past belief state | `daftari asof` | Historical state, drift, or counterfactual blast report |
| Inspect contributor track records | `vault_witness` | Advisory, deterministic principal-level ledger |
| Check documentation coherence | `daftari audit` | Broken references and direct/transitive staleness |
| Package evidence for another system | `vault_receipt` or `daftari attest` | Recomputable receipt or signed attestation bundle |

## View the vault

`daftari view` serves a read-only portal over the vault on loopback:

```bash
daftari view --vault ./my-vault
```

Open `http://127.0.0.1:8788`. The portal provides:

- A dashboard with freshness, open-tension, ratification-queue, and recent
  sleep-run summaries.
- Document pages with standing, confidence, decay, contested state, backlinks,
  and sanitized markdown.
- An interactive knowledge graph whose edges distinguish sources, links,
  derivation, and contestation.
- Search across the hybrid index.

The viewer binds to loopback and exposes only GET routes: an inspection
surface, never an alternate write path.

## Build the nightly review queue

`daftari sleep` is deterministic, LLM-free, and write-free with respect to
vault documents:

```bash
daftari sleep --vault ./my-vault \
  --output .daftari/morning-report.md
```

A scheduler can run it on a cadence:

```cron
0 3 * * * cd /path/to/vault && npx daftari sleep --output .daftari/morning-report.md
```

The pass:

1. Expires staged actions whose approval window ended.
2. Scores document decay and checks validity windows.
3. Detects retracted or vanished declared and compiled grounding.
4. Writes canonical accumulation documents needing review to
   `.daftari/wake-queue.jsonl`, ranked by blast radius.
5. Produces a Morning Report covering tensions, pending ratification, and
   rubber-stamp signals.

For a deleted vault source, the report distinguishes a path recoverable from
Git history from one absent in available history. Generative documents are
counted when stale but do not enter the wake queue: their decay is expected.

Each completed pass appends a content-light summary to the self-pruning run
ledger. Inspect it with:

```bash
daftari runs list --vault ./my-vault
daftari runs show <run-id> --vault ./my-vault
```

The wake queue is work for an external agent or operator: re-check the sources,
stage a correction, and route the change through the normal approval path.

## Decide contradictions in Tension Court

`daftari court` turns open tensions into case briefs. The default docket ranks
stale cases first and then considers downstream blast radius:

```bash
daftari court --vault ./my-vault
daftari court --tension tension-abc123 --vault ./my-vault
```

Each brief includes both claims, current document state, downstream stakes,
cluster membership, and relevant precedents. Precedent retrieval is
deterministic: shared document, then collection pair, then tension kind.

For a deliberately unranked, cluster-grouped view, use the triage card:

```bash
daftari court --triage --vault ./my-vault
```

The same view is available to MCP clients through `vault_tension_triage`.
Criticality, provenance, and author identity remain visible so the reviewer can
judge trust without opening every document.

Record a ruling with a rationale:

```bash
daftari court rule tension-abc123 \
  --vault ./my-vault \
  --kind corrected \
  --rationale "Vendor pricing page confirmed the entry tier on 2026-07-10."
```

A ruling closes the tension through the same path as
`vault_tension_resolve`. It does not edit either disputed document. Correcting
or superseding the documents remains a separate, attributable action.

## Interview the principal

Some gaps cannot be inferred from the corpus. `daftari interview` assembles a
question sheet from:

- open tensions, contested and long-carried first;
- canonical accumulation documents past their TTL; and
- `questions_raised` entries that no document answers.

Generate the sheet or conduct the interview:

```bash
daftari interview --vault ./my-vault
daftari interview ask --vault ./my-vault
```

Answers are recorded verbatim in an `interviews/` document with `tier: source`,
`provenance: direct`, immutable body text, and source links back to the gaps
that prompted each question. Empty input skips a question; `q` ends the
session.

The transcript is evidence, not a ruling. Use it as a cited source in a later
court decision or re-verified document update.

## Reconstruct past belief with `asof`

Daftari uses Git as the version layer, so archaeology reads repository history
without checking out an old tree or modifying the current index:

```bash
# The vault at a date or Git ref, plus subsequent drift
daftari asof 2026-03-03 --vault ./my-vault

# One document then and now
daftari asof HEAD~20 \
  --vault ./my-vault \
  --doc pricing/helios-consumption-pricing.md

# Who depended on a fact at that time, and where are they now?
daftari asof 2026-03-03 \
  --vault ./my-vault \
  --blast pricing/helios-consumption-pricing.md
```

The default report covers document and tension state at the selected point,
then lists drift: additions, removals, status and confidence transitions, and
tensions opened or resolved. `--blast` computes downstream reach in the old
tree and annotates each consumer with its status today.

`vault_receipt` and `asof` compose directly: a receipt's `vaultHead` is the Git
anchor needed to reproduce the supporting belief state.

## Inspect principal track records

`vault_witness` aggregates attributable writes, live claims, contested stake,
settled outcomes, proposal decisions, and tensions into a deterministic
principal-level ledger.

The default wager schedule prices confidence without enforcing policy:

- high confidence stakes 3 points;
- medium confidence stakes 1 point;
- low confidence stakes 0 points;
- a claim corrected or retired by someone else burns its stake; and
- a claim surviving a full TTL cycle earns credit.

The balance is advisory. Daftari does not route work or deny writes based on
the score. If one author accounts for at least 95% of writes and attributed
positions provide no less-concentrated counter-signal, the flat-curve monitor
declares comparisons uninformative instead of presenting concentration as
signal.

## Audit markdown coherence

`daftari audit` is a read-only check for broken cross-repository references and
link-graph staleness. It works on any markdown tree and does not create a
`.daftari/` directory.

```bash
daftari audit \
  --repo ~/repos/service-a \
  --repo ~/repos/service-b
```

The audit detects:

- missing files and headings referenced by relative links;
- GitHub-style repository links mapped through `audit.yaml` URL patterns;
- directly stale documents based on Git modification time; and
- fresh documents that depend, directly or transitively, on stale documents.

For URL-aware multi-repository checks:

```yaml
repos:
  - name: service-a
    path: ~/repos/service-a
    urls: ["github.com/org/service-a"]
  - name: service-b
    path: ~/repos/service-b
    urls: ["github.com/org/service-b"]

staleness:
  threshold_days: 540

fail_on:
  broken_refs: 1
  transitive_staleness: 100
```

```bash
daftari audit --config audit.yaml
```

Exit status distinguishes a threshold failure (`1`), configuration failure
(`2`), and runtime failure (`3`). Use `--output` for markdown and
`--output-json` for structured output. Run `daftari audit --help` for the
complete current flag set.

## Carry evidence across a boundary

`vault_receipt` produces a recomputable evidence record for documents cited in
an answer: standing, confidence, provenance, freshness, content hashes,
supersession resolution, open tensions, and the vault Git head.

When a receipt must leave the running vault as a signed artifact, use the
attestation CLI:

```bash
daftari attest keygen --out ./keys
daftari attest --vault ./my-vault --out ./bundle.json --key ./keys/attest.key
daftari attest verify ./bundle.json \
  --vault ./my-vault \
  --pubkey ./keys/attest.pub
```

The exact private-key filename is printed by `keygen`; it can also be supplied
through `DAFTARI_ATTEST_KEY`. Bundles must be written outside the vault so they
cannot become a second source of truth. Check `daftari attest --help` before
automation; this guide explains the workflow boundary, while the CLI remains
the flag reference.

A valid signature proves that the bundle is byte-identical to the operator's
snapshot claim. It does not prove freshness or the authorship of each document;
the signer is the vault operator.

## Related guides

- [Curation workflow](curation-workflow.md) — acting on individual findings.
- [Deployment and access](deployment.md) — running the server safely.
- [Architecture](architecture.md) — why these surfaces remain advisory.
- [Erasure protocol](erasure-protocol.md) — removing sensitive history.
