/**
 * The address maplibre-gl's worker is fetched from. Every map hands it to `setWorkerUrl` before its
 * first `new Map()`: `MapSection`, `CraftMap` and `MapPointPicker`'s `loadMapLibre`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WITHOUT THIS, maplibre-gl 6 HAS NO WORKER. Version 6 is ESM-only and starts its worker (the
 * thread that parses tiles and GeoJSON) from a real URL rather than a `blob:`. Left to itself it
 * derives that URL from its own `import.meta.url`, and gives up when that is not an http(s) address,
 * which inside a bundle it is not: the bundler substitutes the build machine's `file://` path. The
 * canvas then appears and nothing is ever drawn on it.
 *
 * Written as `new URL(<package path>, import.meta.url)`, the expression below is one webpack and
 * Turbopack both recognise: each copies the worker into the build as a hashed static asset and puts
 * that asset's public address here. It is the setup maplibre documents for Next.js.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The address is same-origin, so the Content-Security-Policy needs nothing for it: next.config.ts
 * sets no `worker-src`, `script-src` or `default-src`, and maplibre 5's `blob:` worker is gone.
 *
 * A module of its own because `lib/geo/basemap.ts` must stay importable without maplibre-gl, and so
 * does this: the `new URL` brings in one static file, not the library.
 */
export function maplibreWorkerUrl(): string {
  return new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString();
}
