#!/usr/bin/env node
// Build a cross-platform daftari MCPB (darwin-arm64 + win32-x64).
//
// Why this script exists:
//   better-sqlite3 v12.10.0 ships exactly one native binary (.node) per
//   install — for the host platform — and resolves it via the `bindings`
//   package, which has no platform/arch-aware default path. To ship a
//   single MCPB that boots on both macOS (arm64) and Windows (x64), we
//   stage both binaries under platform-tagged directories and patch
//   better-sqlite3's loader to pick by process.platform + process.arch.
//
//   sharp resolves its native addon via @img/sharp-<platform>-<arch>
//   packages, so we just install the win32 binary package alongside the
//   darwin one — no loader patch needed there.
//
//   onnxruntime-node already bundles all platforms.
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

const SQLITE_DIR = 'node_modules/better-sqlite3';
const RELEASE_DIR = join(SQLITE_DIR, 'build', 'Release');
const RELEASE_BIN = join(RELEASE_DIR, 'better_sqlite3.node');
const DARWIN_DIR = join(SQLITE_DIR, 'build', 'Release-darwin-arm64');
const DARWIN_BIN = join(DARWIN_DIR, 'better_sqlite3.node');
const WIN_DIR = join(SQLITE_DIR, 'build', 'Release-win32-x64');
const WIN_BIN = join(WIN_DIR, 'better_sqlite3.node');
const DATABASE_JS = join(SQLITE_DIR, 'lib', 'database.js');

const SHARP_WIN32_DIR = 'node_modules/@img/sharp-win32-x64';

function run(cmd, opts = {}) {
	console.log(`$ ${cmd}`);
	execSync(cmd, { stdio: 'inherit', ...opts });
}

function section(msg) {
	console.log(`\n=== ${msg} ===`);
}

// 1. Host sanity check. The Release/ binary is the host's; we only know how
//    to ship a single host shape (darwin-arm64). To support a different host,
//    extend this script.
section('Verify host platform');
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error(
		`pack-mcpb.mjs must run on darwin-arm64 (current: ${process.platform}-${process.arch})`,
	);
}

// 2. Refresh deps and compile. The npm install also resets any in-tree edits
//    inside node_modules (notably the database.js patch from a prior run), so
//    each pack starts from a clean baseline.
section('Install + build');
run('npm install');
run('npm run build');

// 3. Stage darwin-arm64 better-sqlite3 binary out of Release/.
section('Stage better-sqlite3 darwin-arm64 binary');
mkdirSync(DARWIN_DIR, { recursive: true });
if (existsSync(RELEASE_BIN)) {
	copyFileSync(RELEASE_BIN, DARWIN_BIN);
	console.log(`Copied ${RELEASE_BIN} -> ${DARWIN_BIN}`);
} else if (existsSync(DARWIN_BIN)) {
	console.log('Already staged.');
} else {
	throw new Error(
		`No darwin binary found at ${RELEASE_BIN} or ${DARWIN_BIN}. Run 'npm install' on darwin-arm64 first.`,
	);
}

// 4. Fetch win32-x64 prebuild. prebuild-install drops it at Release/, so we
//    immediately move it to Release-win32-x64/ and then wipe Release/ so it
//    can't shadow our staged copies at runtime.
section('Fetch better-sqlite3 win32-x64 prebuild');
mkdirSync(WIN_DIR, { recursive: true });
const PREBUILD_INSTALL = join(ROOT, 'node_modules', '.bin', 'prebuild-install');
run(`${PREBUILD_INSTALL} --platform=win32 --arch=x64 --tag-prefix=v --force`, {
	cwd: SQLITE_DIR,
});
if (!existsSync(RELEASE_BIN)) {
	throw new Error(
		`prebuild-install did not produce ${RELEASE_BIN}. Check network / release availability.`,
	);
}
copyFileSync(RELEASE_BIN, WIN_BIN);
console.log(`Copied ${RELEASE_BIN} -> ${WIN_BIN}`);
rmSync(RELEASE_BIN);
console.log(`Removed ${RELEASE_BIN} (use Release-<platform>-<arch>/ instead)`);

// 5. Patch lib/database.js so DEFAULT_ADDON loads from the platform-tagged
//    directory rather than going through bindings(). One line. Idempotent.
section('Patch better-sqlite3 loader');
const MARKER = '// PATCHED:cross-platform-mcpb';
let dbSrc = readFileSync(DATABASE_JS, 'utf8');
if (dbSrc.includes(MARKER)) {
	console.log('Already patched.');
} else {
	const original =
		"addon = DEFAULT_ADDON || (DEFAULT_ADDON = require('bindings')('better_sqlite3.node'));";
	const patched =
		'addon = DEFAULT_ADDON || (DEFAULT_ADDON = require(path.join(__dirname, "..", "build", `Release-${process.platform}-${process.arch}`, "better_sqlite3.node"))); ' +
		MARKER;
	if (!dbSrc.includes(original)) {
		throw new Error(`Could not find binding load site in ${DATABASE_JS}`);
	}
	dbSrc = dbSrc.replace(original, patched);
	writeFileSync(DATABASE_JS, dbSrc);
	console.log(`Patched ${DATABASE_JS}`);
}

// 6. Install @img/sharp-win32-x64 alongside the host's darwin-arm64 sharp.
//    Sharp resolves via require('@img/sharp-<platform>-<arch>/sharp.node'),
//    so as long as the package directory exists with the .node and DLLs,
//    sharp picks it on Windows. The Windows tarball bundles its own libvips
//    DLLs (no separate @img/sharp-libvips-win32-x64 needed at runtime).
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

// 7. Validate manifest and pack.
section('Validate manifest');
run('npx --yes @anthropic-ai/mcpb validate manifest.json');

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const outFile = `daftari-${manifest.version}.mcpb`;
section(`Pack -> ${outFile}`);
run(`npx --yes @anthropic-ai/mcpb pack . ${outFile}`);

console.log(`\nDone. Artifact: ${outFile}`);
