/**
 * A bare `.css` import, as a SIDE EFFECT with no exported value.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NEEDED AT ALL. Next's own types declare `*.module.css` — a CSS Module, which exports a map of
 * generated class names — and say nothing about a plain stylesheet import. A plain one is legal and common:
 * the bundler extracts the file and the expression yields nothing. `tsc` has no way to know that, so
 * `await import("maplibre-gl/dist/maplibre-gl.css")` is TS2307, "cannot find module".
 *
 * `components/studio/fields/MapPointPicker.tsx` needs exactly that. MapLibre ships its stylesheet
 * separately from its JavaScript, and without it the canvas renders while every control on it — zoom,
 * compass, attribution — is unstyled. It is imported inside the same dynamic `Promise.all` as the library
 * so the two arrive together and neither is on the critical path of a page that never opens a map.
 *
 * ⚠ DELIBERATELY NARROW. This declares the SHAPE of a side-effect stylesheet import and nothing else — no
 * `any`, no default export that could be read by mistake. A wildcard returning `any` would also silence a
 * genuinely missing module, which is the error message this file exists to answer honestly.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
declare module "*.css" {
  /**
   * Empty on purpose. A stylesheet import contributes styles, not values, so there is nothing a caller may
   * legitimately read from it — and `{}` makes reading one a type error rather than `any`.
   */
  const stylesheet: Record<string, never>;
  export default stylesheet;
}
