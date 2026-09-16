# Privacy Policy

Daftari is a local MCP server. It runs on your machine, against vault files on
your machine. This document describes every place data does or does not leave
your computer.

## Data collection

Daftari does not operate a hosted service or collect personal information for
itself. There is no account, signup, telemetry, analytics, crash reporting,
usage metrics, or phone-home. Daftari does process whatever content you give
it; explicitly configured network features may transmit relevant content to
the providers named below.

## Where vault data lives

By default, all vault content — markdown files, frontmatter, the SQLite index,
the provenance log, the tension log, the curation log — lives on the local
filesystem at the path you choose. The MCP client (Claude Desktop, Claude
Code, any other client) reads and writes that data through Daftari. Content
leaves the machine through Daftari only when you explicitly use one of the
network-backed features described below.

## Git

Daftari auto-commits every write to a local git repository inside the vault.
Those commits stay local unless you explicitly push them to a remote.

## Network calls

Daftari makes **no network calls** in its default configuration. The default
embedding provider (`local-minilm`) loads a small model and runs entirely
offline on CPU. Network egress requires an explicit provider configuration or
an explicitly invoked network-backed command.

### OpenAI embeddings

If — and only if — you set `embeddings.provider: openai-3-small` in your
vault's `.daftari/config.yaml`, Daftari will:

- Send chunk text from your vault to OpenAI's `text-embedding-3-small`
  endpoint to generate embeddings.
- Authenticate using the `OPENAI_API_KEY` you supply in the environment.
- Use the returned vectors only for the vault's search index. They are not
  transmitted anywhere else.

Switching back to `local-minilm` (the default) restores fully-offline
embedding and search operation.

### LLM-backed workflows and distill

LLM-backed workflows use Anthropic (the default transport) or OpenRouter when
you explicitly select that transport. They authenticate with the
`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` supplied in your environment.
Commands such as eval, configured sleep/consolidate passes, and
`daftari distill --propose` can send vault or source text to that provider.
`daftari distill --plan` makes no LLM call.

For distill specifically, normalized source chunks transit the synthesis
provider so it can extract claims. Daftari does not write the raw source inside
the vault, even transiently, and retains only staged/ratified claims plus local
operator telemetry. That distill-and-discard boundary limits **Daftari's** raw
source retention; it does not control the provider's retention. Provider-side
retention and training are governed by the selected provider and your account
terms. The `--zdr` flag records the operator's zero-data-retention assertion in
the local, gitignored run receipt; it does not technically enforce provider
behavior.

A `distill:<source-id>#<claim-key>` source reference is an audit breadcrumb,
not stored source material and not a re-derivation source. Re-derivation
requires presenting the original source to a new run.

### Storage sync

If you configure an S3-compatible or Azure storage backend and explicitly run
`daftari sync`, Daftari sends vault backup objects to that backend. The local
git working copy remains canonical. A filesystem (`fs`) backend stays local.

## The MCP client

The MCP client that connects to Daftari (Claude Desktop, Claude Code, etc.)
is a separate program with its own privacy policy. Data your client sends to
its own backend — including content it has read from the vault — is governed
by the client's policy, not Daftari's.

## Third parties

Daftari has no telemetry or analytics integrations. Optional data processors
are the providers you explicitly configure: OpenAI for remote embeddings,
Anthropic or OpenRouter for LLM-backed workflows, and an S3-compatible or Azure
provider for remote storage sync. Their handling of transmitted data is
governed by their policies and your account terms.

## Changes to this policy

Material changes will be noted in this file's git history and in the project
changelog.

## Contact

Questions, concerns, or reports: <https://github.com/mavaali/daftari/issues>
