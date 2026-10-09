import * as LucideIcons from "lucide-react";
import { Microscope, type LucideIcon, type LucideProps } from "lucide-react";

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

const LUCIDE_EXPORTS = LucideIcons as unknown as Record<string, unknown>;

/** Every icon lucide ships, and nothing else — see the note on the component. */
const LUCIDE_ICONS: ReadonlySet<unknown> = new Set<unknown>(Object.values(LucideIcons.icons));

/**
 * A research area's icon, drawn from the lucide name stored on the row.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE WHOLE LUCIDE SET, RESOLVED BY NAME ON THE SERVER. `ResearchArea.icon` is a lucide name chosen in
 * the studio, so a curated shortlist here would draw the fallback for a perfectly valid choice — a
 * wrongness the editor cannot see. Only Server Components import this (the research index and the
 * research showcase block), so the namespace import costs the browser nothing: the icon is already an
 * inline `<svg>` in the HTML by the time it reaches a reader. Imported into a client component it
 * would put every lucide icon into that bundle — which is why the studio's picker and the feature grid
 * keep explicit maps instead.
 *
 * ⚠ A LUCIDE ICON IS AN OBJECT, NOT A FUNCTION. Every icon is built with `forwardRef`, which returns
 * an object, so the test this replaced — `typeof candidate === "function"` — was passed by no icon at
 * all, and every research area drew the Microscope fallback whatever had been chosen for it. Membership
 * of lucide's own `icons` map is the test now: it holds every icon and nothing else (not the `Icon`
 * base component, which needs an `iconNode` and throws without one; not the helpers), and the aliases
 * exported beside it — `BarChart3` for `ChartColumn`, the `…Icon` and `Lucide…` spellings — are the
 * very same objects, so an older name still draws.
 *
 * ⚠ A COMPONENT, NOT A FUNCTION THAT RETURNS ONE. A caller that wrote `const Icon = resolve(name)` and
 * then `<Icon />` would be handing React a component computed during render, which React's compiler
 * cannot tell from one created during render — a new type every time, remounted every time
 * (`react-hooks/static-components`). The glyph below is a lookup into the export map, which it can
 * see is the same component on every render.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function ResearchAreaIcon({
  name,
  ...props
}: Omit<LucideProps, "ref" | "name"> & { name: string | null }) {
  const key = name?.trim() ?? "";
  // PascalCase first: lucide's namespace also carries lowercase helpers (`createLucideIcon`, `icons`).
  const candidate = PASCAL_CASE.test(key) ? LUCIDE_EXPORTS[key] : undefined;
  const Glyph = LUCIDE_ICONS.has(candidate) ? (candidate as LucideIcon) : Microscope;
  return <Glyph {...props} />;
}
