#!/usr/bin/env node
// Sync release metadata to package.json (slrf): server.json (MCP registry)
// and manifest.json (MCPB) get package.json's version, and manifest.json
// lists every registered tool. Run after `npm run build` — the tool list is
// read from dist/. test/release-metadata.test.ts fails CI on drift.
import { readFileSync, writeFileSync } from 'node:fs';
import { registeredTools } from '../dist/server.js';

const read = (f) => JSON.parse(readFileSync(f, 'utf-8'));
const write = (f, v) => writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
const { version } = read('package.json');

const server = read('server.json');
server.version = version;
for (const p of server.packages) p.version = version;
write('server.json', server);

// First sentence only: the MCPB listing wants a summary, not the full
// agent-facing tool prompt.
const summary = (d) => d.replace(/\s+/g, ' ').trim().split(/(?<=[.?!])\s/)[0];
const manifest = read('manifest.json');
manifest.version = version;
manifest.tools = registeredTools().map((t) => ({ name: t.name, description: summary(t.description) }));
write('manifest.json', manifest);

console.log(`release metadata synced to ${version} (${manifest.tools.length} tools)`);
