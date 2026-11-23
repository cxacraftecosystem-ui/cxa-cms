/**
 * The loaders of the page builder's code-split pieces, by export name, so a client-side navigation can
 * start them all at once (`PreloadIslands` in lazy-islands.tsx; which block uses which piece is in
 * lib/sections/block-islands.ts).
 *
 * ⚠ THE LOADER MUST BE THE ONE `dynamic()` ITSELF CALLS. Next matches the `import()` written inside a
 * `dynamic()` call to that call's chunks (node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md),
 * and Turbopack compiles it to a loader of its own, which fetches DIFFERENT chunk files from a plain
 * `import()` of the same module elsewhere. Measured: a separate table of plain `import()`s fetched every
 * piece within 6 ms of the click and the page then fetched its own copies one after another anyway. So
 * each `dynamic()` call passes its loader through `island()`, written inside the call, which records it
 * here and hands it back unchanged.
 */

const LOADERS = new Map<string, () => Promise<unknown>>();

/** Records `loader` under `name` (the export it becomes) and returns it untouched, for `dynamic()`. */
export function island<T>(name: string, loader: () => Promise<T>): () => Promise<T> {
  LOADERS.set(name, loader);
  return loader;
}

/**
 * Starts the named pieces' chunks. Calling a loader is what `dynamic()` does when it first renders the
 * piece; the bundler keeps one request per chunk, so calling it early only moves that request forward.
 * A failed fetch is left to surface where it matters, when the piece itself renders and calls again.
 */
export function preloadIslands(names: readonly string[]): void {
  for (const name of names) LOADERS.get(name)?.().catch(() => {});
}
