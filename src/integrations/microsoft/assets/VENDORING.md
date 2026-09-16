# Vendoring `@azure/msal-browser` (Task U20)

`vendor/msal-browser/` and `vendor/msal-common/` under this directory are a
pruned, patched copy of `@azure/msal-browser`'s browser ESM build and its
`@azure/msal-common` dependency's browser ESM build. There is no build step
that reproduces this automatically — this file is the minimum record so a
future version bump can be redone by hand. A bead tracks turning the
one-off script below into a committed, repeatable vendoring script.

## Pinned version

`@azure/msal-browser@5.20.0` (devDependency only — never imported by any
server `.ts` file; it exists purely so `npm install` pulls down the source
this vendoring copies from `node_modules/`).

Chosen over the `^5.21.0` that `npm view` resolved to at the time because
this box's package-quarantine trust-gate blocks installing any package
version published in the last 3 days; `5.21.0` was ~10 hours old.  If you
bump the pin, check `npm view @azure/msal-browser time --json` and pick a
version old enough to clear the gate (or get it pre-approved).

## Entry points the module graph was walked from

- `node_modules/@azure/msal-browser/dist/index.mjs` (the package's own
  `"module"` entry — NOT `lib/msal-browser.cjs` (`"main"`, CJS) and NOT
  `lib/msal-browser.min.js` (a UMD bundle that exists but was not used here
  — it predates this survey and wasn't evaluated as an alternative to the
  modular-ESM approach below).
- `node_modules/@azure/msal-common/dist-browser/index-browser.mjs` (msal-
  common's `"./browser"` export condition — the browser-targeted build,
  distinct from its Node-targeted `dist/index.mjs`).

Both entries were walked recursively following only **relative** `import`/
`export ... from`/dynamic `import()` specifiers (`from './x.mjs'`, never a
bare package name), collecting every `.mjs` file transitively reachable.
This is NOT the whole package — it's exactly what `PublicClientApplication`'s
popup/silent/PKCE code paths pull in when actually evaluated as ES modules,
which is the same set a browser's own module loader would fetch.

Result: 78 files under `msal-browser/`, 71 under `msal-common/` (149 total,
~1.3MB). `.map` files were dropped (no sourcemaps vendored); each copied
file's `//# sourceMappingURL=...` comment was stripped so browsers don't spend
a request 404ing on it.

## Subtrees NOT vendored (never reachable from the walk above)

These exist in the real npm package but were never touched because nothing
in the `index.mjs` graph imports them — they back OTHER package export
conditions we don't use (`@azure/msal-browser/custom-auth`,
`/redirect-bridge`, `/popup-relay`) or are the CJS/UMD build entirely:

- `msal-browser`'s `lib/` (CJS + UMD, `"main"`/`"browser"` fields) — we use
  `dist/` (ESM) instead.
- `msal-browser/custom_auth/`, and anything only reachable via the
  `./custom-auth` export subpath — a separate, unused auth flow.
- `msal-browser/redirect_bridge/` and `msal-browser/popup_relay/` code paths
  reachable only from the `./redirect-bridge` / `./popup-relay` export
  subpaths (as opposed to the small subset of `popup_relay/` that IS
  reachable from the main entry and so IS vendored — see the file list under
  `vendor/msal-browser/popup_relay/` for exactly which).
- `msal-common`'s `dist/` (Node-targeted) and `lib/` (CJS) trees — we use
  `dist-browser/` only.
- Neither package's `types/` (`.d.ts`) — not needed at runtime, and this repo
  doesn't type-check vendored browser JS.

## The one bare specifier, patched

`msal-browser`'s `dist/index.mjs` (and everything under it that needs
msal-common) imports:

```js
import { Constants } from '@azure/msal-common/browser';
```

`@azure/msal-common/browser` is a bare package specifier — it resolves via
Node's/a bundler's package-exports algorithm, which a browser's native
`import` cannot do (no `node_modules` resolution, no `package.json` exports
field lookup). Every occurrence across the 78 vendored msal-browser files (43
files actually contained it) was replaced with a **relative** path computed
per-file to `vendor/msal-common/index-browser.mjs` — e.g. from
`vendor/msal-browser/app/PublicClientApplication.mjs` that's
`../../msal-common/index-browser.mjs`. After the patch, `grep -r
"@azure/msal-common/browser" vendor/` returns nothing (only harmless
`/*! @azure/msal-common vX.Y.Z */` header comments remain, which are not
specifiers). This was the ONLY bare specifier anywhere in the reachable
graph — msal-common's own dist-browser tree only ever imports itself via
relative paths.

## How to reproduce a version bump

There's no committed script yet (see the bead). The steps taken, in order,
to redo this by hand:

1. `npm install --save-dev @azure/msal-browser@<new-version>` (check the
   quarantine-gate note above first).
2. Walk the reachable-file algorithm above from both entry points (a short
   Node/Python script following only relative specifiers) into fresh
   `vendor/msal-browser/` and `vendor/msal-common/` directories, stripping
   `//# sourceMappingURL=` comments as you copy.
3. Replace every occurrence of `@azure/msal-common/browser` in the copied
   msal-browser files with the correct relative path to
   `vendor/msal-common/index-browser.mjs` from that file's own location.
4. Verify with `node --input-type=module -e "import('./vendor/msal-browser/index.mjs').then(m => console.log(Object.keys(m)))"`
   — this confirms the module graph resolves via Node's ESM resolver (the
   same relative-import algorithm a browser uses) with no error, before ever
   touching a real browser.
5. Re-run `test/integrations/microsoft-ui.test.ts` (asserts the asset route
   serves `vendor/msal-browser/index.mjs` and that it contains
   `PublicClientApplication`) and the probe-5 manual smoke.
