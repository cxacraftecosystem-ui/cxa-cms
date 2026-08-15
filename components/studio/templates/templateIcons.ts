/**
 * The glyphs the templates screens draw: one map for a TEMPLATE's own mark, one for a BLOCK's.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT OFFERS EXACTLY WHAT THE SCREENS CAN DRAW, AND NOTHING ELSE — the same discipline as
 * `components/studio/fields/IconPicker.tsx`, and for the same reason it states at length: a picker
 * offering more icons than the renderer knows lets an administrator choose one that silently becomes
 * the fallback square, which is a choice that appears to have been accepted and was not.
 *
 * ⚠ IT IS EXPLICIT, NOT `(Icons as Record<string, LucideIcon>)[name]`. A dynamic lookup into
 * `lucide-react` cannot be tree-shaken, so it would put all fifteen hundred icons into the bundle of
 * every screen that renders a template card. The same note is on `FeatureGridSection`.
 *
 * ⚠ NO `"use client"` AND NO `server-only`. It is imported by the templates list (a Server Component)
 * and by the editor (a client one), and a copy of the map in each is how the picker starts offering an
 * icon the list cannot draw.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A NAME THIS BUILD DOES NOT KNOW RESOLVES TO `LayoutTemplate`, never to nothing. lucide has renamed
 * whole families before — the section registry's `HelpCircle` is now `CircleHelp` — and payloads outlive
 * the code that wrote them, so a stored name that has gone must still draw something. An empty slot
 * where every other row has a glyph reads as a rendering fault.
 */

import {
  Award,
  BookMarked,
  BookOpen,
  BookOpenText,
  Building2,
  CalendarDays,
  ChartNoAxesCombined,
  CircleHelp,
  Columns2,
  Compass,
  Download,
  FileCheck,
  FileInput,
  FlaskConical,
  FolderKanban,
  Frame,
  GalleryHorizontal,
  GalleryHorizontalEnd,
  GraduationCap,
  Grid2x2,
  Handshake,
  History,
  IdCard,
  Images,
  Landmark,
  Layers,
  LayoutGrid,
  LayoutTemplate,
  Library,
  ListChecks,
  Mail,
  Map as MapIcon,
  Megaphone,
  Microscope,
  MousePointerClick,
  MoveVertical,
  Newspaper,
  NotebookPen,
  PanelTop,
  Presentation,
  Quote as QuoteIcon,
  School,
  ScrollText,
  Signpost,
  Square,
  Telescope,
  TextQuote,
  TrendingUp,
  Type,
  UserRoundSearch,
  Users,
  Video,
  Workflow,
  type LucideIcon
} from "lucide-react";

/**
 * The closed set, in the order the picker offers it: the general shapes first, then teaching, then
 * research, then the record-keeping kinds. Every icon the nine built-in templates declare is in here,
 * so a built-in and a template somebody wrote are drawn from one list.
 */
const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  LayoutTemplate,
  Frame,
  Landmark,
  Building2,
  Signpost,

  GraduationCap,
  School,
  Presentation,
  Users,
  IdCard,
  UserRoundSearch,

  Microscope,
  FlaskConical,
  Telescope,
  Compass,
  Layers,

  Newspaper,
  NotebookPen,
  TextQuote,
  BookMarked,
  Library,
  ScrollText,

  FileCheck,
  ChartNoAxesCombined,
  FolderKanban,
  CalendarDays,
  Images,
  Megaphone,
  Handshake,
  Award,
  Mail
};

/** Every name a template may store, in picker order. */
export const TEMPLATE_ICON_NAMES: readonly string[] = Object.keys(TEMPLATE_ICONS);

/**
 * The glyph for a stored name. Never throws and never returns undefined — see the header.
 *
 * ⚠ ASKED WITH `hasOwnProperty`, exactly as `isKnownTemplateIcon()` below asks it, because it is the
 * same question and two ways of asking it eventually disagree. A bare `TEMPLATE_ICONS[name]` answers
 * `"toString"` with a function off `Object.prototype` and `"__proto__"` with an object — both truthy,
 * so the fallback never fires and React is handed something that is not a component. The PATCH
 * handler's `^[A-Z][A-Za-z0-9]*$` keeps those names out of the column today, but a renderer that
 * depends on a validator two modules away for whether it throws is one schema change from a blank
 * studio screen.
 */
export function templateIcon(name: string): LucideIcon {
  const wanted = name.trim();
  return Object.prototype.hasOwnProperty.call(TEMPLATE_ICONS, wanted)
    ? (TEMPLATE_ICONS[wanted] ?? LayoutTemplate)
    : LayoutTemplate;
}

/** True when the name is one this build can draw. Used to warn about a stored name that has gone. */
export function isKnownTemplateIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_ICONS, name.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Block glyphs, for the two Server Components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A glyph per block TYPE, by the icon name `lib/sections/registry.ts` declares.
 *
 * ⚠ NOT imported from `sectionIcon()` in components/studio/builder/SectionCard.tsx, which holds the same
 * map. That module is `"use client"`, and every export of a client module becomes a client reference in
 * the server graph — calling one from a Server Component throws at request time. So it is restated here,
 * in a module a Server Component may import, rather than in each of the two screens that need it.
 *
 * ⚠ EVERY TYPE IN THE REGISTRY, not only the ones the built-in templates use. An administrator writing a
 * template can reach for any block in the palette, so a shorter map would draw plain squares down half of
 * somebody's own arrangement.
 *
 * ⚠ `HelpCircle` is the registry's spelling and lucide has since renamed the export to `CircleHelp`. The
 * registry is the contract, so it is this map that adapts — both spellings are answered.
 */
const BLOCK_ICONS: Record<string, LucideIcon> = {
  PanelTop,
  MoveVertical,
  Type,
  TrendingUp,
  LayoutGrid,
  History,
  Quote: QuoteIcon,
  MousePointerClick,
  HelpCircle: CircleHelp,
  CircleHelp,
  Mail,
  FileInput,
  ListChecks,
  Grid2x2,
  Microscope,
  FolderKanban,
  Users,
  BookOpen,
  Newspaper,
  CalendarDays,
  Handshake,
  Compass,
  Download,
  Images,
  Columns2,
  Video,
  Map: MapIcon,
  BookOpenText,
  GalleryHorizontalEnd,
  GalleryHorizontal,
  Workflow
};

/**
 * The glyph for a block type's registry icon name.
 *
 * Falls back to a plain square rather than to nothing: an empty slot where every other row has a glyph
 * reads as a rendering fault, and a block type added by a newer version of this software is a thing that
 * genuinely happens.
 *
 * ⚠ `hasOwnProperty` for the same reason as `templateIcon()` above: a plain object literal answers the
 * `Object.prototype` names truthily, so a bare index would return a function where a component belongs.
 */
export function blockIcon(iconName: string): LucideIcon {
  return Object.prototype.hasOwnProperty.call(BLOCK_ICONS, iconName)
    ? (BLOCK_ICONS[iconName] ?? Square)
    : Square;
}

/** "ChartNoAxesCombined" → "Chart no axes combined". What the picker reads out under each glyph. */
export function humaniseTemplateIcon(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return spaced.length > 0 ? `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}` : name;
}
