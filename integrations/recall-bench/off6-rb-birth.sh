#!/usr/bin/env bash
# Durable RB edge-birth pipeline for the off.6 wild edge-alignment test.
#
# The 2026-08-18 birth run bought ~7,200 Haiku verdicts and kept them in
# /tmp/rb-baseline-vector, which macOS wiped on 2026-08-23 (no Time Machine:
# /tmp is a standard exclusion). This script rebuilds the same pipeline in a
# durable directory and REFUSES temp locations, so paid output can't evaporate.
#
# Stages (each skips when its output already exists — rerun to resume):
#   1. corpus   clone the pinned recall corpus (baseline/manifest.json)   $0
#   2. vault    baseline-runner.mjs builds + indexes the EA-180d vault    $0
#   3. queries  QA -> edge-ceiling queries.jsonl ({query, relevant})      $0
#   4. config   shadow_mode: false on the bench vault (birth writes live)  $0
#   5. scan     consolidate --mode scan: size the birth queue              $0
#   6. birth    consolidate --mode birth                       PAID — gated
#   7. replay   replay-birth-trace.mjs re-applies every journaled verdict  $0
#   8. ceiling  edge-ceiling.mjs: ceiling vs rank-extension go/no-go       $0
#
# Without CONFIRM_SPEND=1 the run stops after stage 5. Stage 6 also needs
# ANTHROPIC_API_KEY and is hard-capped by MAX_LLM_CALLS (default 8000).
# The birth trace lives in $WORK/rb/vault/.daftari/birth-trace.jsonl.
#
# Usage: WORK=~/mavaali-bench/off6-rb-birth integrations/recall-bench/off6-rb-birth.sh
# Requires a built daftari (npm run build) — the stages import dist/.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
: "${WORK:?set WORK to a durable directory (not under /tmp or \$TMPDIR)}"
MAX_LLM_CALLS="${MAX_LLM_CALLS:-8000}"

mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd -P)"
TMP_REAL="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
case "$WORK/" in
  /tmp/* | /private/tmp/* | /var/folders/* | /private/var/folders/* | "$TMP_REAL"/*)
    echo "off6: refusing WORK=$WORK — temp dirs are wiped and not backed up" >&2
    exit 2
    ;;
esac

CORPUS="$WORK/corpus"
RB="$WORK/rb"
VAULT="$RB/vault"
QUERIES="$RB/queries.jsonl"
CLI=(node "$ROOT/dist/cli.js")
MANIFEST="$HERE/baseline/manifest.json"
mf() { node -p "require('$MANIFEST')$1"; }
log() { echo "off6 [$(date -u +%FT%TZ)] $*"; }

[ -f "$ROOT/dist/cli.js" ] || { echo "off6: build daftari first (npm run build)" >&2; exit 1; }

# 1. corpus — pinned commit; baseline-runner re-verifies the content hashes.
if [ ! -d "$CORPUS/.git" ]; then
  log "1 corpus: cloning $(mf .corpus.repo) @ $(mf .corpus.commit)"
  git clone -q "$(mf .corpus.repo)" "$CORPUS"
  git -C "$CORPUS" checkout -q "$(mf .corpus.commit)"
else
  log "1 corpus: present"
fi

# 2. vault — the same construction the baseline used.
if [ ! -f "$VAULT/.daftari/index.db" ]; then
  log "2 vault: building via baseline-runner"
  (cd "$HERE" && RB_CORPUS="$CORPUS" RB_OUT="$RB" node baseline-runner.mjs)
else
  log "2 vault: present"
fi

# 3. queries — the baseline's question filter, relevant days as vault paths.
if [ ! -s "$QUERIES" ]; then
  log "3 queries: writing $QUERIES"
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const [manifestPath, corpus, out] = process.argv.slice(1);
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    const pad = (n) => String(n).padStart(4, "0");
    const lines = readFileSync(join(corpus, m.corpus.qaFile), "utf8")
      .split("\n").filter(Boolean).map(JSON.parse)
      .filter((q) => q.verdict === m.questionFilter.verdict && (q.relevant_days ?? []).length)
      .map((q) => JSON.stringify({
        id: q.id,
        query: q.question,
        relevant: q.relevant_days.map((d) => `${m.vault.collection}/day-${pad(d)}.md`),
      }));
    writeFileSync(out, lines.join("\n") + "\n");
    console.log(`${lines.length} labeled queries`);
  ' "$MANIFEST" "$CORPUS" "$QUERIES"
else
  log "3 queries: present ($(wc -l < "$QUERIES" | tr -d ' ') lines)"
fi

# 4. config — consolidate refuses Stage 2 without an explicit shadow_mode.
CFG="$VAULT/.daftari/config.yaml"
if ! grep -q '^shadow_mode:' "$CFG" 2>/dev/null; then
  log "4 config: shadow_mode: false (bench vault — birth writes edges live)"
  printf '\nshadow_mode: false\n' >> "$CFG"
else
  log "4 config: shadow_mode already set"
fi

# 5. scan — $0 sizing of the birth queue before any spend.
log "5 scan:"
"${CLI[@]}" consolidate --vault "$VAULT" --mode scan --budget 100000 | tee "$RB/scan.txt"

# 6. birth — the only paid stage.
if [ "${CONFIRM_SPEND:-}" != "1" ]; then
  log "stopping before PAID birth. Rerun with CONFIRM_SPEND=1 (cap MAX_LLM_CALLS=$MAX_LLM_CALLS)."
  exit 0
fi
: "${ANTHROPIC_API_KEY:?birth needs ANTHROPIC_API_KEY}"
log "6 birth: --max-llm-calls $MAX_LLM_CALLS (trace: $VAULT/.daftari/birth-trace.jsonl)"
"${CLI[@]}" consolidate --vault "$VAULT" --mode birth \
  --budget 100000 --max-births 100000 --max-llm-calls "$MAX_LLM_CALLS" 2>&1 | tee -a "$RB/birth.log"

# 7. replay — recovers the verdicts the per-session envelope refused.
log "7 replay:"
REPLAY_VAULT="$VAULT" node "$HERE/replay-birth-trace.mjs" | tee "$RB/replay.log"

# 8. ceiling — off.6's go/no-go.
log "8 ceiling:"
mkdir -p "$RB/ceiling"
EDGEHOP_VAULT="$VAULT" EDGEHOP_QUERIES="$QUERIES" EDGEHOP_OUT="$RB/ceiling" \
  node "$HERE/edge-ceiling.mjs" | tee "$RB/ceiling/ceiling.log"
log "done — results in $RB/ceiling"
