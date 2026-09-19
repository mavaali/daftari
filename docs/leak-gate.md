# Cross-vault private→shared leak gate

A structural, opt-in gate that stops an agent which legitimately reads a **private** vault plus a **shared** vault (a household topology — one shared vault mounted alongside per-person private vaults) from writing a **private-derived** fact into the **shared** vault, where other principals could read it.

It complements cross-vault **federation** (which enforces structural *read* isolation between vaults): federation stops principal A from *reading* B's private vault; this gate stops A's assistant from *copying* A's own private content *into* the shared vault under the same agent run.

## What it guarantees (when enabled)

For a write to a `visibility: "shared"` vault in `mode: "refuse"`:

- If the current agent run (`run_id`) previously read a `visibility: "private"` source, the write is **refused** — nothing written, indexed, or committed; a `rejected_leak` provenance row is logged. Covers `vault_write`, `vault_append`, the frontmatter tools (`promote`/`deprecate`/`supersede`/`set_confidence`/`set_tier`/`assert`/`consolidate`), and `vault_merge` — every agent-reachable path that lands a document body.
- Correlation is **cross-process**: a household session spans a private-owner process and a shared-canonical process (mounts are read-only, so shared writes need a canonical process on the shared vault). A run_id-keyed session ledger (default `~/.daftari/leak-ledger.jsonl`, `$XDG_STATE_HOME`-aware, overridable via `leak_gate.session_ledger_path`) is the join.
- **Fail-closed:** a run_id-less agent write to a gated shared vault is refused; a ledger that cannot be *read* refuses the write; a ledger that cannot be *written* refuses the private *read* (so a private read can never go silently un-journaled). Operator context (no `AccessContext`) is exempt, matching daftari's existing operator-bypass convention.
- **No private path disclosure:** the refusal message and `rejected_leak` provenance name only the `run_id` and a count of private sources — never the private document path. The ledger entries likewise carry no document path (`run_id` + `principal` + `visibility` + `source_vault` only).

## Configuration (opt-in)

```yaml
# .daftari/config.yaml
visibility: private        # or "shared"; DEFAULT "shared"
leak_gate:
  mode: refuse             # "refuse" | "warn" | "off"; DEFAULT "off"
  session_ledger_path: ~/.daftari/leak-ledger.jsonl   # optional
```

- **The engine default is `mode: "off"` — the gate is fully inert and writes nothing to the ledger** unless a deployment opts in. A household deployment sets `visibility` on each vault and `leak_gate.mode: refuse` on the shared vault. This keeps the gate from affecting single-vault / non-household installs.
- `warn` lets the write land and attaches a `leak_warning` advisory (for calibration before turning on `refuse`).

## Honest limitations (what it does NOT catch)

1. **Laundering by rephrase is not caught and cannot be.** If the agent paraphrases a private fact into a shared write with no traceable read edge — or writes under a *different* `run_id` than the one that read the private source — no lineage observes the LLM's synthesis step. This stays a policy / agent-judgment boundary, not a structural one. (`vault_write` and `vault_merge` behave identically here — parity, not a worse hole.)
2. **Consistent `run_id` across processes is an infrastructure contract.** The correlation depends on the assistant passing the same `run_id` to the private-owner and shared-canonical processes. The fail-closed run_id-less handling mitigates omission, but a hostile in-process caller that fabricates run_ids is outside the model.
3. **Single-filesystem assumption.** The session ledger requires both canonical processes on one host. Cross-machine federation would need a networked ledger — out of scope.
4. **Principal identity is asserted, not verified.** daftari's `--user` is trusted at spawn; this gate inherits that trust boundary and does not attempt to close it.
5. **Operator/batch writers bypass by design.** CLI/batch write paths that run without an `AccessContext` (distill, import, backfill, consolidate) are not gated — same operator-bypass posture as the rest of daftari. Whether operator batch jobs should be gated is a separate design question.

## Known follow-up (not a security gap)

When the gate is active, an unwritable ledger currently refuses reads of **any** gated vault, including `visibility: "shared"` reads (whose entries never count as a private leak). This is conservative/fail-closed but makes a shared vault brittle under an unwritable ledger — a candidate refinement is to scope the read-refusal to `private`-visibility reads only.
