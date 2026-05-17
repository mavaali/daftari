# Contributing to Daftari

Thanks for your interest in Daftari. This guide covers how to set up, the
conventions the codebase follows, and how to get a change merged.

## Development setup

```bash
git clone https://github.com/mavaali/daftari.git
cd daftari
npm install
```

`npm install` runs the `prepare` script, which installs the Git pre-commit hook
(via Husky). The hook runs Biome on staged files before each commit.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run the Vitest suite |
| `npm run dev` | Run the MCP server in watch mode against `test/fixtures/sample-vault` |
| `npm run lint` | Check formatting and lint with Biome |
| `npm run lint:fix` | Apply Biome's safe fixes |

Before opening a pull request, `npm run build`, `npm run lint`, and `npm test`
must all pass. CI runs the same three on Node 20 and 22.

## Code conventions

- **Functions and types, no classes.** Daftari is written as plain functions
  and TypeScript types.
- **Errors are values.** Tool handlers and storage functions return
  `Result<T, Error>` rather than throwing — surface failures as values so
  callers branch explicitly.
- **Frontmatter is the metadata layer.** Every document is a markdown file with
  a YAML frontmatter block. There is no metadata store outside frontmatter.
- **The SQLite index is derived.** `.daftari/index.db` holds nothing the
  markdown files don't; it can be rebuilt from them at any time.
- **Git is the version layer.** Every write auto-commits. Don't add a separate
  versioning mechanism.
- **Tests mirror `src/`.** Every tool and module has a test file at the
  corresponding path under `test/`. Tests exercise real behavior — prefer real
  files and a real index over mocks.

## Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Keep each commit
focused on one change.

## Pull requests

1. Branch off `main`.
2. Make your change with tests; keep `build`, `lint`, and `test` green.
3. Open a PR against `main`. Describe what changed and why, and include a test
   plan. CI must pass before merge.

For a larger feature, a short design note in `docs/plans/` is welcome — it makes
review faster and records the reasoning behind the change.

## Reporting issues

Bugs and feature ideas go to
[GitHub Issues](https://github.com/mavaali/daftari/issues).

## License

By contributing, you agree that your contributions are licensed under the MIT
License, the same as the project.
