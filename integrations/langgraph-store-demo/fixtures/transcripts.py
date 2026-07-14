"""Four simulated agent sessions for Meridian Labs / Relay.

Each session is a (session_id, messages) pair in chronological order. Planted
facts (see design.md) are embedded in natural conversation. Near-duplicate
pair halves live in the SAME session, spaced apart and in different
trajectories (see SPLITS). Contradiction halves are spread ACROSS sessions and
never co-mentioned, so no transcript resolves them.

Distance-check note: the first fixture draft failed the embedding honesty gate
(near-dup pairs too dissimilar, PC2 above them). This revision tightens
near-dup paraphrases to the same proposition with moderate rewording only, and
keeps each planted fact in its own message so extraction can't fuse plants.
"""

SESSIONS = [
    (
        "pricing",
        [
            {"role": "user", "content": "Prepping the Q3 pricing review for Relay. What do we anchor on?"},
            {"role": "assistant", "content": "Relay ships three tiers: Free, Pro, and Enterprise. Meridian Labs has run that structure since the 2019 founding, and the sales-led plus PLG motion hasn't changed."},
            {"role": "user", "content": "What's the Pro tier's headline capacity promise? Sales keeps asking."},
            {"role": "assistant", "content": "Pro tier is sold with a guaranteed 500 requests per second per workspace. That's the number on every order form this year."},
            {"role": "user", "content": "And the API behavior defaults we quote in contracts?"},
            {"role": "assistant", "content": "Relay's default API timeout is 30 seconds — that's the number in the standard contract language."},
            {"role": "user", "content": "What about log retention commitments?"},
            {"role": "assistant", "content": "Standard terms commit to 90-day retention for Relay logs."},
            {"role": "user", "content": "Anything infra-side I should know for cost modeling?"},
            {"role": "assistant", "content": "The control plane runs Postgres 13, and the team of about 120 employees is mostly split between Go and TypeScript services. HQ is Portland, if travel budgeting matters."},
            {"role": "user", "content": "Who signs off on pricing exceptions?"},
            {"role": "assistant", "content": "CEO Dana Okafor signs enterprise exceptions personally. Also worth restating for renewals: the default timeout for Relay API requests is 30 seconds."},
            {"role": "user", "content": "Great. Anything on the horizon that changes pricing?"},
            {"role": "assistant", "content": "EU data residency is on the roadmap and RelayConf lands in October — both tend to generate enterprise pipeline. SOC 2 Type II is already done, so that unblocks most security reviews."},
        ],
    ),
    (
        "ops",
        [
            {"role": "user", "content": "Handover notes for the new SRE. What does the Relay platform actually look like?"},
            {"role": "assistant", "content": "Core services are Go with a TypeScript control panel, events go over Kafka, and deploys run through Argo CD. Telemetry data from Relay lands in ClickHouse."},
            {"role": "user", "content": "What are the hard capacity numbers?"},
            {"role": "assistant", "content": "Gateway capacity is hard-capped at 350 requests per second per workspace. Raising that ceiling requires a re-shard, which is a planned maintenance event — nobody bypasses it casually."},
            {"role": "user", "content": "Deploy geography?"},
            {"role": "assistant", "content": "Primary deploy region for Relay is us-east-1. Staging refreshes nightly at 02:00 UTC, so morning-shift engineers always get fresh data."},
            {"role": "user", "content": "Who carries the pager?"},
            {"role": "assistant", "content": "On-call for Relay is owned by the platform team. Escalation goes through Linear tickets tagged sev1."},
            {"role": "user", "content": "Anything security-flavored in the gateway path?"},
            {"role": "assistant", "content": "Webhook signatures use SHA-1 HMAC — it's on the list to revisit. Quarterly planning usually picks up one security item per cycle."},
            {"role": "user", "content": "Anything else the new hire will trip over?"},
            {"role": "assistant", "content": "Two things people forget: Relay telemetry is stored in a ClickHouse cluster, not Postgres, so don't go looking for metrics in the control-plane DB. And the staging data reload happens at 2am UTC nightly, so a 1:50am UTC repro will vanish under you."},
        ],
    ),
    (
        "support",
        [
            {"role": "user", "content": "Onboarding a new support engineer for Relay. What are the ground rules?"},
            {"role": "assistant", "content": "Enterprise SLA is 4-hour first response. The Slack community is about 4,000 members and handles a lot of Free-tier triage informally."},
            {"role": "user", "content": "A customer is hitting rate limits during a launch. What can we actually do?"},
            {"role": "assistant", "content": "For enterprise escalations, support grants temporary bursts to 800 requests per second without ops involvement. It's a support-console toggle, logged per workspace."},
            {"role": "user", "content": "What about log access when debugging customer issues?"},
            {"role": "assistant", "content": "Move fast on repro: we purge Relay logs after two weeks, so ask for timestamps early in the ticket."},
            {"role": "user", "content": "Who do I page when something is actually down?"},
            {"role": "assistant", "content": "Incident response for Relay is the application team's job — page them, not infra. NPS sits around 44 and quick incident comms is a big part of why."},
            {"role": "user", "content": "Any recent platform changes that generate tickets?"},
            {"role": "assistant", "content": "Workspaces created after May use SHA-256 webhook signing, so signature-mismatch tickets from new customers are usually integration bugs on their side, not ours."},
            {"role": "user", "content": "Anything else timing-related for expectations?"},
            {"role": "assistant", "content": "The enterprise SLA guarantees first response within 4 hours — set customer expectations accordingly, and note the design-partner program accounts get a named CSM on top."},
        ],
    ),
    (
        "docs",
        [
            {"role": "user", "content": "Auditing the public Relay docs before the refresh. What's currently published?"},
            {"role": "assistant", "content": "Docs run on Docusaurus. Public docs state every plan is throttled to 200 requests per second unless a custom contract overrides it — that's on the rate-limits page."},
            {"role": "user", "content": "Which customer references are we allowed to use?"},
            {"role": "assistant", "content": "Acme Corp is the largest Relay customer. CTO Priya Shen usually reviews joint case studies personally."},
            {"role": "user", "content": "Anything about infrastructure we say publicly?"},
            {"role": "assistant", "content": "All Relay production workloads run out of eu-west-2 — the trust page says so for data-residency questions. We also publish the SOC 2 Type II status there."},
            {"role": "user", "content": "Recent changes the docs need to catch up on?"},
            {"role": "assistant", "content": "The EU control-plane cluster migrated to Postgres 16 in Q3, and the trust page's subprocessor list needs that update. No on-prem offering exists, so keep deflecting those requests to the FAQ."},
            {"role": "user", "content": "Anything else stale?"},
            {"role": "assistant", "content": "One correction for the refresh: the biggest customer on Relay is Acme Corp. The founded-in-2019 copy is fine to keep."},
        ],
    ),
]

# Detection signatures: plant id -> (category, [regex alternates], sessions involved).
# A plant "landed"/"survived" iff at least one memory row matches its regex set.
PLANTS = {
    # near-dup pairs (control): sig matches BOTH halves; merged iff row count drops to 1
    "ND1": ("near-dup", r"(?=.*30\s*s)(?=.*time\s*.?out)", ["pricing"]),
    "ND2": ("near-dup", r"clickhouse", ["ops"]),
    "ND3": ("near-dup", r"(?=.*staging)(?=.*(2\s*am|02:00|2:00))", ["ops"]),
    "ND4": ("near-dup", r"(?=.*enterprise)(?=.*(4|four)(-|\s)*hour)", ["support"]),
    "ND5": ("near-dup", r"(?=.*acme)(?=.*(largest|biggest))", ["docs"]),
    # pairwise contradictions
    "PC1a": ("pairwise", r"us-east-1", ["ops"]),
    "PC1b": ("pairwise", r"eu-west-2", ["docs"]),
    "PC2a": ("pairwise", r"(?=.*90)(?=.*(day|retention))(?=.*log)", ["pricing"]),
    "PC2b": ("pairwise", r"(?=.*log)(?=.*(two\s*week|14\s*day|2\s*week))", ["support"]),
    "PC3a": ("pairwise", r"(?=.*platform team)(?=.*(on.?call|pager))", ["ops"]),
    "PC3b": ("pairwise", r"(?=.*application team)(?=.*(incident|outage|page))", ["support"]),
    # n-way capacity set
    "NW-A": ("n-way", r"(?=.*500)(?=.*(request|rps|req/s))", ["pricing"]),
    "NW-B": ("n-way", r"(?=.*350)(?=.*(request|rps|req/s))", ["ops"]),
    "NW-C": ("n-way", r"(?=.*800)(?=.*(request|rps|req/s))", ["support"]),
    "NW-D": ("n-way", r"(?=.*200)(?=.*(request|rps|req/s|throttl))", ["docs"]),
    # temporal traps
    "TT1a": ("temporal", r"(?=.*postgres(ql)?\s*13)", ["pricing"]),
    "TT1b": ("temporal", r"(?=.*postgres(ql)?\s*16)(?=.*(eu|q3))", ["docs"]),
    "TT2a": ("temporal", r"(?=.*sha-?1\b)(?=.*webhook)", ["ops"]),
    "TT2b": ("temporal", r"(?=.*sha-?256)(?=.*(webhook|workspace))", ["support"]),
}

# Embedding-distance check pairs: (label, text_a, text_b, kind).
# Texts mirror the transcript phrasings exactly.
DISTANCE_PAIRS = [
    ("ND1", "Relay's default API timeout is 30 seconds", "The default timeout for Relay API requests is 30 seconds", "near-dup"),
    ("ND2", "Telemetry data from Relay lands in ClickHouse", "Relay telemetry is stored in a ClickHouse cluster", "near-dup"),
    ("ND3", "Staging refreshes nightly at 02:00 UTC", "The staging data reload happens at 2am UTC nightly", "near-dup"),
    ("ND4", "Enterprise SLA is 4-hour first response", "The enterprise SLA guarantees first response within 4 hours", "near-dup"),
    ("ND5", "Acme Corp is the largest Relay customer", "The biggest customer on Relay is Acme Corp", "near-dup"),
    ("PC1", "Primary deploy region for Relay is us-east-1", "All Relay production workloads run out of eu-west-2", "contradiction"),
    ("PC2", "Standard terms commit to 90-day retention for Relay logs", "We purge Relay logs after two weeks", "contradiction"),
    ("PC3", "On-call for Relay is owned by the platform team", "Incident response for Relay is the application team's job", "contradiction"),
    ("NW-AB", "Pro tier is sold with a guaranteed 500 requests per second per workspace", "Gateway capacity is hard-capped at 350 requests per second per workspace; raising it requires a re-shard", "contradiction"),
    ("NW-BC", "Gateway capacity is hard-capped at 350 requests per second per workspace; raising it requires a re-shard", "For enterprise escalations, support grants temporary bursts to 800 requests per second without ops involvement", "contradiction"),
    ("NW-CD", "For enterprise escalations, support grants temporary bursts to 800 requests per second without ops involvement", "Public docs state every plan is throttled to 200 requests per second unless a custom contract overrides it", "contradiction"),
    ("NW-AD", "Pro tier is sold with a guaranteed 500 requests per second per workspace", "Public docs state every plan is throttled to 200 requests per second unless a custom contract overrides it", "contradiction"),
    ("TT1", "The control plane runs Postgres 13", "The EU control-plane cluster migrated to Postgres 16 in Q3", "temporal"),
    ("TT2", "Webhook signatures use SHA-1 HMAC", "Workspaces created after May use SHA-256 webhook signing", "temporal"),
]

# created_at shifts per session (days before run date), oldest first.
SESSION_AGE_DAYS = {"pricing": 90, "ops": 60, "support": 30, "docs": 7}

# Each session is processed as TWO separate trajectories (split at these
# message indices). Rationale: if both halves of a near-dup pair sit in one
# extraction context, the LLM dedupes them at extraction time and the merge
# control-group tells us nothing about LangMem's *store* consolidation. The
# split puts each near-dup half in a different trajectory of the same session,
# so merging can only happen through store retrieval — the mechanism under test.
SPLITS = {"pricing": 10, "ops": 8, "support": 8, "docs": 6}


def session_parts():
    """Yield (session_id, part_index, messages) with near-dup halves separated."""
    for sid, msgs in SESSIONS:
        cut = SPLITS[sid]
        yield sid, 0, msgs[:cut]
        yield sid, 1, msgs[cut:]
