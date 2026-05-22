# Privacy Policy

Daftari is a local MCP server. It runs on your machine, against vault files on
your machine. This document describes every place data does or does not leave
your computer.

## Data collection

Daftari does not collect, store, or transmit personal information. There is no
account, no signup, no telemetry, no analytics, no crash reporting, no usage
metrics, and no phone-home.

## Where vault data lives

All vault content — markdown files, frontmatter, the SQLite index, the
provenance log, the tension log, the curation log — lives on the local
filesystem at the path you choose. The MCP client (Claude Desktop, Claude
Code, any other client) reads and writes that data through Daftari, but the
data does not leave your machine through Daftari itself.

## Git

Daftari auto-commits every write to a local git repository inside the vault.
Those commits stay local unless you explicitly push them to a remote.

## Network calls

Daftari makes **no network calls** in its default configuration. The default
embedding provider (`local-minilm`) loads a small model and runs entirely
offline on CPU.

The only optional network egress is the OpenAI embedding provider. If — and
only if — you set `embeddings.provider: openai-3-small` in your vault's
`.daftari/config.yaml`, Daftari will:

- Send chunk text from your vault to OpenAI's `text-embedding-3-small`
  endpoint to generate embeddings.
- Authenticate using the `OPENAI_API_KEY` you supply in the environment.
- Use the returned vectors only for the vault's search index. They are not
  transmitted anywhere else.

Switching back to `local-minilm` (the default) restores fully-offline
operation.

No other Daftari code makes network requests.

## The MCP client

The MCP client that connects to Daftari (Claude Desktop, Claude Code, etc.)
is a separate program with its own privacy policy. Data your client sends to
its own backend — including content it has read from the vault — is governed
by the client's policy, not Daftari's.

## Third parties

Daftari has no third-party integrations beyond the optional OpenAI embedding
endpoint described above.

## Changes to this policy

Material changes will be noted in this file's git history and in the project
changelog.

## Contact

Questions, concerns, or reports: <https://github.com/mavaali/daftari/issues>
