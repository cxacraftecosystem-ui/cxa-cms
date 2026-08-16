"use client";

/**
 * SectionCard — one block in the page builder's list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DRAG HANDLE IS ITS OWN BUTTON, AND THE CARD IS NOT DRAGGABLE.
 *
 * A card that starts dragging when you meant to click it is a card you cannot select: the pointer
 * moves three pixels between the press and the release — which every trackpad does — and the click
 * that was going to open the block's settings becomes a reorder nobody asked for. So the row is four
 * separate controls in a line: the handle, the title (which selects), the visibility toggle, and the
 * menu. Only the handle carries the drag listeners.
 *
 * The handle is a real `<button type="button">` with a name that says what it is FOR and how to work
 * it from the keyboard, because drag-and-drop is the least accessible interaction pattern in any CMS
 * and the keyboard route has to be discoverable rather than merely present. Every reorder is also in
 * the menu as Move up and Move down — see SectionList, which owns that arithmetic.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE SUMMARY LINE SAYS WHAT IS IN THE BLOCK, NEVER WHAT KIND OF BLOCK IT IS. The kind is already on
 * the row, in words, beside its icon; repeating it as "Hero banner · Hero banner" spends the one line
 * a builder scans down the page on nothing. So the summary is the headline, the number of figures, the
 * address, the quotation — the thing that tells an administrator which of four text blocks this is.
 *
 * A BLOCK WHOSE SETTINGS DO NOT VALIDATE IS MARKED, NOT DISABLED. This is the recovery path when a
 * block type gains a rule its saved content does not satisfy, and it must never be a dead card: the
 * problem is stated in plain words on the row, and every control on the row still works, so the person
 * who has to fix it can open it and fix it. A card that refuses to open is a page that can only be
 * repaired in the database.
 *
 * THE POSITION IS ON SCREEN as "3 of 7". Move up and Move down otherwise produce no visible change at
 * all for a reader who cannot see the list reflow — and the number is a static fact, so it survives
 * reduced motion, which a movement never does (contract §1.4).
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  BookOpenText,
  CalendarDays,
  CircleHelp,
  Columns2,
  Columns3,
  Compass,
  MapPin,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileInput,
  FileText,
  FolderKanban,
  GalleryHorizontal,
  GalleryHorizontalEnd,
  Grid2x2,
  GripVertical,
  Handshake,
  History,
  Images,
  LayoutGrid,
  ListChecks,
  Mail,
  Map as MapIcon,
  Microscope,
  MousePointerClick,
  MoveVertical,
  Newspaper,
  PanelTop,
  Pencil,
  Quote as QuoteIcon,
  Square,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Type,
  Users,
  Video,
  Workflow,
  type LucideIcon
} from "lucide-react";
import type { CSSProperties } from "react";
import type { SectionType } from "@prisma/client";

import { cn, truncateWords } from "@/lib/utils";
import { SECTION_META, SECTION_REGISTRY, sectionLabel, type SectionMeta } from "@/lib/sections/registry";
import { Badge } from "@/components/ui/Badge";
import { RowActions, type RowAction } from "@/components/studio/RowActions";

// ─────────────────────────────────────────────────────────────────────────────
// The shape the whole builder passes around
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row of `PageSection`, as the builder holds it.
 *
 * Written out rather than imported from `@prisma/client` for two reasons. The Prisma row carries
 * `createdAt`/`updatedAt` as `Date`s, which arrive over HTTP as strings — so a component typed against
 * the Prisma row would be lying about the values it actually receives from `lib/client/fetcher.ts`.
 * And the builder needs none of them: it needs the identity, the kind, the order, the editor's name for
 * the block, its settings and whether it is switched on.
 *
 * `data` is `unknown` on purpose. It is a JSON column, so it is whatever was last written to it —
 * possibly by an older version of the block's rules. Every read of it goes through
 * `parseSectionData()`; nothing in the builder may assume a shape it has not checked.
 */
export interface BuilderSection {
  id: string;
  type: SectionType;
  /** Dense and 0-based, as `prisma/schema.prisma` documents. The array order is what the screen shows. */
  position: number;
  /** The editor's own name for this block. Never rendered on the public site. */
  label: string | null;
  data: unknown;
  isVisible: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the registry safely
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The registry entry for a block type, with a fallback for a type this build has never heard of.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY NOT `sectionMeta()`. That function indexes `SECTION_REGISTRY` directly, which is exactly right for
 * a value TypeScript has proved to be a `SectionType`. In the builder the value arrives from the
 * DATABASE: a `PageSection` row written by a newer release and then read after a rollback carries a
 * `type` that is not in this build's enum at all. `SECTION_REGISTRY[thatType]` is `undefined`, and reading
 * `.label` off it throws — taking the whole builder down, with the editor's unsaved work behind it, in the
 * one situation the recovery path exists to survive.
 *
 * The fallback is honest rather than blank: `sectionLabel()` gives the raw value, so a reader can at least
 * say what they are looking at when they report it (an "Unknown block" tells them nothing at all).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function safeSectionMeta(type: SectionType): SectionMeta {
  const known = (SECTION_REGISTRY as Record<string, SectionMeta | undefined>)[type];
  if (known) return known;
  return {
    type,
    label: sectionLabel(type),
    description:
      "This version of the site does not recognise this kind of block. It was most likely added by a newer version. Nothing in it has been lost.",
    icon: "",
    group: "Content",
    allowMultiple: true
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The lucide components for the icon NAMES in `lib/sections/registry.ts`.
 *
 * The registry stores its icon as a string so that a route handler or a seed script can import it
 * without dragging an icon set along; resolving the string is the palette's job, and this is where it
 * happens. Keyed by the registry's spelling rather than by `SectionType`, so the registry stays the one
 * place that decides which glyph a block gets — a second map keyed by type would silently disagree
 * with it the first time somebody changed one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS MAP HAS TO COVER THE REGISTRY, AND NOTHING IN TYPESCRIPT WILL TELL YOU WHEN IT STOPS.
 *
 * It shipped once with seven of the registry's names missing — `ListChecks`, `FileInput`, `Grid2x2`
 * and the four "Story" glyphs — and the symptom was that seven blocks drew the fallback square in the
 * builder AND in the palette, in a studio where every other row carries a distinct glyph. A square is
 * not nothing, which is precisely why nobody reported it as a fault.
 *
 * The obvious guard — deriving the key type from the registry, `(typeof SECTION_REGISTRY)[…]["icon"]`
 * — does NOT work, and it is worth knowing why before somebody tries it again. `SECTION_REGISTRY` is
 * declared with `satisfies Record<SectionType, SectionMeta>`, and `SectionMeta.icon` is `string`; a
 * property contextually typed by `string` has its literal widened, so that type resolves to `string`
 * and a `Record<string, LucideIcon>` proves nothing. Making it work would mean changing the registry's
 * own declaration, and the registry is not this file's to reshape.
 *
 * So the coverage check below runs at module load, in development only, and NAMES the blocks that
 * would draw the fallback. It is not the compile error one would want, but it is loud, it is
 * exhaustive over the registry by construction (`SECTION_META` is built from it), and it fires the
 * first time anybody opens the builder after adding a block.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ `HelpCircle` is the registry's spelling and lucide has since renamed the export to `CircleHelp`.
 * Both names are here for that reason: the registry is the contract, so it is the map that adapts.
 *
 * Named imports rather than lucide's `icons` bundle — that object pulls all fourteen hundred glyphs
 * into the studio bundle to use thirty of them.
 */
const SECTION_ICONS: Record<string, LucideIcon> = {
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
  // The "Story" group. `GalleryHorizontal` and `GalleryHorizontalEnd` are different glyphs and are
  // deliberately not interchangeable: the "End" one shows a card running off the edge, which is the
  // photograph band, and the plain one shows an even row, which is the rail.
  BookOpenText,
  GalleryHorizontalEnd,
  GalleryHorizontal,
  Workflow,
  // Platform pillars: three columns, which is what the block is.
  Columns3,
  // Map of India: a pin, which is what the block puts on the country.
  MapPin,
  // The document block. A page with lines on it, which is what it puts on the page — and it is
  // deliberately NOT `Download`: that glyph belongs to the Downloads block, which is a list of files
  // to take away, and two blocks wearing one icon is how an editor adds the wrong one.
  FileText
};

/**
 * The glyph a block type falls back to when its registry name is not in the map above.
 *
 * A visible neutral square, never nothing: an empty slot where every other row has an icon reads as a
 * rendering fault, and a square reads as "this block has no picture yet", which is true. It is also
 * what the coverage check below is looking for.
 */
const FALLBACK_ICON: LucideIcon = Square;

/**
 * Every registry entry whose icon name this map cannot resolve.
 *
 * Exported so a future test — or a screen that wants to say it out loud rather than log it — can ask
 * the same question, and computed from `SECTION_META`, which is built by flattening the registry and
 * is therefore exhaustive over it by construction.
 */
export function unresolvedSectionIcons(): SectionMeta[] {
  return SECTION_META.filter((meta) => SECTION_ICONS[meta.icon] === undefined);
}

if (process.env.NODE_ENV !== "production") {
  const missing = unresolvedSectionIcons();
  if (missing.length > 0) {
    console.warn(
      `[studio] ${missing.length} block ${missing.length === 1 ? "type has" : "types have"} an icon ` +
        "name that components/studio/builder/SectionCard.tsx cannot resolve, so they draw the fallback " +
        "square in the builder and the palette. Add the named lucide export to SECTION_ICONS: " +
        missing.map((meta) => `${meta.type} → "${meta.icon}"`).join(", ")
    );
  }
}

/** The glyph for a block type. Never undefined — see `FALLBACK_ICON`. */
export function sectionIcon(type: SectionType): LucideIcon {
  return SECTION_ICONS[safeSectionMeta(type).icon] ?? FALLBACK_ICON;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading an unvalidated payload safely
// ─────────────────────────────────────────────────────────────────────────────
//
// Every reader below takes `unknown` and returns something usable. The summary line is drawn for
// blocks whose settings have FAILED validation as often as for blocks whose settings are fine — that
// is the whole point of the recovery path — so nothing here may assume a shape.

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readText(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

function readList(data: Record<string, unknown>, key: string): unknown[] {
  const value = data[key];
  return Array.isArray(value) ? value : [];
}

/** A number typed into a number field arrives as a string; both spellings mean the same thing. */
function readNumber(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * A switch, read from a payload nothing has validated.
 *
 * Only a real `true` counts. A JSON column can hold the string `"true"` from an older editor, and
 * treating that as on would put "the page is held still" on a row where it is not — a summary that
 * lies is worse than a summary that is cautious.
 */
function readFlag(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true;
}

/** As above, for a count. Truncated because "up to 6.5 projects" is not a sentence. */
function readWhole(data: Record<string, unknown>, key: string): number | null {
  const value = readNumber(data, key);
  return value === null ? null : Math.trunc(value);
}

/** "1 figure" / "4 figures", never "1 figures" — a plural nobody proofread is a plural everyone sees. */
function plural(count: number, singular: string, many: string): string {
  return `${count} ${count === 1 ? singular : many}`;
}

/**
 * The first words of a rich-text document.
 *
 * Walks the Tiptap node tree for the first `text` node, with a depth limit, because the document comes
 * from a JSON column and a malformed one could in principle be circular — a summary line is not worth
 * a stack overflow.
 */
function firstTextIn(node: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = firstTextIn(child, depth + 1);
      if (found) return found;
    }
    return "";
  }
  const record = asRecord(node);
  const text = readText(record, "text");
  if (text) return text;
  return firstTextIn(record.content, depth + 1);
}

/**
 * "How the records for this block are chosen", in the words the editor picked.
 *
 * Every showcase block shares this shape (see `showcase()` in lib/sections/schema.ts), so the sentence
 * is written once. Manual mode with nothing chosen SAYS SO: an empty hand-picked list renders as a
 * studio notice on the page rather than as content, and a builder scanning the list needs to know that
 * from the row.
 */
function curationWords(data: Record<string, unknown>, many: string): string {
  const mode = readText(data, "mode");
  const limit = readWhole(data, "limit");
  const chosen = readList(data, "ids").length;

  if (mode === "manual") {
    return chosen === 0 ? "chosen by hand — none chosen yet" : `${chosen} chosen by hand`;
  }
  if (mode === "featured") {
    return limit === null ? `the featured ${many}` : `the featured ${many}, up to ${limit}`;
  }
  return limit === null ? `the latest ${many}` : `the latest ${limit} ${many}`;
}

/** Joins the parts of a summary, dropping the empty ones, so no line ever reads "· ·". */
function joinParts(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
}

/**
 * One line describing what is actually in this block.
 *
 * Exported because the palette and any future "where is this block used" screen want the same sentence,
 * and two summarisers that disagree about the same block is a builder that reads differently in two
 * places. Returns a plain sentence, never an empty string — "Nothing filled in yet" is information.
 */
export function summariseSection(type: SectionType, raw: unknown): string {
  const data = asRecord(raw);
  const heading = readText(data, "heading");

  switch (type) {
    case "HERO": {
      const headline = [readText(data, "headline"), readText(data, "headlineAccent")]
        .filter(Boolean)
        .join(" ");
      return headline || readText(data, "eyebrow") || "No headline yet";
    }
    case "RICH_TEXT": {
      const opening = firstTextIn(data.body);
      return (
        joinParts([heading, opening ? truncateWords(opening, 90) : ""]) || "No writing in it yet"
      );
    }
    case "STATS": {
      const items = readList(data, "items");
      const first = readText(asRecord(items[0]), "label");
      return joinParts([heading, plural(items.length, "figure", "figures"), first]) || "No figures yet";
    }
    case "FEATURE_GRID": {
      const items = readList(data, "items");
      const columns = readWhole(data, "columns");
      return (
        joinParts([
          heading,
          plural(items.length, "card", "cards"),
          columns === null ? "" : `${columns} across`
        ]) || "No cards yet"
      );
    }
    case "RESEARCH_SHOWCASE":
      return joinParts([heading, curationWords(data, "research areas")]);
    case "PROJECT_SHOWCASE": {
      const state = readText(data, "state");
      return joinParts([
        heading,
        curationWords(data, "projects"),
        state ? `${state.toLowerCase().replace(/_/g, " ")} only` : ""
      ]);
    }
    case "PEOPLE_SHOWCASE": {
      const kind = readText(data, "kind");
      return joinParts([
        heading,
        curationWords(data, "people"),
        kind ? `${kind.toLowerCase().replace(/_/g, " ")} only` : ""
      ]);
    }
    case "PUBLICATION_LIST":
      return joinParts([heading, curationWords(data, "publications")]);
    case "NEWS_SHOWCASE":
      return joinParts([heading, curationWords(data, "news items")]);
    case "EVENT_SHOWCASE": {
      const when = readText(data, "when");
      return joinParts([
        heading,
        when === "past" ? "past events" : when === "all" ? "every event" : "upcoming events",
        curationWords(data, "events")
      ]);
    }
    case "GALLERY": {
      const source = readText(data, "source");
      return joinParts([
        heading,
        source === "images" ? "photographs" : "albums",
        curationWords(data, source === "images" ? "pictures" : "albums")
      ]);
    }
    case "MEDIA_SPLIT": {
      const side = readText(data, "side") === "right" ? "picture on the right" : "picture on the left";
      const hasMedia = readText(data, "mediaId") !== "";
      return joinParts([heading, side, hasMedia ? "" : "no picture chosen yet"]) || side;
    }
    case "TIMELINE": {
      const entries = readList(data, "entries");
      const firstYear = readText(asRecord(entries[0]), "year");
      return (
        joinParts([heading, plural(entries.length, "entry", "entries"), firstYear ? `from ${firstYear}` : ""]) ||
        "No entries yet"
      );
    }
    case "PARTNER_LOGOS":
      return joinParts([heading, curationWords(data, "partners")]);
    case "QUOTE": {
      const quote = readText(data, "quote");
      return (
        joinParts([quote ? `“${truncateWords(quote, 70)}”` : "", readText(data, "attribution")]) ||
        "No quotation yet"
      );
    }
    case "CTA": {
      const tone = readText(data, "tone") === "quiet" ? "quiet panel" : "purple panel";
      const button = readText(asRecord(data.primaryCta), "label");
      return joinParts([heading, tone, button ? `button: ${button}` : "no button yet"]);
    }
    case "FAQ": {
      const items = readList(data, "items");
      return joinParts([heading, plural(items.length, "question", "questions")]) || "No questions yet";
    }
    case "CONTACT_FORM": {
      const inbox = readText(data, "formKey") || "general";
      return joinParts([heading, `messages go to the ${inbox} inbox`]);
    }
    case "MAP": {
      const address = readText(data, "address");
      // 0/0 is open ocean off West Africa, which lib/sections/schema.ts documents as "no location
      // chosen yet" — the renderer reads it the same way, so the row must too.
      const latitude = readNumber(data, "latitude") ?? 0;
      const longitude = readNumber(data, "longitude") ?? 0;
      const placed = latitude !== 0 || longitude !== 0;
      return joinParts([
        heading,
        address ? truncateWords(address, 60) : "no address yet",
        placed ? "" : "no place chosen on the map yet"
      ]);
    }
    case "EMBED": {
      const provider = readText(data, "provider") || "youtube";
      const title = readText(data, "title");
      const url = readText(data, "url");
      return (
        joinParts([title, provider === "iframe" ? "in a frame" : provider, url ? "" : "no address yet"]) ||
        "Nothing embedded yet"
      );
    }
    case "DOWNLOADS": {
      const category = readText(data, "category");
      return joinParts([heading, curationWords(data, "files"), category ? `${category} only` : ""]);
    }
    case "DOCUMENT_EMBED": {
      // The chosen document is a `MediaAsset` id, and this summariser reads the RAW payload with no
      // lookup behind it — so the row can say WHETHER a document is chosen and never which one. That
      // is the honest half: "no document chosen yet" is the state an editor needs to see from a list
      // of twenty blocks, and the name is one click away in the panel that can resolve it.
      const title = readText(data, "title");
      const chosen = readText(data, "mediaId") !== "";
      return (
        joinParts([title, chosen ? "one document" : "no document chosen yet"]) ||
        "Nothing chosen yet"
      );
    }
    case "CRAFT_EXPLORER": {
      const view = readText(data, "view") || "grid";
      const region = readText(data, "regionSlug");
      return joinParts([
        heading,
        view === "map" ? "shown on a map" : view === "timeline" ? "shown as a timeline" : "shown as cards",
        region ? `${region} only` : ""
      ]);
    }
    /**
     * The three "action" blocks. Each summary names the thing an editor would look for on the row —
     * how many steps, which form provider, how many links — rather than repeating the block's own type,
     * which the icon beside it already says.
     */
    case "ACTION_STEPS": {
      // `steps`, which is what actionStepsSectionSchema calls it. Every other repeater in the schema
      // uses `items`, so this one is the exception worth naming rather than guessing at.
      const steps = readList(data, "steps").length;
      return joinParts([heading, plural(steps, "step", "steps")]) || "No steps yet";
    }
    case "FORM_EMBED": {
      const provider = readText(data, "provider");
      const named: Record<string, string> = {
        google: "Google Form",
        microsoft: "Microsoft Form",
        typeform: "Typeform",
        other: "embedded form"
      };
      const kind = named[provider] ?? "embedded form";
      // The URL decides whether this block does anything at all, so its absence is the summary.
      const configured = readText(data, "url") ? kind : `${kind}, no address yet`;
      return joinParts([readText(data, "title") || heading, configured]) || configured;
    }
    case "LINK_GRID": {
      const items = readList(data, "items");
      return joinParts([heading, plural(items.length, "link", "links")]) || "No links yet";
    }
    /**
     * The four narrative blocks. Each of them can take its picture from EITHER the media library or
     * the bundled craft manifest (see `craftImageSlug` in lib/sections/schema.ts), so "has a picture"
     * is a question about two fields rather than one — and a row that reported "no picture yet"
     * because it only looked at `mediaId` would send an editor to fix something that is already right.
     */
    case "STORY_SCROLL": {
      const chapters = readList(data, "chapters");
      const first = readText(asRecord(chapters[0]), "title");
      return (
        joinParts([heading, plural(chapters.length, "chapter", "chapters"), first]) ||
        "No chapters yet"
      );
    }
    case "PARALLAX_BANNER": {
      const hasPicture =
        readText(data, "mediaId") !== "" || readText(data, "craftImage") !== "";
      const height = readText(data, "height");
      // Zero is the honest "no drift" and it is worth seeing from the list: it is the difference
      // between this block and a plain full-width photograph.
      const speed = readWhole(data, "speed");
      return (
        joinParts([
          heading,
          hasPicture ? "" : "no photograph chosen yet",
          height === "screen" ? "the whole screen tall" : "",
          speed === 0 ? "no drift" : ""
        ]) || "Nothing filled in yet"
      );
    }
    case "HORIZONTAL_RAIL": {
      const items = readList(data, "items");
      return (
        joinParts([
          heading,
          plural(items.length, "card", "cards"),
          // The one setting on this block that costs the reader their scroll, so it is on the row.
          readFlag(data, "pin") ? "the page is held still while it passes" : ""
        ]) || "No cards yet"
      );
    }
    case "PROCESS_STEPS": {
      const steps = readList(data, "steps");
      return (
        joinParts([
          heading,
          plural(steps.length, "stage", "stages"),
          readText(data, "layout") === "column" ? "in one column" : ""
        ]) || "No stages yet"
      );
    }
    case "PLATFORM_PILLARS":
      // The three instruments are fixed designed vignettes, so the header is the only thing that
      // distinguishes one row's content — and the fixed half is stated so nobody goes looking for it.
      return joinParts([heading, "the three fixed instruments"]) || "The three fixed instruments";
    case "INDIA_MAP":
      // The map draws itself from the archive, so the header is the only editable distinction.
      return joinParts([heading, "drawn from the archive"]) || "Drawn from the archive";
    case "SPACER": {
      const size = readText(data, "size") || "md";
      const words: Record<string, string> = {
        sm: "a small gap",
        md: "a medium gap",
        lg: "a large gap",
        xl: "an extra large gap"
      };
      return words[size] ?? "a gap";
    }
    default: {
      // Unreachable while `type` is a `SectionType`. It exists so that adding a value to the Prisma
      // enum without a summary here is a compile error rather than a blank line on a builder row.
      const exhaustive: never = type;
      return String(exhaustive);
    }
  }
}

/**
 * "Hero banner — Autumn campaign", or just "Hero banner" when the editor has not named it.
 *
 * Takes only the two fields it reads, so the builder can name a block it is holding as a save snapshot
 * rather than as a full row — a name in a failure message is needed at exactly the moment the row is not
 * conveniently to hand.
 */
export function sectionDisplayName(section: Pick<BuilderSection, "type" | "label">): string {
  const kind = safeSectionMeta(section.type).label;
  const named = section.label?.trim() ?? "";
  return named ? `${kind} — ${named}` : kind;
}

// ─────────────────────────────────────────────────────────────────────────────
// The card
// ─────────────────────────────────────────────────────────────────────────────

export interface SectionCardProps {
  section: BuilderSection;
  /** 0-based. Shown to the reader as `index + 1`. */
  index: number;
  total: number;
  /** True when this is the block whose settings the panel is showing. */
  isSelected: boolean;
  /**
   * What is wrong with this block's settings, in plain words, or null when they are fine. The card
   * stays fully usable either way — see the header.
   */
  problem: string | null;
  /**
   * "A change to this page is being saved right now." Turns the reorder controls off for a moment so a
   * drag cannot race a delete. ⚠ NOT a permission check — a reader who may not edit this page never
   * sees this card at all (contract §1.8).
   */
  busy?: boolean;
  /** Draws the "you just saved this one" outline. Cleared by the builder after about a second. */
  flash?: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  onToggleVisible: () => void;
  onDelete: () => void;
}

export function SectionCard({
  section,
  index,
  total,
  isSelected,
  problem,
  busy = false,
  flash = false,
  onSelect,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onToggleVisible,
  onDelete
}: SectionCardProps) {
  const meta = safeSectionMeta(section.type);
  const Icon = sectionIcon(section.type);
  const name = sectionDisplayName(section);
  const summary = summariseSection(section.type, section.data);

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: section.id, disabled: busy });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    // A plain CSS transition, so the global reduced-motion rule in globals.css collapses it to an
    // instant jump. The position number and the reflowed list are the signals; the slide is decoration.
    transition
  };

  const actions: RowAction[] = [
    {
      id: "edit",
      label: "Edit this block",
      icon: Pencil,
      description: "Opens its settings in the panel beside the list.",
      onSelect
    },
    {
      id: "duplicate",
      label: "Make a copy",
      icon: Copy,
      description: "Adds a copy of this block directly below it, with the same settings.",
      disabled: busy,
      onSelect: onDuplicate
    },
    {
      id: "move-up",
      label: "Move up",
      icon: ArrowUp,
      disabled: busy || index === 0,
      description: index === 0 ? "This is already the first block on the page." : undefined,
      onSelect: onMoveUp
    },
    {
      id: "move-down",
      label: "Move down",
      icon: ArrowDown,
      disabled: busy || index >= total - 1,
      description: index >= total - 1 ? "This is already the last block on the page." : undefined,
      onSelect: onMoveDown
    },
    {
      id: "visibility",
      label: section.isVisible ? "Hide from the page" : "Show on the page",
      icon: section.isVisible ? EyeOff : Eye,
      description: section.isVisible
        ? "The block stays here in the studio but readers do not see it."
        : // "the next time", never "again": a block added to a live page arrives hidden, so some
          // hidden blocks have never been seen by a reader at all.
          "Readers will see this block the next time the page is saved.",
      onSelect: onToggleVisible
    },
    {
      id: "delete",
      label: "Delete this block",
      icon: Trash2,
      tone: "danger",
      description: "Removes it from the page. You will be asked to confirm first.",
      disabled: busy,
      onSelect: onDelete
    }
  ];

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        // `flash-row` is the recipe from globals.css: a static purple outline plus a short tint, so
        // "this is the one that was just saved" survives reduced motion as an outline (contract §1.4).
        "flash-row group rounded-md border bg-card transition-colors",
        isSelected ? "border-purple-600 ring-4 ring-purple-600/15" : "border-line-200 hover:border-purple-300",
        // Rung 10 of the ladder — the same rung as sticky in-page chrome (contract §6). A card being
        // dragged has to paint above the cards it is passing over.
        isDragging ? "relative z-10 shadow-panel" : undefined,
        // Hidden blocks are drawn back, and the "Hidden" chip below says so in words as well.
        !section.isVisible && "bg-surface-50"
      )}
      data-flash={flash ? "true" : undefined}
    >
      <div className="flex items-start gap-1">
        {/* THE ONLY draggable thing on the row. See the header. */}
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          disabled={busy}
          aria-label={`Reorder ${name}. Press space, then use the up and down arrow keys, then press space again.`}
          className="mt-1.5 inline-flex h-8 w-7 shrink-0 cursor-grab items-center justify-center rounded text-ink-300 transition hover:bg-surface-100 hover:text-ink-700 focus-visible:ring-4 focus-visible:ring-purple-600/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <GripVertical aria-hidden="true" className="h-4 w-4" />
        </button>

        {/* The whole title area selects. A big, obvious target that never drags. */}
        <button
          type="button"
          onClick={onSelect}
          // `aria-current` rather than `aria-selected`: this is a list of links-in-spirit, not a
          // listbox, and `aria-selected` outside a listbox or a tablist is announced inconsistently.
          aria-current={isSelected ? "true" : undefined}
          className="min-w-0 flex-1 rounded-md px-1.5 py-2 text-left focus-visible:ring-4 focus-visible:ring-purple-600/15"
        >
          <span className="flex items-center gap-2">
            <Icon
              aria-hidden="true"
              className={cn("h-4 w-4 shrink-0", isSelected ? "text-purple-700" : "text-ink-500")}
            />
            <span className="truncate text-sm font-medium text-ink-900">{meta.label}</span>

            {section.label?.trim() ? (
              <span className="truncate text-sm text-ink-500">{section.label.trim()}</span>
            ) : null}

            {/* Position, in words a reader can hear. The list order is the other half of this fact. */}
            <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-300">
              {index + 1} of {total}
            </span>
          </span>

          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 flex-1 truncate text-xs text-ink-500">{summary}</span>

            {!section.isVisible ? (
              <Badge tone="neutral" size="sm" icon={EyeOff}>
                Hidden
              </Badge>
            ) : null}

            {problem ? (
              <Badge tone="warn" size="sm" icon={TriangleAlert}>
                Needs attention
              </Badge>
            ) : null}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5 pr-1 pt-1">
          {/*
            A toggle button rather than a `Switch`: a Switch renders a 44px row with its own label and
            an On/Off word, which would be taller than the card it sits in. The state reaches a reader
            three ways all the same — the glyph, `aria-pressed`, and the "Hidden" chip above.
          */}
          <button
            type="button"
            onClick={onToggleVisible}
            aria-pressed={section.isVisible}
            aria-label={`Show ${name} on the page`}
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center rounded-md transition focus-visible:ring-4 focus-visible:ring-purple-600/15",
              section.isVisible
                ? "text-ink-500 hover:bg-surface-100 hover:text-ink-900"
                : "text-amber-800 hover:bg-amber-100"
            )}
          >
            {section.isVisible ? (
              <Eye aria-hidden="true" className="h-4 w-4" />
            ) : (
              <EyeOff aria-hidden="true" className="h-4 w-4" />
            )}
          </button>

          <RowActions subject={`${name}, block ${index + 1} of ${total}`} actions={actions} />
        </div>
      </div>

      {problem ? (
        /*
          Inside the card, not in a toast: this is a standing fact about this block that has to be
          readable whenever the row is, and it names the block by being attached to it. `role="alert"`
          is deliberately absent — a list of eight cards would interrupt a screen-reader user eight
          times for something they can read at their own pace.
        */
        <p className="border-t border-amber-800/25 bg-amber-100 px-3 py-2 text-xs leading-relaxed text-amber-800">
          <TriangleAlert aria-hidden="true" className="mr-1.5 inline-block h-3.5 w-3.5 align-[-0.15em]" />
          One of this block&rsquo;s settings cannot be saved as it stands: {problem} Open it and put that
          right — the rest of the page saves as normal in the meantime.
        </p>
      ) : null}
    </li>
  );
}
