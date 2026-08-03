# Case 0 — The Dead Drop (tutorial)

The on-ramp case. A cold player learns the daftari loop on a small, honest problem before facing
Case 1's disinformation trap. **No frame, no plant** — every report is filed truthfully; one is
just weak and mistaken.

**Question:** which of three dead-drop sites (site-4 / site-7 / site-9) will the walk-in service
tonight?

**The loop it teaches:**
1. **Grade** every source (Admiralty code in each report's `source_reliability`).
2. **Notice the contradiction** — SPARROW (B2) says site-7, WREN (D4) says site-4.
3. **Hold it as a tension** instead of picking the higher grade — file `tensions/dead-drop-site.md`.
4. **Find an independent corroborator** — the A2 signals intercept, tied to neither courier.
5. **Clear the verification gate** — two independent sources on site-7 promote `working → evergreen`.
6. **Deduce** — site-7 is corroborated; site-4 stays an uncredited open reading; site-9 was never
   asserted. Answer: **site-7**, with the work shown.

## Files
- `WIKI.md` — the schema (same as the full Berlin Bureau) + the tutorial in one screen.
- `field-reports/fr-t01-sparrow-site7.md` — SPARROW, B2, site-7.
- `field-reports/fr-t02-wren-site4.md` — WREN, D4, site-4 (honest but mistaken).
- `field-reports/fr-t03-sigint-site7.md` — independent A2 intercept, site-7 (the resolver).
- `tensions/dead-drop-site.md` — the site-7-vs-site-4 contradiction (resolvable, not sacred).
- `seed.mjs` — builds the live indexed vault + logs the tension.

## Seeding
```bash
node seed.mjs /path/to/target-vault
# then: node $DAFTARI_REPO/dist/cli.js --vault /path/to/target-vault --user player --role player
```
