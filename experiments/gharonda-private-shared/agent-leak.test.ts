// U5 — agent-layer leak boundary: contract stub, not a finished gate.
//
// See agent-boundary.md for the full analysis. Short version: federation
// (U1-U3) gives structural read isolation vault<->vault. It does NOT stop
// the *agent* — which legitimately holds read access to both a `*-private`
// vault and `shared` — from copying a private fact into a `shared` write.
// That residual risk is currently policy-level (same shape as Mavaali's own
// `hooks/family_scope_gate.py`). daftari's own consumes/derives_from
// lineage (src/curation/consumes.ts, edges.ts, read-log.ts) is scoped PER
// VAULT (join(vaultRoot, ".daftari", ...)) and cannot correlate a read
// served by one vault's process with a write landed by another's without
// new cross-vault plumbing that does not exist today.
//
// This stub does NOT wire up a real agent or a real daftari write-time
// hook — none exists yet. It encodes the CONTRACT the smallest structural
// reinforcement identified in agent-boundary.md would need to satisfy,
// using the one channel available today without new plumbing: declared
// `sources` frontmatter (src/frontmatter/types.ts) plus a body-content
// canary check as defense-in-depth. Both are explicitly named in the
// write-up as a backstop, not a closed guarantee.
import { describe, expect, it } from "vitest";

// --- the contract under test ------------------------------------------------
//
// A candidate write, as the agent would present it to a canonical-`shared`
// vault_write call. `sources` mirrors frontmatter.sources (declared
// provenance, self-reported by the writer — see source-ref.ts:11). `body`
// is the document content about to land.
interface CandidateWrite {
  targetVault: "shared" | "alice-private" | "bob-private";
  sources: string[]; // vault-relative or vault-qualified paths the writer declares it drew on
  body: string;
}

type Verdict = "ALLOW" | "REFUSE";

// Known private-vault canaries this spike seeded (see README.md's vault
// table) — stands in for a real deployment's "known secret" registry. A
// production version would not hardcode canaries; it would need a scan
// against actual private-vault content or an explicit taint marker, which
// is exactly the laundering-by-rephrase gap named below.
const PRIVATE_CANARIES = ["ALICE_SECRET_CANARY", "BOB_SECRET_CANARY"];

// A write "declares" a private source when any entry in `sources` names a
// path that looks like it belongs to a *-private vault (vault-qualified,
// e.g. "alice-private/therapy-notes.md", or a bare filename known to live
// only in a private vault in this fixture).
function declaresPrivateSource(sources: string[]): boolean {
  return sources.some((s) => /(^|\/)([a-z]+-private)\//.test(s) || s.includes("-private:"));
}

function containsKnownCanary(body: string): boolean {
  return PRIVATE_CANARIES.some((c) => body.includes(c));
}

// wouldLeakPrivateToShared — the contract this unit proposes for a
// write-time gate on the canonical-`shared` write path (not implemented
// inside daftari itself; this is the predicate a future hook would run).
//
// REFUSE when:
//   - the write targets `shared` AND declares a source under a `*-private`
//     vault (declared-provenance check, backed by existing `sources`
//     frontmatter — no new plumbing), OR
//   - the write targets `shared` AND its body contains a known private
//     canary string (crude content-scan defense-in-depth).
//
// ALLOW otherwise. Writes to a private vault are always out of scope for
// this predicate (nothing to protect against — the vault's own owner is
// writing to their own vault).
//
// HONEST LIMITATION (see agent-boundary.md, "irreducibly policy"): this
// predicate does NOT and CANNOT catch a write that paraphrases a private
// fact with no declared source and no verbatim canary. That is
// laundering-by-rephrase — no lineage graph, compiled or earned, observes
// an LLM's synthesis step. The predicate is a backstop against sloppy or
// honest-but-careless copies, not a closed guarantee against a
// deliberately evasive agent or a successful prompt injection.
function wouldLeakPrivateToShared(write: CandidateWrite): Verdict {
  if (write.targetVault !== "shared") return "ALLOW";
  if (declaresPrivateSource(write.sources)) return "REFUSE";
  if (containsKnownCanary(write.body)) return "REFUSE";
  return "ALLOW";
}

describe("U5 — agent-layer leak boundary contract (stub, not a finished gate)", () => {
  it("RED TEAM: refuses a shared write that copies a private therapy/salary note verbatim", () => {
    const write: CandidateWrite = {
      targetVault: "shared",
      sources: ["alice-private/therapy-notes.md"],
      body: "Session notes: discussed salary anxiety. ALICE_SECRET_CANARY",
    };
    expect(wouldLeakPrivateToShared(write)).toBe("REFUSE");
  });

  it("RED TEAM: refuses a shared write with no declared source but a verbatim private canary", () => {
    // Simulates an agent that copy-pasted content without citing sources —
    // the declared-provenance check alone would miss this; the canary scan
    // is the (still crude) second layer.
    const write: CandidateWrite = {
      targetVault: "shared",
      sources: [],
      body: "Reminder: BOB_SECRET_CANARY needs to be mentioned to the doctor.",
    };
    expect(wouldLeakPrivateToShared(write)).toBe("REFUSE");
  });

  it("LEGITIMATE: allows a shared write with no private-derived content", () => {
    const write: CandidateWrite = {
      targetVault: "shared",
      sources: ["shared/household-budget.md"],
      body: "Updated household budget: SHARED_HOUSEHOLD_FACT — groceries $600/mo.",
    };
    expect(wouldLeakPrivateToShared(write)).toBe("ALLOW");
  });

  it("LEGITIMATE: allows a private vault's own owner to write to their own private vault", () => {
    const write: CandidateWrite = {
      targetVault: "alice-private",
      sources: [],
      body: "ALICE_SECRET_CANARY — private journal entry, never intended for shared.",
    };
    expect(wouldLeakPrivateToShared(write)).toBe("ALLOW");
  });

  it("HONEST LIMITATION: does NOT catch paraphrase-laundering (documented, not silently passed)", () => {
    // The agent read Alice's private salary note and rephrased the fact
    // into shared with no declared source and no verbatim canary string.
    // This is exactly the case agent-boundary.md names as irreducibly
    // policy/judgment: no lineage-based or content-scan check can tell
    // this apart from an independently-authored fact.
    const laundered: CandidateWrite = {
      targetVault: "shared",
      sources: [], // agent omitted the source — nothing to check
      body: "FYI, household income this year is lower than usual, budget accordingly.",
    };
    // The stub ALLOWS this — asserting the gap exists, not that it's fine.
    // A passing assertion here is the test's way of refusing to overclaim:
    // if this ever starts failing (i.e. someone makes it REFUSE), the
    // comment above needs to be revisited, not silently deleted.
    expect(wouldLeakPrivateToShared(laundered)).toBe("ALLOW");
  });
});
