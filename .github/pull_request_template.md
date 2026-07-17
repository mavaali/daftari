## Summary

<!-- What changed and why. Link the issue / spec / plan doc if one exists. -->

## Test plan

<!-- How this change was verified. Point at the tests that cover it. -->

- [ ] `npm run lint`, `npm run build`, `npm test` pass locally
- [ ] New behavior has tests (tests mirror `src/`; every tool gets a test file)

## Invariants

<!-- CLAUDE.md key decisions. Check what the diff touches; delete what it doesn't. -->

- [ ] Frontmatter stays the only metadata layer; the SQLite index stays derived/ephemeral
- [ ] Writes auto-commit via git; no separate versioning added
- [ ] Curation stays advisory (lint reports, tension logs — no auto-fix/resolve)
- [ ] Edge/tension visibility: omission over redaction, no existence leak, coarsened remainders
- [ ] Court/docket code takes no access context; no court surface exposed via MCP
- [ ] Error handling stays `Result<T, Error>`; no classes; no throws from tool handlers
