# Berlin Bureau — hosted web app (Case 1: The Hollow King)

A self-serve, single-link way to play Case 1. Removes the human GM as the bottleneck: a player opens
the URL and plays the mole hunt against a hosted Game-Master. No accounts, no daftari install, no MCP.

## How it works

- **`app/`** — a Next.js (App Router) chat UI. The player types in plain language.
- **`app/api/gm/route.ts`** — server route that streams from OpenRouter with the GM system prompt.
  The **solution key lives here, server-side, and never reaches the browser.**
- **`lib/system-prompt.ts`** — composes the GM prompt: the GM engine (`gm-skill.md`), the full
  player-visible vault (held in context — the GM *simulates* the vault, answering searches/reads),
  and the hidden solution key for scoring.
- **`lib/game-content.generated.ts`** — GENERATED from the committed case files. Committed to git so
  Vercel builds from it directly (Vercel's root dir is `app/`, which excludes `../cases`).

The GM holds the whole vault in context rather than querying a live daftari instance — the lowest-
friction v1. If we later want the player driving *real* daftari tools, swap the in-context vault for a
hosted daftari MCP.

## Regenerate after changing the case

```bash
node scripts/build-prompt.mjs   # re-reads cases/case-01-vault + gm-skill.md + solution key
```

## Run locally

```bash
npm install
cp .env.example .env.local        # add your OPENROUTER_API_KEY
npm run dev                       # http://localhost:3000
```

## Deploy (Vercel)

- Root directory: `examples/berlin-bureau-game/app`
- Env vars: `OPENROUTER_API_KEY` (required), `OPENROUTER_MODEL` (optional; a strong model runs the GM
  better — verify a current slug at https://openrouter.ai/models).

## Caveat

A determined player can try to jailbreak the GM into leaking the solution key. For a casual adoption
demo that's acceptable — the answer isn't a secret worth hardening.
