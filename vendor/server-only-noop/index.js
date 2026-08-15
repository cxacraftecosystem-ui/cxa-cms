/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `server-only`, deliberately inert — a checked-in stand-in for the real package.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * Thirty-five modules under lib/ begin with `import "server-only"`. That import is a MARKER: it is
 * never called and exports nothing. Its whole job is to make a build fail if one of those modules is
 * ever pulled into a client bundle, because they hold the database client, the session secret, the
 * password hasher and the storage credentials.
 *
 * Next never resolves this dependency. `node_modules/next/dist/build/create-compiler-aliases.js`
 * aliases the specifier away before resolution, differently per bundle — verified by reading it:
 *
 *     server build   'server-only$' -> 'next/dist/compiled/server-only/empty'   (a 0-byte file)
 *     client build   'server-only$' -> 'next/dist/compiled/server-only/index'   (throws on load)
 *
 * That asymmetry IS the guard: on the server the marker vanishes, and on the client it explodes at
 * module scope with "This module cannot be imported from a Client Component module."
 *
 * ⚠ BUT TWO SCRIPTS RUN UNDER PLAIN NODE, WHERE NO ALIAS EXISTS. `npm run seed` (tsx prisma/seed.ts)
 * and `npm run smoke` (tsx scripts/smoke.ts) both reach `server-only` for real — the seed through
 * `../lib/auth/password` and `../lib/search/index`, the smoke test through `../lib/pages`. Plain node
 * therefore has to find SOMETHING at that specifier, and it must be inert.
 *
 * ⚠ THE REAL PACKAGE CANNOT BE USED, AND THIS IS THE TRAP THIS DIRECTORY EXISTS TO DOCUMENT.
 * `server-only@0.0.1` ships two files behind an `exports` map:
 *
 *     "exports": { ".": { "react-server": "./empty.js", "default": "./index.js" } }
 *
 * `empty.js` is reachable ONLY under the `react-server` condition, which bundlers set and plain node
 * does not. So `npm i server-only` gives node the `default` entry — `index.js`, which is nothing but a
 * `throw`. Verified by execution, both module systems: `require("server-only")` and
 * `import "server-only"` each die at load. Declaring the real package would break `seed` and `smoke`
 * on EVERY machine, where today they break only on a freshly installed one. That is why the obvious
 * one-line fix is the wrong one, and why this directory is here instead.
 *
 * ⚠ WHAT THIS REPLACES. `node_modules/server-only` was previously a hand-made stub
 * (`0.0.0-local-test`) that `npm ls server-only` reported as **extraneous** — nothing declared it, so
 * `npm ci` deleted it and both scripts failed on a clean clone and in CI. This file is that stub, moved
 * somewhere version control keeps it and package.json declares it.
 *
 * ⚠ DO NOT "FIX" THIS BY DELETING THE MARKER IMPORTS IN lib/. Removing `import "server-only"` from
 * those modules would make this file unnecessary and would also remove the only thing preventing the
 * database client from being bundled into a browser. The marker is the feature; this is the shim that
 * lets a non-bundler read it.
 *
 * Kept as CommonJS with no `type` field so both `require` and `import` resolve it. The body must stay
 * empty: any export invites a caller, and a caller would be depending on a shim.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
module.exports = {};
