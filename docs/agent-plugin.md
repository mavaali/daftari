# Daftari as a ChatGPT / Codex plugin

`plugins/daftari/` is an [Agent Plugins](https://agent-plugins.org) package:
a portable `plugin.json`, an `mcp.json` that starts Daftari locally over stdio,
and one skill (`daftari-memory`) that tells the agent when to search, write,
supersede, and leave contradictions alone. The repo root carries
`.agents/plugins/marketplace.json`, so the repository itself is a plugin
marketplace.

Everything runs on your machine. The plugin does not use a hosted server, and
it is not listed in the public Plugins Directory, which requires a public
HTTPS MCP endpoint.

## Install

Requires Node.js 20+ with `npx` available to the app.

**From GitHub (ChatGPT desktop app / Codex):**

```bash
codex plugin marketplace add mavaali/daftari
```

Restart the ChatGPT desktop app, open the Plugins Directory, choose the
**Daftari** source, and install the plugin.

**From a local checkout:** copy `plugins/daftari` into `~/.codex/plugins/`
and add an entry to `~/.agents/plugins/marketplace.json` pointing at it
(see `.agents/plugins/marketplace.json` for the entry shape).

Local MCP servers run in Codex CLI and Codex in the ChatGPT desktop app;
ChatGPT on the web cannot reach them.

## Where your memory lives

On first start the server scaffolds an empty vault (no example documents) at
`${PLUGIN_DATA}/vault` — a data directory the host keeps across plugin
updates. It is an ordinary Daftari vault: markdown plus Git, readable in any
editor and usable from any other MCP client via `daftari install`.

The server exposes the `standard` tool tier: search, read, write, append,
promote, supersede, deprecate, and provenance.

## Known limits

- Pointing the plugin at an existing vault is not supported yet; it always
  uses `${PLUGIN_DATA}/vault`.
- The manifests validate against the Agent Plugins 1.0.0 schemas. Other
  Agent Plugins clients (VS Code, Cursor, GitHub Copilot) should load the same
  package but have not been tested.
