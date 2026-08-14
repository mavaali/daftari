# Pickup: what's next for daftari (2026-07-04)

Fresh-session handoff. Context for the individual threads lives in the memory files
(`~/.claude/projects/.../memory/`); this note carries the **prioritization**, which isn't in any single one.

## Just landed this session (all committed + pushed, clean)
- **Tension-graph vs data-olympus benchmark** — built end to end. Phase 1 (stand-in) + Phase 2 (live daftari
  retrieval) both done. Result: on feuds where retrieval buries one side, baseline surfaces the contradiction
  ~0.08, tension-graph ~0.42–0.46 (p<1e-10, 3 neutral models), replicated on daftari's real hybrid search.
  Scoped to the recall-limited regime; co-retrieved topics show no advantage. Code + results in
  `benchmarks/tension-graph/`. Branch `mihir/tension-graph-benchmark-spec`. See memory
  `project_tension_graph_benchmark`.
- **Wired into the paper** — new §9 "The augmentation, measured" + code-availability ref, in both the canonical
  markdown and the LaTeX (compiles clean under tectonic). Fast-forwarded into **PR #168**
  (`paper/draft-preserve-dont-resolve`, HEAD `f5032ac`). Paper commits are plain (no Claude trailer).

## Priority order for the next session

1. **Freeze + ship the paper (PR #168).** It's submission-shaped and just got stronger. Do a final human
   read-through in the context of §8–§10, freeze, submit to arXiv. Don't let it sit at 95%. Highest leverage.
   (memory: `project_daftari_paper`)
2. **Build tensions in `vault_search`.** The benchmark earned this: inline surfacing (3b) beat the dedicated
   tool (3a) across all models — flips the earlier lean. Real gap (tensions are currently reachable only via
   dedicated tools). Scope against current `src/search/hybrid.ts` + `src/tools/search.ts`; shape = inline
   `[contested]` annotation on results, keyed by a post-join against the tension log.
3. **Decide on powering the cortex loop (Stage 5).** The paper's §8 promises it as a companion study; it's
   data-blocked on your billed API key + a `launchctl` load to accrue a real journal. Needs your spend
   decision, not code. (memory: `project_cortex_consolidation_loop`)

## Cheap loop-closers — VERIFY current status before acting (these are from memory, may be stale)
- chunk-BM25: shipped but reportedly not default-flipped / not released. (`project_recall_bench_experiment`)
- Obsidian import PR #138: reportedly open, awaiting merge + release. (`project_obsidian_import`)
- `manifest.json` version drift (backlog item T) — matters before the next `.mcpb` cut. (`project_improvement_backlog`)

## Tradeoff to keep in mind
Shipping the paper displaces feature work for a few days — take that trade. The feature (with its evidence)
will still be there.
