/**
 * FeatureGridSection — two to four columns of small cards: capabilities, services, themes.
 *
 * A Server Component. `Reveal` is the only client piece.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ICON MAP IS EXPLICIT, AND THAT IS THE WHOLE POINT OF IT.
 *
 * The obvious version of this file is `(Icons as any)[item.icon]` after `import * as Icons from
 * "lucide-react"`. That one line puts EVERY icon lucide ships — well over a thousand components —
 * into the bundle of every page carrying a feature grid, because a dynamic index cannot be
 * tree-shaken: the bundler has no way to know which key will be read. A named map costs one line per
 * icon and ships exactly the icons named in it.
 *
 * An unrecognised name falls back to a neutral glyph rather than throwing. Payloads outlive the code
 * that wrote them: a name that was valid when an editor picked it can be renamed upstream (lucide
 * renamed a whole family of chart icons, which is why the aliases below exist), and a page that
 * five-hundreds because of a stale icon name is a far worse failure than a page with a plain circle
 * on one card.
 *
 * `FEATURE_ICON_NAMES` is exported so the studio's icon picker offers exactly what this renderer can
 * draw. A picker with a longer list than the map is a picker that lets an editor choose something
 * that will silently become the fallback.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Award,
  BookOpen,
  Boxes,
  Brain,
  Briefcase,
  Building2,
  CalendarDays,
  Camera,
  ChartColumn,
  ChartLine,
  ChartPie,
  CircleCheckBig,
  CircleHelp,
  Compass,
  Cpu,
  Database,
  Download,
  Feather,
  FileText,
  FlaskConical,
  Gem,
  Globe,
  GraduationCap,
  Hammer,
  Handshake,
  Heart,
  History,
  Images,
  Landmark,
  Languages,
  Layers,
  LayoutGrid,
  Leaf,
  Library,
  Lightbulb,
  Mail,
  Map,
  MapPin,
  Megaphone,
  Microscope,
  Network,
  Newspaper,
  Palette,
  PenTool,
  Presentation,
  Puzzle,
  Recycle,
  Rocket,
  Ruler,
  Scale,
  Scissors,
  Scroll,
  Search,
  Shapes,
  Share2,
  ShieldCheck,
  Shirt,
  Sparkles,
  Sprout,
  Star,
  Target,
  Telescope,
  TrendingUp,
  Trophy,
  Users,
  Video,
  Waves,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon
} from "lucide-react";
import type { PageSection } from "@prisma/client";

import { STAGGER } from "@/components/motion/constants";
import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { sectionLabel } from "@/lib/sections/registry";
import type { FeatureGridSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

/**
 * Every icon a feature card may draw, by the name the payload stores.
 *
 * Chosen for what this institution actually talks about — craft, material, research, teaching,
 * partnership, archive — rather than as a slice of the alphabet.
 */
const FEATURE_ICONS: Record<string, LucideIcon> = {
  Activity,
  Award,
  BookOpen,
  Boxes,
  Brain,
  Briefcase,
  Building2,
  CalendarDays,
  Camera,
  ChartColumn,
  ChartLine,
  ChartPie,
  CircleCheckBig,
  CircleHelp,
  Compass,
  Cpu,
  Database,
  Download,
  Feather,
  FileText,
  FlaskConical,
  Gem,
  Globe,
  GraduationCap,
  Hammer,
  Handshake,
  Heart,
  History,
  Images,
  Landmark,
  Languages,
  Layers,
  LayoutGrid,
  Leaf,
  Library,
  Lightbulb,
  Mail,
  Map,
  MapPin,
  Megaphone,
  Microscope,
  Network,
  Newspaper,
  Palette,
  PenTool,
  Presentation,
  Puzzle,
  Recycle,
  Rocket,
  Ruler,
  Scale,
  Scissors,
  Scroll,
  Search,
  Shapes,
  Share2,
  ShieldCheck,
  Shirt,
  Sparkles,
  Sprout,
  Star,
  Target,
  Telescope,
  TrendingUp,
  Trophy,
  Users,
  Video,
  Waves,
  Workflow,
  Wrench,
  Zap,

  // ── Names lucide has since renamed ────────────────────────────────────────
  // Kept so a payload written against an older release still draws what its editor chose. They are
  // deliberately absent from FEATURE_ICON_NAMES: the picker should offer the current name only.
  BarChart3: ChartColumn,
  LineChart: ChartLine,
  PieChart: ChartPie,
  CheckCircle2: CircleCheckBig,
  HelpCircle: CircleHelp
};

/** What the studio's picker should offer, in the order it should offer it. */
export const FEATURE_ICON_NAMES: string[] = [
  "Activity",
  "Award",
  "BookOpen",
  "Boxes",
  "Brain",
  "Briefcase",
  "Building2",
  "CalendarDays",
  "Camera",
  "ChartColumn",
  "ChartLine",
  "ChartPie",
  "CircleCheckBig",
  "CircleHelp",
  "Compass",
  "Cpu",
  "Database",
  "Download",
  "Feather",
  "FileText",
  "FlaskConical",
  "Gem",
  "Globe",
  "GraduationCap",
  "Hammer",
  "Handshake",
  "Heart",
  "History",
  "Images",
  "Landmark",
  "Languages",
  "Layers",
  "LayoutGrid",
  "Leaf",
  "Library",
  "Lightbulb",
  "Mail",
  "Map",
  "MapPin",
  "Megaphone",
  "Microscope",
  "Network",
  "Newspaper",
  "Palette",
  "PenTool",
  "Presentation",
  "Puzzle",
  "Recycle",
  "Rocket",
  "Ruler",
  "Scale",
  "Scissors",
  "Scroll",
  "Search",
  "Shapes",
  "Share2",
  "ShieldCheck",
  "Shirt",
  "Sparkles",
  "Sprout",
  "Star",
  "Target",
  "Telescope",
  "TrendingUp",
  "Trophy",
  "Users",
  "Video",
  "Waves",
  "Workflow",
  "Wrench",
  "Zap"
];

/** Neutral on purpose: it claims nothing about the card, which is right when the name is unknown. */
const FALLBACK_ICON: LucideIcon = Shapes;

/** Resolve an icon name to the component that draws it. Never throws, never returns undefined. */
export function featureIcon(name: string): LucideIcon {
  if (!name) return FALLBACK_ICON;
  return FEATURE_ICONS[name] ?? FALLBACK_ICON;
}

/** Complete literal class strings — a `grid-cols-${n}` assembled from data is purged (contract §5). */
const COLUMN_CLASS: Record<FeatureGridSectionData["columns"], string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
};

/** The entrance delay stops growing here; twelve cards at a full stagger arrive a second apart. */
const MAX_STAGGER_STEPS = 8;

export interface FeatureGridSectionProps {
  data: FeatureGridSectionData;
  section: PageSection;
}

export function FeatureGridSection({ data, section }: FeatureGridSectionProps) {
  if (data.items.length === 0) return null;

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  /** Is any of the header visible? Only then does it take space above the cards. */
  const showsHeader = Boolean(heading || eyebrow || body);

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        {/*
          ALWAYS RENDERED. Every card below carries an `<h3>`, so a grid with no `<h2>` of its own takes
          the page from `<h1>` straight to `<h3>` — a level missing from the outline a screen-reader user
          navigates by (contract §11). The cards cannot simply be promoted to `<h2>` the way a showcase
          block's can: there are up to twelve of them and they are captions on a picture-and-a-line card,
          not sections of the page.

          A heading an editor cleared is taken OFF SCREEN rather than invented, and the fallback words
          are the block's own name from `SECTION_REGISTRY` so they come from one place. The margin is
          gated on there being something to see, so a header that exists only for the outline does not
          leave 48px of empty space above the first card.
        */}
        <SectionHeading
          eyebrow={eyebrow || undefined}
          title={heading || sectionLabel(section.type)}
          titleClassName={heading ? undefined : "sr-only"}
          description={body || undefined}
          className={showsHeader ? "mb-12" : undefined}
        />

        <div className={cn("grid gap-6", COLUMN_CLASS[data.columns])}>
          {data.items.map((item, index) => {
            const Icon = featureIcon(item.icon);

            const card = (
              <>
                <span
                  aria-hidden="true"
                  className="flex h-11 w-11 items-center justify-center rounded-md bg-surface-100 text-purple-600"
                >
                  <Icon className="h-5 w-5" />
                </span>

                {item.title ? (
                  <h3 className="display-title mt-5 text-lg">{item.title}</h3>
                ) : null}

                {item.body ? (
                  <p className="mt-2.5 text-sm leading-relaxed text-ink-500">{item.body}</p>
                ) : null}

                {item.href ? (
                  // The affordance is a static one — a word and an arrow that are always there. The
                  // hover treatment on the card is decoration on top of it (contract §1.4).
                  <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-purple-700">
                    Read more
                    <ArrowRight aria-hidden="true" className="h-4 w-4" />
                  </span>
                ) : null}
              </>
            );

            const frame =
              "flex h-full flex-col rounded-lg border border-line-200 bg-card p-6 shadow-sm transition";

            return (
              <Reveal
                key={`${index}-${item.title}`}
                delay={Math.min(index, MAX_STAGGER_STEPS) * STAGGER.cards}
                className="h-full"
              >
                {item.href ? (
                  <Link
                    href={item.href}
                    // Without this the link's accessible name is the whole card read aloud — icon
                    // label, title, body and "Read more" in one run-on sentence.
                    aria-label={item.title || undefined}
                    className={cn(frame, "hover:border-purple-300 hover:shadow-md")}
                  >
                    {card}
                  </Link>
                ) : (
                  <div className={frame}>{card}</div>
                )}
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
