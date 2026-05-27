#!/usr/bin/env node
// Build a cross-platform, multi-runtime/multi-ABI daftari MCPB.
//
// Coverage matrix (better-sqlite3 native binaries):
//   Node    × ABI v127 (Node 22 LTS) × {darwin-arm64, win32-x64}
//   Node    × ABI v137 (Node 24 LTS) × {darwin-arm64, win32-x64}
//   Electron× ABI v140 (Electron 39) × {darwin-arm64, win32-x64}
//   Electron× ABI v143 (Electron 41) × {darwin-arm64, win32-x64}
//   Electron× ABI v145 (Electron 42) × {darwin-arm64, win32-x64}
//
// Why this script exists:
//   better-sqlite3 v12.10.0 ships one .node binary per (runtime, ABI,
//   platform, arch). The binary is ABI-bound via NODE_MODULE_VERSION —
//   process.versions.modules at runtime must match the value the binary
//   was built against, or the loader throws NODE_MODULE_VERSION mismatch.
//
//   Claude Desktop is an Electron app and spawns MCP servers inside its
//   bundled Electron Node runtime, where process.versions.modules
//   reflects the Electron ABI (e.g. 145 for Electron 42), not the
//   standalone Node ABI numbering (e.g. 137 for Node 24). For the same
//   MCPB to boot under (a) standalone Node via `npx daftari` and (b)
//   Claude Desktop's Electron Node, we stage binaries for every
//   (runtime, ABI) the user might encounter, under
//   Release-${platform}-${arch}-${modules}/ directories, and patch
//   better-sqlite3's loader to pick by process.platform, process.arch,
//   and process.versions.modules.
//
//   sharp resolves its native addon via @img/sharp-<platform>-<arch>
//   packages (NAPI-based, ABI-stable across Node + Electron versions).
//   One binary per platform covers everything. No loader patch needed.
//
//   onnxruntime-node already bundles all platforms; also NAPI, ABI-stable.
//
//   sqlite-vec is a loadable SQLite extension (.dll/.dylib), not a Node
//   addon — not ABI-bound at all. One binary per platform covers
//   everything.
//
// Idempotent: safe to re-run after `npm install`.

import { execSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
process.chdir(ROOT);

const BSQ_VERSION = '12.10.0'; // pinned: must match the version resolved by npm install
const SHARP_WIN32_VERSION = '0.34.5'; // pinned: must match sharp's optionalDependencies
const SQLITE_VEC_VERSION = '0.1.9'; // pinned: must match sqlite-vec's optionalDependencies

// (runtime, ABI, platform, arch) matrix — each row is one better-sqlite3
// binary we stage. ABI = NODE_MODULE_VERSION = process.versions.modules at
// runtime. Adding a new row is the way to add support for a new Node or
// Electron release: pick the appropriate ABI and the script does the rest.
//
// To find a runtime's ABI, run inside it:
//   node -e "console.log(process.versions.modules)"
const TARGETS = [
	// Node runtimes — for users running `npx daftari` standalone.
	{ runtime: 'node', abi: '127', platform: 'darwin', arch: 'arm64' }, // Node 22 LTS
	{ runtime: 'node', abi: '137', platform: 'darwin', arch: 'arm64' }, // Node 24 LTS
	{ runtime: 'node', abi: '127', platform: 'win32', arch: 'x64' },
	{ runtime: 'node', abi: '137', platform: 'win32', arch: 'x64' },
	// Electron runtimes — for users installing via Claude Desktop.
	{ runtime: 'electron', abi: '140', platform: 'darwin', arch: 'arm64' }, // Electron 39
	{ runtime: 'electron', abi: '143', platform: 'darwin', arch: 'arm64' }, // Electron 41
	{ runtime: 'electron', abi: '145', platform: 'darwin', arch: 'arm64' }, // Electron 42
	{ runtime: 'electron', abi: '140', platform: 'win32', arch: 'x64' },
	{ runtime: 'electron', abi: '143', platform: 'win32', arch: 'x64' },
	{ runtime: 'electron', abi: '145', platform: 'win32', arch: 'x64' },
];

const SQLITE_DIR = 'node_modules/better-sqlite3';
const DATABASE_JS = join(SQLITE_DIR, 'lib', 'database.js');

const SHARP_WIN32_DIR = 'node_modules/@img/sharp-win32-x64';
const SQLITE_VEC_WIN32_DIR = 'node_modules/sqlite-vec-windows-x64';

function stagedDir({ platform, arch, abi }) {
	return join(SQLITE_DIR, 'build', `Release-${platform}-${arch}-${abi}`);
}
function stagedBin(target) {
	return join(stagedDir(target), 'better_sqlite3.node');
}
function prebuildUrl({ runtime, abi, platform, arch }) {
	return `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BSQ_VERSION}/better-sqlite3-v${BSQ_VERSION}-${runtime}-v${abi}-${platform}-${arch}.tar.gz`;
}

function run(cmd, opts = {}) {
	console.log(`$ ${cmd}`);
	execSync(cmd, { stdio: 'inherit', ...opts });
}

function section(msg) {
	console.log(`\n=== ${msg} ===`);
}

// 1. Host sanity check. Pack runs on darwin-arm64 by convention — every
//    install/build/curl/tar path here is POSIX. To support a different host,
//    extend this script.
section('Verify host platform');
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error(
		`pack-mcpb.mjs must run on darwin-arm64 (current: ${process.platform}-${process.arch})`,
	);
}

// 2. Refresh deps and compile. We force-remove node_modules/better-sqlite3
//    first — npm install is a no-op on already-installed packages, so
//    without this step a prior pack run's in-tree edits to database.js
//    (and stale Release-*/ dirs) would survive into the new artifact.
section('Install + build');
rmSync(SQLITE_DIR, { recursive: true, force: true });
run('npm install');
run('npm run build');

// 2a. Drop devDependencies (typescript, vitest, vite, tsx, biome, etc.) and
//     their transitives from node_modules — they have no role at runtime
//     and shipping them bloats the .mcpb by ~75 MB and ~thousands of files.
//     The artifact size matters: large extension uninstalls hit ENOTEMPTY
//     races on Windows during Claude Desktop upgrades.
//
//     Order matters: prune BEFORE we extract the win32 tarballs below,
//     because npm prune removes packages it doesn't recognise as part of
//     the dep tree — and those tarballs aren't installed via npm, they're
//     curled in. If we pruned after, they'd be deleted.
section('Prune devDependencies');
run('npm prune --omit=dev');

// 3. Fetch every (runtime, ABI, platform, arch) prebuild directly from the
//    better-sqlite3 GitHub release. We don't use prebuild-install here
//    because we need to fetch *Electron* prebuilds in addition to Node
//    ones, and prebuild-install's runtime/target plumbing is unnecessary
//    when the tarball URL is constructible from the ABI alone. Each
//    tarball contains exactly one file: build/Release/better_sqlite3.node.
section(`Fetch better-sqlite3 prebuilds (${TARGETS.length} binaries)`);
for (const target of TARGETS) {
	const dir = stagedDir(target);
	const bin = stagedBin(target);
	if (existsSync(bin)) {
		console.log(`Already staged: ${bin}`);
		continue;
	}
	mkdirSync(dir, { recursive: true });
	const url = prebuildUrl(target);
	const tmp = mkdtempSync(join(tmpdir(), 'bsq-prebuild-'));
	try {
		run(`curl -sSfL ${url} | tar -xz -C ${tmp}`, { shell: '/bin/bash' });
		const extracted = join(tmp, 'build', 'Release', 'better_sqlite3.node');
		if (!existsSync(extracted)) {
			throw new Error(`Tarball did not contain build/Release/better_sqlite3.node: ${url}`);
		}
		renameSync(extracted, bin);
		console.log(
			`Staged ${bin} (${target.runtime}-v${target.abi}-${target.platform}-${target.arch})`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// 4. Patch lib/database.js so DEFAULT_ADDON loads from the platform+arch+ABI-
//    tagged directory rather than going through bindings(). One line.
//    Idempotent — marker comment guards against double-patching.
section('Patch better-sqlite3 loader');
const MARKER = '// PATCHED:cross-platform-mcpb';
let dbSrc = readFileSync(DATABASE_JS, 'utf8');
if (dbSrc.includes(MARKER)) {
	console.log('Already patched.');
} else {
	const original =
		"addon = DEFAULT_ADDON || (DEFAULT_ADDON = require('bindings')('better_sqlite3.node'));";
	const patched =
		'addon = DEFAULT_ADDON || (DEFAULT_ADDON = require(path.join(__dirname, "..", "build", `Release-${process.platform}-${process.arch}-${process.versions.modules}`, "better_sqlite3.node"))); ' +
		MARKER;
	if (!dbSrc.includes(original)) {
		throw new Error(`Could not find binding load site in ${DATABASE_JS}`);
	}
	dbSrc = dbSrc.replace(original, patched);
	writeFileSync(DATABASE_JS, dbSrc);
	console.log(`Patched ${DATABASE_JS}`);
}

// 5. Install @img/sharp-win32-x64 alongside the host's darwin-arm64 sharp.
//    Sharp resolves via require('@img/sharp-<platform>-<arch>/sharp.node'),
//    so as long as the package directory exists with the .node and DLLs,
//    sharp picks it on Windows. NAPI -> ABI-stable; one set covers Node 22,
//    Node 24, and every Electron. The Windows tarball bundles its own
//    libvips DLLs (no separate @img/sharp-libvips-win32-x64 needed at
//    runtime).
section('Install @img/sharp-win32-x64');
const sharpNode = join(SHARP_WIN32_DIR, 'lib', 'sharp-win32-x64.node');
if (existsSync(sharpNode)) {
	console.log('Already installed.');
} else {
	mkdirSync(SHARP_WIN32_DIR, { recursive: true });
	const tarball = execSync(
		`npm view @img/sharp-win32-x64@${SHARP_WIN32_VERSION} dist.tarball`,
		{ encoding: 'utf8' },
	).trim();
	console.log(`Downloading ${tarball}`);
	run(`curl -sSfL ${tarball} | tar -xz --strip-components=1 -C ${SHARP_WIN32_DIR}`, {
		shell: '/bin/bash',
	});
}

// 6. Install sqlite-vec-windows-x64 alongside the host's sqlite-vec-darwin-arm64.
//    sqlite-vec resolves via `import.meta.resolve('sqlite-vec-windows-x64/vec0.dll')`
//    (its own loader, see node_modules/sqlite-vec/index.mjs). SQLite
//    extensions are not Node addons / not ABI-bound — one binary per
//    platform covers all Node and Electron versions.
section('Install sqlite-vec-windows-x64');
const sqliteVecDll = join(SQLITE_VEC_WIN32_DIR, 'vec0.dll');
if (existsSync(sqliteVecDll)) {
	console.log('Already installed.');
} else {
	mkdirSync(SQLITE_VEC_WIN32_DIR, { recursive: true });
	const tarball = execSync(
		`npm view sqlite-vec-windows-x64@${SQLITE_VEC_VERSION} dist.tarball`,
		{ encoding: 'utf8' },
	).trim();
	console.log(`Downloading ${tarball}`);
	run(`curl -sSfL ${tarball} | tar -xz --strip-components=1 -C ${SQLITE_VEC_WIN32_DIR}`, {
		shell: '/bin/bash',
	});
}

section('Validate manifest');
run('npx --yes @anthropic-ai/mcpb validate manifest.json');

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const outFile = `daftari-${manifest.version}.mcpb`;
section(`Pack -> ${outFile}`);
run(`npx --yes @anthropic-ai/mcpb pack . ${outFile}`);

console.log(`\nDone. Artifact: ${outFile}`);
