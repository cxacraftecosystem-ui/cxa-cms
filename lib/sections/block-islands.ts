/**
 * Which code-split pieces each block type renders, so a client-side navigation can start fetching them
 * all at once instead of one after another.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY. A block's interactive pieces are `next/dynamic` chunks (components/sections/lazy-islands.tsx and
 * client-sections.tsx). On a full page load the server emits a preload hint for every one the page
 * renders, so they download in parallel. On a CLIENT-SIDE navigation it does not, and React reaches each
 * chunk only when it renders that piece: it stops at the first, fetches it, renders on, stops at the
 * next. Measured from /about to /: seven fetches in a row and the new page shown at ~550 ms (2.6 s at
 * 300 ms latency), where before the split those pieces were already in the page's code. SectionRenderer
 * reads this table and renders `PreloadIslands` above the blocks, which starts every listed piece at once.
 *
 * The names are the pieces' export names in lazy-islands.tsx and client-sections.tsx, each registered by
 * its own `dynamic()` call (components/sections/island-registry.ts).
 *
 * A piece listed for a block that turns out not to render it (a rail drawn as the arc carousel, an embed
 * that is a hosted file) is fetched anyway on a client-side navigation: a few kilobytes, once. On a full
 * page load nothing here runs at all.
 *
 * ⚠ KEEP IT IN STEP. A block that starts importing a piece from lazy-islands.tsx must list it here;
 * tests/site/block-islands.test.ts follows each renderer's imports and fails if one is missing or extra.
 * A miss is not a breakage: the piece still loads, just after the ones before it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { SectionType } from "@prisma/client";

/** The cinematic presentation of the story block renders a different set of pieces from the plain one. */
export const CINEMATIC_STORY_KEY = "STORY_SCROLL_CINEMATIC";

export type IslandKey = SectionType | typeof CINEMATIC_STORY_KEY;

export const BLOCK_ISLANDS: Partial<Record<IslandKey, readonly string[]>> = {
  STORY_SCROLL: ["StoryStage"],
  STORY_SCROLL_CINEMATIC: ["CinematicScrollStage", "CineLine", "CineBubbles", "CineFlipDeck", "PointerDrift", "AiOrb"],
  PARALLAX_BANNER: ["ParallaxStage"],
  HORIZONTAL_RAIL: ["RailStage", "ArcCarousel"],
  PROCESS_STEPS: ["ProcessStage"],
  PLATFORM_PILLARS: ["PillarsStage"],
  FAQ: ["FaqList"],
  TIMELINE: ["TimelineSpine"],
  INDIA_MAP: ["IndiaMapStage"],
  NEWS_SHOWCASE: ["AnimatedList", "AnimatedListItem"],
  STATS: ["CountUp"],
  GALLERY: ["MediaLightboxProvider", "LightboxTrigger"],
  CTA: ["PointerGlow"],
  EMBED: ["VideoPlayer", "HostedVideoFrame"],
  MEDIA_SPLIT: ["VideoPlayer"],
  CRAFT_EXPLORER: ["MapCanvas", "MapAttribution"],
  // The three blocks that are Client Components are pieces themselves (client-sections.tsx).
  MAP: ["MapSection"],
  CONTACT_FORM: ["ContactFormSection"],
  FORM_EMBED: ["FormEmbedSection"]
};

/** The distinct pieces a page's visible blocks render, in page order. */
export function islandsFor(keys: readonly IslandKey[]): string[] {
  const names = new Set<string>();
  for (const key of keys) for (const name of BLOCK_ISLANDS[key] ?? []) names.add(name);
  return [...names];
}
