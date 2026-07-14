#!/usr/bin/env bash
# Command 3 of 3 (see DEMO.md): import the LangMem store into a fresh vault,
# run the agent detection pass, machine-check every claim, render the graph.
# Commands 1-2: docker compose up -d && .venv/bin/python fixtures/populate.py all
set -euo pipefail
cd "$(dirname "$0")"

REPO="$(cd ../.. && pwd)"
DSN_RO="postgresql://daftari_ro:daftari_ro@localhost:5433/memories"

[ -f "$REPO/dist/cli.js" ] || { echo "run 'npm install && npm run build' at repo root first"; exit 1; }
[ -f .env ] || { echo "missing .env (OPENROUTER_API_KEY + OPENAI_API_KEY)"; exit 1; }

echo "== fresh vault =="
rm -rf vault
# --init refuses non-empty dirs, so scaffold first. Its scaffold-commit warns
# against the ENCLOSING repo (this vault dir is gitignored there) — cosmetic.
# The git init right after gives the vault its own history, so the import's
# commit lands in-vault, not in the enclosing repo (nested-worktree gotcha).
node "$REPO/dist/cli.js" --init ./vault >/dev/null 2>&1 || true
rm -rf vault/_drafts vault/competitive-intel vault/moonshot vault/pricing
git init -q vault

echo "== import (read-only DSN, realistic per-agent namespaces) =="
node "$REPO/dist/cli.js" import langgraph-store ./vault \
  --dsn "$DSN_RO" --namespace v1 --apply --yes --agent agent:demo-import
node "$REPO/dist/cli.js" --vault ./vault --reindex 2>&1 | tail -1

echo "== agent detection pass (gpt-5.2, one pair per judgment) =="
.venv/bin/python detect_tensions.py ./vault

echo "== machine-checked assertions =="
node assert-tensions.mjs ./vault

echo "== tension graph =="
node render-graph.mjs ./vault > tension-graph.mmd
echo "wrote tension-graph.mmd ($(grep -c '===\|-.-\|---|' tension-graph.mmd || true) edges)"

echo
echo "DONE. Evidence: tension-report.json, detect-report.json, tension-graph.mmd"
