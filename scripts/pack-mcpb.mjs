#!/usr/bin/env node
// Build a cross-platform, multi-ABI daftari MCPB.
//
// Targets:
//   darwin-arm64 × Node 22 (ABI v127)
//   darwin-arm64 × Node 24 (ABI v137)
//   win32-x64    × Node 22 (ABI v127)
//   win32-x64    × Node 24 (ABI v137)
//
// Why this script exists:
//   better-sqlite3 v12.10.0 ships one .node binary per (platform, arch, ABI)
//   and resolves it via the `bindings` package, which has no platform-/arch-
//   /ABI-aware default path. To ship a single MCPB that boots on both macOS
//   (arm64) and Windows (x64), under either Node 22 or Node 24, we stage all
//   four binaries under Release-${platform}-${arch}-${modules}/ directories
//   and patch better-sqlite3's loader to pick by process.platform,
//   process.arch, and process.versions.modules.
//
//   sharp resolves its native addon via @img/sharp-<platform>-<arch>
//   packages (NAPI-based, ABI-stable across Node versions), so we install
//   the win32 binary package alongside the darwin one — one set covers both
//   ABIs. No loader patch needed there.
//
//   onnxruntime-node already bundles all platforms; also NAPI, ABI-stable.
//
// Idempotent: safe to re-run after `npm install`.

import { execSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
process.chdir(ROOT);

const SHARP_WIN32_VERSION = '0.34.5'; // pinned: must match sharp's optionalDependencies
const SQLITE_VEC_VERSION = '0.1.9'; // pinned: must match sqlite-vec's optionalDependencies

// (platform, arch, ABI) matrix — each row is one binary we stage.
//   target  = Node version passed to prebuild-install (any patch in that major works)
//   modules = process.versions.modules value that selects this binary at runtime
const TARGETS = [
	{ platform: 'darwin', arch: 'arm64', target: '22.0.0', modules: '127' },
	{ platform: 'darwin', arch: 'arm64', target: '24.0.0', modules: '137' },
	{ platform: 'win32', arch: 'x64', target: '22.0.0', modules: '127' },
	{ platform: 'win32', arch: 'x64', target: '24.0.0', modules: '137' },
];

const SQLITE_DIR = 'node_modules/better-sqlite3';
const RELEASE_DIR = join(SQLITE_DIR, 'build', 'Release');
const RELEASE_BIN = join(RELEASE_DIR, 'better_sqlite3.node');
const DATABASE_JS = join(SQLITE_DIR, 'lib', 'database.js');

const SHARP_WIN32_DIR = 'node_modules/@img/sharp-win32-x64';
const SQLITE_VEC_WIN32_DIR = 'node_modules/sqlite-vec-windows-x64';

function stagedDir({ platform, arch, modules }) {
	return join(SQLITE_DIR, 'build', `Release-${platform}-${arch}-${modules}`);
}
function stagedBin(target) {
	return join(stagedDir(target), 'better_sqlite3.node');
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

// 3. Fetch every (platform, arch, ABI) prebuild. prebuild-install drops each
//    one at build/Release/, so we immediately move it to its tagged directory
//    before the next fetch overwrites it. After the loop, Release/ is wiped
//    so it can't shadow the staged copies at runtime.
section('Fetch better-sqlite3 prebuilds (4 binaries: 2 platforms × 2 ABIs)');
const PREBUILD_INSTALL = join(ROOT, 'node_modules', '.bin', 'prebuild-install');
for (const target of TARGETS) {
	const dir = stagedDir(target);
	const bin = stagedBin(target);
	if (existsSync(bin)) {
		console.log(`Already staged: ${bin}`);
		continue;
	}
	mkdirSync(dir, { recursive: true });
	if (existsSync(RELEASE_BIN)) rmSync(RELEASE_BIN);
	run(
		`${PREBUILD_INSTALL} --platform=${target.platform} --arch=${target.arch} --target=${target.target} --runtime=node --tag-prefix=v --force`,
		{ cwd: SQLITE_DIR },
	);
	if (!existsSync(RELEASE_BIN)) {
		throw new Error(
			`prebuild-install did not produce ${RELEASE_BIN} for ${JSON.stringify(target)}. Check network / release availability.`,
		);
	}
	copyFileSync(RELEASE_BIN, bin);
	console.log(`Staged ${bin} (Node ${target.target} / ABI v${target.modules})`);
}
if (existsSync(RELEASE_BIN)) {
	rmSync(RELEASE_BIN);
	console.log(`Removed ${RELEASE_BIN} (use Release-<platform>-<arch>-<abi>/ instead)`);
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
//    sharp picks it on Windows. NAPI -> ABI-stable; one set covers Node
//    22 and 24. The Windows tarball bundles its own libvips DLLs (no
//    separate @img/sharp-libvips-win32-x64 needed at runtime).
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
//    (its own loader, see node_modules/sqlite-vec/index.mjs), so as long as
//    the package directory exists with vec0.dll and a package.json, the
//    loader picks it on Windows. SQLite extensions are not NAPI / not ABI-
//    bound — one binary covers all Node versions.
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
