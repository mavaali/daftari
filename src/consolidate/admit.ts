// The real `makeAdmit` for the consolidate CLI (Stage 3 §5/D1/D5/D6). This is
// the envelope-owned admit: it assembles the EnvelopeCtx from in-process vault
// data, calls the pure evaluateEnvelope, owns the §3.7 per-session spend scalar
// (deduct-on-admit), and journals every loop decision to the shadow log.
//
// SCALE (carried concern): the vault docs are NOT loaded here — the caller
// (index.ts) already walked the vault once via loadDocuments and passes that
// LoadedDoc[] in. makeAdmit reuses it to build the reverse maps, per-endpoint
// metadata, and docCount, so there is no second disk walk and no per-file
// re-read. The only I/O makeAdmit itself does is reading staged actions and
// tensions ONCE at construction. The returned Admit closure does NO vault walk
// per call: it computes only blast from cached reverse maps. (Birth admits
// per-neighbor, so a per-call vault load would be N full walks per doc — which
// is exactly what reusing the caller's docs avoids.)
//
// Because docs/tensions are loaded once (the docs upstream, tensions here at
// construction), a tension the loop itself logs mid-pass does NOT self-gate
// later edges in the same run — this matches the plan's "load tensions once"
// intent.

import { posix } from "node:path";
import { computeDecay, type DecayInput } from "../curation/decay.js";
import {
  type EnvelopeJournalInput,
  recordEnvelopeDecision,
  type ShadowActionRecord,
  shadowBudget,
  shadowImpact,
} from "../curation/shadow.js";
import { listStagedActions } from "../curation/staged-actions.js";
import { listTensions } from "../curation/tension.js";
import {
  buildReverseLinkMap,
  buildReverseSourceMap,
  computeBlast,
} from "../curation/tension-blast.js";
import type { LoadedDoc } from "../curation/vault-docs.js";
import { ok, type Result } from "../frontmatter/types.js";
import {
  type Admit,
  type EndpointState,
  type EnvelopeActionType,
  type EnvelopeVerdict,
  evaluateEnvelope,
} from "./envelope.js";

export interface AdmitConfig {
  vaultRoot: string;
  principal: string; // CONSOLIDATE_AGENT (also the free-text agent claim)
  // The vault docs the caller already loaded (index.ts builds docByPath from the
  // same LoadedDoc[]). makeAdmit derives reverse maps, per-endpoint provenance/
  // decay metadata, and docCount from THIS — it never re-walks the vault. Each
  // LoadedDoc carries its schema-validation report (from the loader's parse
  // pass), which is what the provenance check needs: `content` is body-only, so
  // validation can't be recovered from it.
  docs: LoadedDoc[];
  // Injectable journal sink (defaults to recordEnvelopeDecision). Tests use this
  // to simulate a failing journal write (e.g. disk full) and assert the failure
  // is counted/surfaced without changing the gate verdict.
  journal?: (
    vaultRoot: string,
    input: EnvelopeJournalInput,
  ) => Promise<Result<ShadowActionRecord, Error>>;
}

// Same canon() the consolidate modules use — the recurring path-aliasing bug
// class (an alias like `x/../x/a.md` or `./x.md` would miss every keyed map).
function canon(p: string): string {
  return posix.normalize(p).replace(/^\.\//, "");
}

// What we cache per doc so the closure can answer provenance/decay without
// re-reading or re-parsing. `provenanceKnown` is decided at construction:
// false when the YAML was malformed (parse failed) or the schema is invalid.
interface CachedDoc {
  relPath: string;
  provenanceKnown: boolean;
  decayInput: DecayInput;
}

// Map the envelope action type to its journaling tool name.
function toolFor(action: EnvelopeActionType): "vault_edge_observe" | "vault_edge_contest" {
  return action === "edge-observe" ? "vault_edge_observe" : "vault_edge_contest";
}

// Builds the admit closure. Async + Result: construction still does I/O —
// listStagedActions / listTensions are read ONCE here and can fail. (The vault
// docs are NOT loaded here; the caller passes them in.) The CLI fails CLOSED on
// a construction error — the envelope must never let Component A auto-write on
// incomplete information.
export async function makeAdmit(
  cfg: AdmitConfig,
): Promise<Result<{ admit: Admit; journalFailures: () => number }, Error>> {
  const { vaultRoot, principal, docs: loaded } = cfg;
  const journal = cfg.journal ?? recordEnvelopeDecision;

  // Closure-local count of journal-write failures. Mirrors the traceWriteFailures
  // pattern in index.ts: a calibration row that fails to persist is counted and
  // surfaced, never silently dropped.
  let journalFailures = 0;

  // --- per-endpoint metadata, from the caller's already-loaded docs ---
  //
  // No vault walk and no per-file re-read happen here: the LoadedDoc[] the caller
  // passed already carries each doc's coerced frontmatter (for decay) AND its
  // schema-validation report (for provenance), both from the loader's single
  // parse pass. loadDocuments silently drops malformed-YAML docs, so any path
  // absent from `loaded` reads as unknown provenance below (fail closed); a doc
  // present but schema-invalid reads provenanceKnown=false via validation.valid.
  const cachedByPath = new Map<string, CachedDoc>();
  for (const d of loaded) {
    const relPath = canon(d.path);
    // The doc parsed cleanly (it's in the load set ⇒ YAML well-formed);
    // validation.valid tells us whether the schema holds (provenance-required,
    // §5.1) — recovered in-memory from the loader's parse, no re-read.
    const provenanceKnown = d.validation.valid;
    cachedByPath.set(relPath, {
      relPath,
      provenanceKnown,
      decayInput: {
        status: d.frontmatter.status,
        confidence: d.frontmatter.confidence,
        updated: d.frontmatter.updated,
        created: d.frontmatter.created,
        ttl_days: d.frontmatter.ttl_days,
        superseded_by: d.frontmatter.superseded_by,
      },
    });
  }

  // Reverse maps for blast — built from the loaded docs (one source of truth
  // with the tension-blast engine). buildReverse* key on the raw relPaths the
  // loader walked, so blast seeds canonicalize to those keys below.
  const reverseSource = buildReverseSourceMap(loaded);
  const reverseLink = buildReverseLinkMap(loaded);
  const docCount = loaded.length;

  // --- I/O ONCE: live pending staged actions → B₀ queue depth (§5.2) ---
  const pendingRes = await listStagedActions(vaultRoot, "pending");
  if (!pendingRes.ok) return pendingRes;
  const nowMs = Date.now();
  const livePending = pendingRes.value.filter((a) => Date.parse(a.expiresAt) > nowMs).length;

  // --- I/O ONCE: unresolved tensions → the tension-respect invariant (§5.1) ---
  const tensionsRes = await listTensions(vaultRoot);
  if (!tensionsRes.ok) return tensionsRes;
  const unresolvedTensionPaths = new Set<string>();
  for (const t of tensionsRes.value) {
    if (t.resolved) continue;
    unresolvedTensionPaths.add(canon(t.sourceA));
    unresolvedTensionPaths.add(canon(t.sourceB));
  }

  // The §3.7 per-session spend scalar — closure-local, ENVELOPE-owned (D6).
  // NEVER touches shadow's module-global spentByVault.
  let spent = 0;

  // Build an endpoint's invariant state. A canonical relPath not in the cached
  // docs (missing file, or a doc whose YAML was malformed and so was dropped by
  // loadDocuments) reads as unknown provenance — fail closed.
  //
  // v1 scope note: "unknown/broken provenance" here means the doc is missing
  // from the load set or its frontmatter is schema-invalid. Dangling-source
  // detection (an edge endpoint whose `sources` cite a non-vault path) is
  // deferred to Stage 4/5.
  const endpointState = (path: string): EndpointState => {
    const cached = cachedByPath.get(path);
    if (!cached) {
      return { path, provenanceKnown: false, decayBlocking: false, hasUnresolvedTension: false };
    }
    const d = computeDecay(cached.decayInput);
    // warn|deprecated block; aging does not (the scarcity rule, §5.1).
    const decayBlocking = d !== null && d.level !== "aging";
    return {
      path,
      provenanceKnown: cached.provenanceKnown,
      decayBlocking,
      hasUnresolvedTension: unresolvedTensionPaths.has(path),
    };
  };

  const admit: Admit = async (a): Promise<EnvelopeVerdict> => {
    const canonFrom = canon(a.fromPath);
    const canonTo = canon(a.toPath);
    const action = a.action;

    const fromState = endpointState(canonFrom);
    const toState = endpointState(canonTo);

    // Blast from cached maps (no disk walk). 1 (the action's own footprint) +
    // unique downstream reach of both endpoints. Seeds are the canonical relPath
    // keys the reverse maps use — which is exactly canon() output here.
    const blast =
      1 +
      computeBlast({ seeds: [canonFrom, canonTo], reverseSource, reverseLink }).downstream.length;
    const impact = shadowImpact(action, blast);
    const budget = shadowBudget(livePending, docCount);

    const verdict = evaluateEnvelope(
      { action, endpoints: [fromState, toState], impact, budget },
      spent,
    );

    // Journal the decision (admitted OR gated) to the shadow log. In shadow mode
    // the EDGE STORE write is suppressed by makeObserve; this decision journal
    // runs regardless of shadow mode (the gate decision is identical either way).
    //
    // The journal returns a Result — it is CHECKED, not thrown. A failed journal
    // write loses exactly one calibration row, but it must NOT change the gate
    // verdict or crash the pass: the gate decision and the deduct below proceed
    // unchanged. We count the failure here and surface it via the report instead.
    const res = await journal(vaultRoot, {
      tool: toolFor(action),
      action,
      targetPath: canonFrom,
      touchedPaths: [canonFrom, canonTo],
      agent: principal,
      principal,
      decision: verdict.admit ? "admitted" : "gated",
      ...(verdict.gate ? { gate: verdict.gate, gateReason: verdict.reason } : {}),
      impact: verdict.impact,
      budget,
      blast,
      spentBefore: spent,
      commitMessage: `[envelope:${verdict.admit ? "admit" : "gate"}] ${action} ${canonFrom} ← ${canonTo}`,
    });
    if (!res.ok) journalFailures++;

    // Deduct on admit (D1): only an admitted action spends. A gated action
    // leaves the budget untouched so a following clean action can still admit.
    if (verdict.admit) spent += verdict.impact;

    return verdict;
  };

  return ok({ admit, journalFailures: () => journalFailures });
}
