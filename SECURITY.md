# Security Policy

## Supported versions

Daftari ships from `main` and only the latest published release receives
security fixes.

| Version        | Supported |
|----------------|-----------|
| Latest release | Yes       |
| Older releases | No        |

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

Report vulnerabilities privately through GitHub's advisory flow:
[Report a vulnerability](https://github.com/mavaali/daftari/security/advisories/new).
Private vulnerability reporting is enabled for this repository, so the report
is visible only to the maintainer until a fix is released.

Include what you can of:

- A description of the issue and its impact
- Steps to reproduce, ideally against a fresh vault (`daftari init`)
- The daftari version (`npm ls daftari` or the `.mcpb` filename) and Node version
- Whether the issue requires operator access, a configured principal, or no
  access at all

You should receive an acknowledgment within a few days. Fixes for confirmed
vulnerabilities are released as a patch version and noted in `CHANGELOG.md`;
credit is given in the advisory unless you ask otherwise.

## Scope

Daftari is an MCP server that exposes a local markdown vault to AI agents.
Reports are especially welcome for:

- **Access-control bypass** — reading or writing documents past RBAC rules or
  collection boundaries declared in `.daftari/config.yaml`
- **Existence disclosure** — tension, edge, lint, or search surfaces revealing
  the existence or count of documents a principal cannot read (see
  `docs/superpowers/specs/2026-07-14-edge-graph-existence-disclosure-design.md`)
- **Path traversal** — any tool reading or writing outside the vault root
- **`daftari serve` transport issues** — auth bypass, or reaching a vault
  off-loopback without the documented `transport_security: external` opt-in
- **Court surface leakage** — operator-only Tension Court data reachable
  through any MCP tool

Out of scope:

- Anything requiring operator access (CLI on the vault host) — the operator is
  trusted by design
- Prompt-injection payloads stored *in* vault content; Daftari serves the
  markdown it is given, and content trust is the calling agent's concern
- Vulnerabilities only in dependencies with no exploitable path through
  Daftari (report those upstream; Dependabot tracks updates)

## Release integrity

Releases are published to npm via GitHub Actions
[trusted publishing](https://docs.npmjs.com/trusted-publishers) with
provenance — no long-lived npm tokens exist. You can verify a package with
`npm audit signatures`.
