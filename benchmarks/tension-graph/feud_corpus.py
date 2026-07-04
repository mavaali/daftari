"""Feud-corpus generator: co-active contradicting document pairs.

The augmentation that gives data-olympus's governance benchmark the axis it
structurally cannot measure. Each feud TOPIC yields two documents that:

- are both ``status: active`` (neither superseded — the load-bearing property),
- make opposing claims on the same topic,
- share retrieval trigger vocabulary (so one query retrieves BOTH),
- carry NO ``supersedes`` / ``superseded_by`` link between them,
- have NO date ordering implying one is newer.

Recency is therefore NOT a valid resolution function on this corpus. That is the
exact property that breaks data-olympus's total-order supersession model
(``status in {active, accepted, superseded}``, ``staleness_error`` needs a known
``current_id`` — a feud has none).

Honesty guardrails (asserted in test_feud_disjoint.py):
1. Feud topic keys are disjoint from the governance topics (_GOV_TOPICS) and the
   distractor topics (_DISTRACTOR_TOPICS), so a feud query can never be answered
   by the supersede-chain corpus.
2. Per topic, position-A vocab and position-B vocab are DISJOINT, and the shared
   trigger vocab (what the query uses) contains neither — so the query cannot
   lexically favor one side. Any surfacing/pick behavior is a substrate property,
   not a keyword artifact.

Runs INSIDE a vendored data-olympus checkout (imports benchmarks.corpus_model).
See benchmarks/tension-graph/README.md for the pinned SHA.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from benchmarks.corpus_model import Concept

if TYPE_CHECKING:
    from pathlib import Path

# Imported only to assert disjointness at generation time (fail fast if the
# upstream topic tables ever grow to collide with ours).
try:  # pragma: no cover - import shape depends on upstream layout
    from benchmarks.governance_corpus import (
        _DISTRACTOR_TOPICS as _GOV_DISTRACTORS,
    )
    from benchmarks.governance_corpus import (
        _GOV_TOPICS,
    )
except Exception:  # pragma: no cover
    _GOV_TOPICS = {}
    _GOV_DISTRACTORS = []


# ---------------------------------------------------------------------------
# Feud topic table
# Each entry is a genuine standing engineering disagreement where recency does
# NOT adjudicate: two scopes/teams hold opposing active standards.
#
#   label          : human-readable topic used in the query text.
#   shared_triggers: applies_when terms authored onto BOTH docs (retrieve both).
#   side_a / side_b: (slug, vocab, claim). vocab is position-specific and appears
#                    only in that doc's body; the two vocabs are disjoint and
#                    neither overlaps shared_triggers.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FeudSide:
    slug: str            # short id fragment, e.g. "rest"
    vocab: list[str]     # position-specific body vocab (disjoint across sides)
    claim: str           # what this side asserts (contradicts the other)


@dataclass(frozen=True)
class FeudSpec:
    label: str
    shared_triggers: list[str]
    side_a: FeudSide
    side_b: FeudSide


_FEUD_TOPICS: dict[str, FeudSpec] = {
    "api-paradigm": FeudSpec(
        label="the API paradigm for new services",
        shared_triggers=["api design", "service interface", "new endpoint", "api paradigm"],
        side_a=FeudSide(
            "rest",
            ["resource-oriented", "http verbs", "openapi", "hypermedia"],
            "Adopt REST: resource-oriented endpoints over HTTP verbs, described with OpenAPI.",
        ),
        side_b=FeudSide(
            "graphql",
            ["single schema", "typed graph", "resolver", "field selection"],
            "Adopt GraphQL: a single typed schema endpoint with client-driven field selection.",
        ),
    ),
    "service-granularity": FeudSpec(
        label="service granularity for the platform",
        shared_triggers=["service boundary", "deploy unit", "system decomposition", "granularity"],
        side_a=FeudSide(
            "microservices",
            ["independent deploys", "bounded context", "per-team ownership", "network calls"],
            "Decompose into microservices: independently deployable, per-team bounded contexts.",
        ),
        side_b=FeudSide(
            "monolith",
            ["single deployable", "in-process", "shared transaction", "modular monolith"],
            "Keep a modular monolith: a single deployable with in-process module boundaries.",
        ),
    ),
    "data-store": FeudSpec(
        label="the primary data store choice",
        shared_triggers=["persistence layer", "primary datastore", "storage engine", "data store"],
        side_a=FeudSide(
            "relational",
            ["normalized schema", "acid", "joins", "foreign keys"],
            "Use a relational store: normalized schema with ACID transactions and joins.",
        ),
        side_b=FeudSide(
            "document",
            ["denormalized", "aggregate document", "schema-flexible", "embedded records"],
            "Use a document store: denormalized aggregates, schema-flexible embedded records.",
        ),
    ),
    "concurrency-control": FeudSpec(
        label="the concurrency-control strategy",
        shared_triggers=["concurrent writes", "contention", "update conflict", "concurrency control"],
        side_a=FeudSide(
            "optimistic",
            ["version column", "compare-and-swap", "retry on conflict", "no locks held"],
            "Use optimistic concurrency: version columns and compare-and-swap, retry on conflict.",
        ),
        side_b=FeudSide(
            "pessimistic",
            ["row locks", "select for update", "held transaction", "serialized access"],
            "Use pessimistic locking: SELECT ... FOR UPDATE holds row locks for serialized access.",
        ),
    ),
    "repo-topology": FeudSpec(
        label="the repository topology",
        shared_triggers=["code organization", "repository layout", "source topology", "repo topology"],
        side_a=FeudSide(
            "monorepo",
            ["single codebase", "atomic cross-cut", "shared tooling", "unified ci"],
            "Adopt a monorepo: one repository, atomic cross-cutting changes, shared tooling.",
        ),
        side_b=FeudSide(
            "polyrepo",
            ["per-service repo", "independent versioning", "isolated blast radius", "separate pipelines"],
            "Adopt polyrepo: one repository per service, independent versioning and pipelines.",
        ),
    ),
    "branching-model": FeudSpec(
        label="the git branching model",
        shared_triggers=["branch strategy", "integration cadence", "release branch", "branching model"],
        side_a=FeudSide(
            "trunk",
            ["trunk-based", "short-lived branches", "feature flags", "continuous integration"],
            "Use trunk-based development: short-lived branches merged to trunk behind feature flags.",
        ),
        side_b=FeudSide(
            "gitflow",
            ["long-lived develop", "release branches", "hotfix branch", "staged promotion"],
            "Use gitflow: long-lived develop plus release and hotfix branches with staged promotion.",
        ),
    ),
    "test-emphasis": FeudSpec(
        label="where to focus the automated test suite",
        shared_triggers=["test suite", "coverage focus", "automated testing", "test emphasis"],
        side_a=FeudSide(
            "pyramid",
            ["mostly unit", "few end-to-end", "fast feedback", "isolated units"],
            "Follow the test pyramid: mostly fast isolated unit tests, few end-to-end tests.",
        ),
        side_b=FeudSide(
            "trophy",
            ["integration-heavy", "user-facing flows", "component tests", "realistic wiring"],
            "Follow the testing trophy: concentrate on integration tests of realistic wiring.",
        ),
    ),
    "compute-model": FeudSpec(
        label="the compute deployment model",
        shared_triggers=["deployment target", "runtime platform", "hosting model", "compute model"],
        side_a=FeudSide(
            "kubernetes",
            ["container orchestration", "long-running pods", "cluster autoscaling", "self-managed"],
            "Deploy on Kubernetes: containerized long-running pods on a self-managed cluster.",
        ),
        side_b=FeudSide(
            "serverless",
            ["functions as a service", "event-triggered", "scale to zero", "managed runtime"],
            "Deploy serverless: event-triggered functions on a managed runtime that scales to zero.",
        ),
    ),
    "service-data-ownership": FeudSpec(
        label="how services share the database",
        shared_triggers=["database sharing", "data ownership", "cross-service data", "shared schema"],
        side_a=FeudSide(
            "db-per-service",
            ["private schema", "no cross-service reads", "api-only access", "owned tables"],
            "Give each service its own database; other services reach it only through its API.",
        ),
        side_b=FeudSide(
            "shared-db",
            ["common schema", "direct table reads", "single migration", "shared referential integrity"],
            "Use one shared database with a common schema and direct cross-service table reads.",
        ),
    ),
    "identifier-scheme": FeudSpec(
        label="the primary-key identifier scheme",
        shared_triggers=["primary key", "record identifier", "id generation", "identifier scheme"],
        side_a=FeudSide(
            "uuid",
            ["random uuid", "client-generatable", "non-sequential", "globally unique"],
            "Use random UUIDs: client-generatable, globally unique, non-sequential keys.",
        ),
        side_b=FeudSide(
            "sequential",
            ["auto-increment", "monotonic integer", "index-friendly", "database-assigned"],
            "Use auto-increment integers: monotonic, index-friendly, database-assigned keys.",
        ),
    ),
}

# Feud docs are authored by two DIFFERENT scopes to dramatize the standing
# disagreement (backend guild vs project team) — both live, neither governs.
_TIER_A = "T2"  # tech-stacks/backend
_TIER_B = "T3"  # projects/example-project
_DIR_FOR_TIER = {
    "T2": "tech-stacks/backend",
    "T3": "projects/example-project",
}
_FEUD_TYPE = "standard"     # both sides are standards; neither is a decision that supersedes
_FEUD_STATUS = "active"     # LOAD-BEARING: both active, no supersession


# ---------------------------------------------------------------------------
# Manifest types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FeudRecord:
    """Ground truth for one feud topic: two co-active contradicting docs."""

    topic: str
    label: str
    doc_a_id: str
    doc_b_id: str
    claim_a: str
    claim_b: str
    shared_triggers: list[str]


@dataclass(frozen=True)
class FeudCorpusManifest:
    concepts: list[Concept] = field(default_factory=list)
    feuds: list[FeudRecord] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Document helpers (self-contained; no dependency on upstream privates)
# ---------------------------------------------------------------------------

def _body(label: str, side: FeudSide) -> str:
    """Doc body states this side's position. Position-specific vocab lives ONLY
    here (never in shared_triggers), so the retrieval query cannot favor a side.
    """
    bullets = "\n".join(f"- {term.capitalize()}." for term in side.vocab)
    return (
        f"# {label} — {side.slug}\n\n"
        f"This standard governs {label}. {side.claim}\n\n"
        f"## Position\n\n{bullets}\n\n"
        f"This is an active standard. It does not supersede any other document; "
        f"a competing active standard exists and the disagreement is unresolved.\n"
    )


def _frontmatter(
    doc_id: str, tier: str, title: str, description: str, applies_when: list[str]
) -> str:
    lines = [
        "---",
        f"id: {doc_id}",
        f"type: {_FEUD_TYPE}",
        f"status: {_FEUD_STATUS}",
        f"tier: {tier}",
        f"title: {title}",
        f"description: {description}",
        "applies_when:",
    ]
    lines += [f'  - "{t}"' for t in applies_when]
    # Deliberately NO supersedes / superseded_by field on either side.
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def _doc_id(topic: str, side: FeudSide) -> str:
    return f"FEUD_{topic}_{side.slug}".upper().replace("-", "_")


def _make_concept(topic: str, spec: FeudSpec, side: FeudSide, tier: str) -> Concept:
    doc_id = _doc_id(topic, side)
    directory = _DIR_FOR_TIER[tier]
    return Concept(
        id=doc_id,
        path=f"{directory}/{doc_id}.md",
        tier=tier,
        type=_FEUD_TYPE,
        status=_FEUD_STATUS,
        title=f"{spec.label} ({side.slug})",
        topic=topic,
        body=_body(spec.label, side),
    )


def _write(dest: Path, concept: Concept, spec: FeudSpec, side: FeudSide) -> None:
    p = dest / concept.path
    p.parent.mkdir(parents=True, exist_ok=True)
    fm = _frontmatter(
        concept.id,
        concept.tier,
        concept.title,
        f"Active standard for {spec.label} ({side.slug} position).",
        spec.shared_triggers,
    )
    p.write_text(fm + concept.body, encoding="utf-8")


# ---------------------------------------------------------------------------
# Public generator
# ---------------------------------------------------------------------------

def generate_feud_corpus(dest: Path, *, n: int | None = None) -> FeudCorpusManifest:
    """Write co-active feud pairs under ``dest`` (a bundle root) and return the
    manifest. Deterministic: no randomness, fixed table order. ``n`` caps the
    number of feud topics (default: all).
    """
    from pathlib import Path as _Path

    dest = _Path(dest)
    _assert_topic_disjointness()

    keys = list(_FEUD_TOPICS.keys())
    if n is not None:
        keys = keys[:n]

    concepts: list[Concept] = []
    feuds: list[FeudRecord] = []

    for topic in keys:
        spec = _FEUD_TOPICS[topic]
        ca = _make_concept(topic, spec, spec.side_a, _TIER_A)
        cb = _make_concept(topic, spec, spec.side_b, _TIER_B)
        _write(dest, ca, spec, spec.side_a)
        _write(dest, cb, spec, spec.side_b)
        concepts.extend([ca, cb])
        feuds.append(FeudRecord(
            topic=topic,
            label=spec.label,
            doc_a_id=ca.id,
            doc_b_id=cb.id,
            claim_a=spec.side_a.claim,
            claim_b=spec.side_b.claim,
            shared_triggers=list(spec.shared_triggers),
        ))

    return FeudCorpusManifest(concepts=concepts, feuds=feuds)


# ---------------------------------------------------------------------------
# Honesty guardrails (also asserted by the test suite)
# ---------------------------------------------------------------------------

def _assert_topic_disjointness() -> None:
    feud_keys = set(_FEUD_TOPICS)
    gov_keys = set(_GOV_TOPICS)
    distractors = set(_GOV_DISTRACTORS)
    assert feud_keys.isdisjoint(gov_keys), (
        f"feud topics collide with governance topics: {feud_keys & gov_keys}"
    )
    assert feud_keys.isdisjoint(distractors), (
        f"feud topics collide with distractor topics: {feud_keys & distractors}"
    )


def _iter_vocab_conflicts() -> list[str]:
    """Return human-readable descriptions of any within-topic vocab overlap.

    A clean corpus returns []. Overlap means the query (shared_triggers) or one
    side's vocab could lexically favor a side — a fairness bug.
    """
    problems: list[str] = []
    for topic, spec in _FEUD_TOPICS.items():
        a = {w.lower() for w in spec.side_a.vocab}
        b = {w.lower() for w in spec.side_b.vocab}
        shared = {w.lower() for w in spec.shared_triggers}
        if a & b:
            problems.append(f"{topic}: side-A/side-B vocab overlap {a & b}")
        if a & shared:
            problems.append(f"{topic}: side-A vocab overlaps shared triggers {a & shared}")
        if b & shared:
            problems.append(f"{topic}: side-B vocab overlaps shared triggers {b & shared}")
    return problems


# ---------------------------------------------------------------------------
# Divergent regime (the validity-test corpus)
# ---------------------------------------------------------------------------
# The shared-regime corpus (above) authors BOTH sides with the same triggers, so
# a query retrieves both and a capable model surfaces the contradiction unaided
# (measured 2026-07-04 — every cell surfaced, tension-graph showed no marginal
# value). That run did not isolate the primitive because the cells received
# identical document payloads.
#
# The divergent regime creates the condition the hypothesis actually needs: side
# A is authored in the query's vocabulary (retrieves into top-k); side B is
# authored in genuinely DIFFERENT vocabulary (a second team's framing of the same
# decision) and carries NO query-matching triggers, so ordinary lexical retrieval
# buries it. The two sides are linked only by the id-based tension edge. A
# retrieval baseline then sees only side A and answers "settled"; the tension
# graph is the only thing that can surface the buried side B.
#
# Layer onto data-olympus's full base corpus (their published 250 concepts) so
# top-k is genuinely selective — NOT a contrived tiny corpus. Whether B actually
# falls out of top-k is an empirical question measured before any model call; if
# it does not, that is a kill signal, not something to tune away.

_DIV_TIER_A = "T2"
_DIV_TIER_B = "T3"


def _divergent_body(slug: str, side: FeudSide) -> str:
    bullets = "\n".join(f"- {t.capitalize()}." for t in side.vocab)
    return (
        f"# {slug} standard\n\n{side.claim}\n\n## Position\n\n{bullets}\n\n"
        f"An active standard. It does not supersede any other document.\n"
    )


def _write_div(
    dest: Path, doc_id: str, tier: str, title: str, applies_when: list[str], body: str
) -> None:
    p = dest / _DIR_FOR_TIER[tier] / f"{doc_id}.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    # No colon in the description value — an unquoted ': ' breaks the YAML block
    # and the id falls back to a path-derived slug.
    fm = _frontmatter(doc_id, tier, title, f"Active standard for {title}.", applies_when)
    p.write_text(fm + body, encoding="utf-8")


def generate_feud_corpus_divergent(dest: Path, *, n: int | None = None) -> FeudCorpusManifest:
    """Divergent-regime feuds: side A query-aligned, side B lexically divergent
    and query-invisible. Both active, linked only by the tension edge. doc_a is
    always the query-aligned side."""
    from pathlib import Path as _Path

    dest = _Path(dest)
    _assert_topic_disjointness()
    keys = list(_FEUD_TOPICS.keys())
    if n is not None:
        keys = keys[:n]

    concepts: list[Concept] = []
    feuds: list[FeudRecord] = []
    for topic in keys:
        spec = _FEUD_TOPICS[topic]
        a, b = spec.side_a, spec.side_b
        a_id = f"FEUDD_{topic}_{a.slug}".upper().replace("-", "_")
        b_id = f"FEUDD_{topic}_{b.slug}".upper().replace("-", "_")
        # A carries the shared (label-matching) triggers so a NEUTRAL label query
        # retrieves it; B carries only its divergent vocab so the same neutral
        # query buries it. This isolates retrieval as the single variable (the
        # query no longer editorializes toward A).
        _write_div(dest, a_id, _DIV_TIER_A, f"{a.slug} standard", list(spec.shared_triggers),
                   _divergent_body(a.slug, a))
        _write_div(dest, b_id, _DIV_TIER_B, f"{b.slug} standard", list(b.vocab),
                   _divergent_body(b.slug, b))
        for doc_id, tier, side in ((a_id, _DIV_TIER_A, a), (b_id, _DIV_TIER_B, b)):
            concepts.append(Concept(
                id=doc_id, path=f"{_DIR_FOR_TIER[tier]}/{doc_id}.md", tier=tier,
                type=_FEUD_TYPE, status=_FEUD_STATUS, title=f"{side.slug} standard",
                topic=topic, body=_divergent_body(side.slug, side),
            ))
        feuds.append(FeudRecord(
            topic=topic, label=spec.label, doc_a_id=a_id, doc_b_id=b_id,
            claim_a=a.claim, claim_b=b.claim, shared_triggers=list(spec.shared_triggers),
        ))
    return FeudCorpusManifest(concepts=concepts, feuds=feuds)


def main() -> None:  # pragma: no cover - manual smoke run
    import tempfile
    from pathlib import Path as _Path

    with tempfile.TemporaryDirectory() as td:
        manifest = generate_feud_corpus(_Path(td))
    print(f"feud topics: {len(manifest.feuds)}  docs: {len(manifest.concepts)}")
    conflicts = _iter_vocab_conflicts()
    print(f"vocab conflicts: {len(conflicts)}")
    for c in conflicts:
        print(f"  ! {c}")
    for f in manifest.feuds:
        print(f"  {f.topic}: {f.doc_a_id} vs {f.doc_b_id}")


if __name__ == "__main__":
    main()
