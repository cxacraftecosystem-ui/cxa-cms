/**
 * PageHero — the standard top of every non-home page, and the owner of the page's ONE `<h1>`.
 *
 * A Server Component. It reads nothing and holds no state; it exists so that twenty-five pages agree
 * on where the crumb trail sits, how far the title is from the description, and what a dark band
 * looks like — decisions that drift the moment each page makes them for itself.
 *
 * ONE `<h1>` PER PAGE (contract §11). If a page renders PageHero, nothing else on it may be an
 * `<h1>`: `SectionHeading` starts at level 2 for exactly this reason.
 *
 * TWO TONES, AND `media` MEANS SOMETHING DIFFERENT IN EACH:
 *
 *   • `light` — the default. Text on the page canvas. A `media` asset renders as a wide banner
 *     BELOW the text, because a photograph behind near-black type has no guaranteed contrast and
 *     the one thing a hero must do is be readable.
 *   • `dark` — a `.surface-dark` band with `.noise`. Here `media` is the backdrop, under a purple
 *     wash heavy enough that white type clears contrast over any photograph. With no media the band
 *     takes `.grad-mesh` instead, so it still has depth rather than being a flat rectangle.
 *
 * THE GOLD EYEBROW IS THE ONE PLACE GOLD IS ALLOWED (contract §1.1) — hero and section eyebrows on
 * the public site, never on a studio screen. On the light tone the eyebrow is purple, via `.eyebrow`.
 *
 * NO TOP PADDING FOR THE HEADER. `.page-top` on `<main>` pays `--nav-clearance` once for every page
 * (contract §7); a hero that added its own would be the second number meaning the same thing.
 */

import type { ReactNode } from "react";

import { MediaImage } from "@/components/ui/MediaImage";
import {
  BreadcrumbJsonLd,
  Breadcrumbs,
  type BreadcrumbItem
} from "@/components/site/Breadcrumbs";
import type { MediaLike } from "@/lib/media/url";
import { cn } from "@/lib/utils";

export type PageHeroTone = "light" | "dark";

export interface PageHeroProps {
  /** A short category line above the title — "Research area", "Publication". */
  eyebrow?: ReactNode;
  /** The page's `<h1>`. A ReactNode so a headline can carry a `.text-gold-gradient` span. */
  title: ReactNode;
  /** One or two sentences. Held to a readable measure whatever the container width. */
  description?: ReactNode;
  /** Backdrop (dark tone) or banner (light tone). See the header. */
  media?: MediaLike | null;
  /** A row of chips, dates or authors. Rendered as given, in a wrapping flex row. */
  meta?: ReactNode;
  /** Buttons — `LinkButton` for anything that navigates. */
  actions?: ReactNode;
  /** Renders the trail AND its JSON-LD. Do not also render `BreadcrumbJsonLd` on the same page. */
  breadcrumbs?: readonly BreadcrumbItem[];
  tone?: PageHeroTone;
  align?: "start" | "center";
  /** Anything extra below the actions — a stat row, a search box. */
  children?: ReactNode;
  className?: string;
}

/**
 * Complete literal class strings. `.display-title` sets `text-ink-900`, which is right on the page
 * canvas and unreadable on purple-950 — the `text-white` here is a UTILITY and utilities are emitted
 * after the components layer, so it wins without a `!` (contract §5).
 */
const TITLE_CLASS: Record<PageHeroTone, string> = {
  light: "display-title text-balance text-4xl md:text-5xl lg:text-6xl",
  dark: "display-title text-balance text-4xl text-white md:text-5xl lg:text-6xl"
};

const EYEBROW_CLASS: Record<PageHeroTone, string> = {
  light: "eyebrow",
  // Gold, not purple: purple-700 on purple-950 is two rungs apart on the same hue and reads as a
  // smudge. Gold is marketing-only and a hero eyebrow is exactly where it is permitted.
  dark: "eyebrow text-gold-300"
};

const DESCRIPTION_CLASS: Record<PageHeroTone, string> = {
  light: "text-lg leading-relaxed text-ink-500 sm:text-xl",
  dark: "text-lg leading-relaxed text-white/75 sm:text-xl"
};

const META_CLASS: Record<PageHeroTone, string> = {
  light: "text-sm text-ink-500",
  dark: "text-sm text-white/70"
};

export function PageHero({
  eyebrow,
  title,
  description,
  media,
  meta,
  actions,
  breadcrumbs,
  tone = "light",
  align = "start",
  children,
  className
}: PageHeroProps) {
  const centred = align === "center";
  const trail = breadcrumbs ?? [];

  const body = (
    <div className={cn("flex flex-col", centred && "items-center text-center")}>
      {trail.length > 0 ? (
        <Breadcrumbs
          items={trail}
          tone={tone}
          className={cn("mb-6", centred && "flex justify-center")}
        />
      ) : null}

      {eyebrow ? <p className={EYEBROW_CLASS[tone]}>{eyebrow}</p> : null}

      <h1 className={cn(TITLE_CLASS[tone], eyebrow ? "mt-3" : undefined)}>{title}</h1>

      {description ? (
        // A hero lede is held tighter than the 68ch prose measure: a single sentence spanning the
        // full 84rem shell is one long line the eye loses its place in.
        <p className={cn("mt-5 max-w-2xl", DESCRIPTION_CLASS[tone], centred && "mx-auto")}>
          {description}
        </p>
      ) : null}

      {meta ? (
        <div
          className={cn(
            "mt-6 flex flex-wrap items-center gap-x-4 gap-y-2",
            META_CLASS[tone],
            centred && "justify-center"
          )}
        >
          {meta}
        </div>
      ) : null}

      {actions ? (
        <div className={cn("mt-8 flex flex-wrap items-center gap-3", centred && "justify-center")}>
          {actions}
        </div>
      ) : null}

      {children ? <div className="mt-10 w-full">{children}</div> : null}
    </div>
  );

  return (
    <section className={cn("relative", className)}>
      {/* Emitted here rather than by the page, so a trail can never be rendered without its
          structured data or the other way round. */}
      {trail.length > 0 ? <BreadcrumbJsonLd items={trail} /> : null}

      {tone === "dark" ? (
        <div className="shell py-8 sm:py-10">
          <div
            className={cn(
              // `.noise` is a `::after` pinned to `inset: 0`, so the band must be positioned; the
              // overflow clip keeps both the grain and the backdrop inside the 16px radius.
              "surface-dark noise relative overflow-hidden px-6 py-14 sm:px-10 sm:py-20 lg:px-14 lg:py-24",
              media ? undefined : "grad-mesh"
            )}
          >
            {media ? (
              // A DECORATIVE BACKDROP: `alt=""` marks it as such, and the wrapper is hidden from the
              // accessibility tree entirely. The wrapper is what positions it — MediaImage's own
              // frame is `relative`, and because `cn()` is a plain join an `absolute` passed into its
              // className would LOSE to it on Tailwind's source order (contract §5).
              //
              // When storage is not configured MediaImage renders its labelled placeholder here
              // instead. That is deliberate: an editor finding out the CDN is unset is worth more
              // than a hero that silently looks fine and ships without its photograph.
              <div aria-hidden="true" className="absolute inset-0">
                <MediaImage
                  media={media}
                  alt=""
                  aspect="none"
                  rounded="none"
                  priority
                  sizes="100vw"
                  className="h-full w-full"
                />
                <div className="absolute inset-0 bg-purple-950/70" />
              </div>
            ) : null}

            {/* Positioned, so it paints above the backdrop without needing a z-index (contract §6). */}
            <div className="relative">{body}</div>
          </div>
        </div>
      ) : (
        <div className="shell py-10 sm:py-14">
          {body}

          {media ? (
            <MediaImage
              media={media}
              aspect="21 / 9"
              rounded="lg"
              priority
              sizes="(min-width: 1440px) 84rem, 100vw"
              className="mt-12 border border-line-200"
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
