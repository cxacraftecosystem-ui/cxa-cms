"use client";

/**
 * The page builder's interactive pieces, each loaded as its own chunk, only on a page that renders it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS. SectionRenderer imports every block type, so every Client Component those blocks
 * import — the story's stages and lines, the pillars and rail stages, the video player, the lightbox, the
 * FAQ list, the counters — was part of EVERY built page's JavaScript, whether or not the page had that
 * block. /about downloaded the cinematic story; a page with one paragraph downloaded the video player.
 *
 * The blocks import these from HERE instead. `next/dynamic` in a Client Component is a real code-split
 * point (node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md): each piece becomes its own chunk,
 * requested only when a page renders it. A Server Component's dynamic import does NOT split in this
 * setup — tried and measured: /about still listed every chunk — which is why the boundary is here.
 *
 * WHAT DOES NOT CHANGE. `ssr` stays on, so every piece still renders on the server and the HTML is
 * byte-for-byte the same (verified by diffing five pages' server HTML before and after). On a full page
 * load a rendered piece's chunk is preloaded with the page and requested during hydration, so it starts
 * loading as soon as the page's first code has run — not on scroll — and until it arrives its server HTML
 * stays as it is. On a client-side navigation there is no such hint, so `PreloadIslands` (at the end of
 * this file) starts every piece the new page's blocks use at once, before React reaches the first.
 * The hero is NOT here: it is the top of the page and should hydrate first. `Reveal` is not here either:
 * 26 of the 32 block types use it, so it belongs in the common chunk.
 *
 * Each export is typed as the component it loads, through `import type` lines that are erased at build
 * and so do not pull the modules back in. `next/dynamic`'s own type would widen them to `ComponentType`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import dynamic from "next/dynamic";
import { useState, useSyncExternalStore } from "react";

import { island, preloadIslands } from "@/components/sections/island-registry";

import type { AiOrb as AiOrbComponent } from "@/components/sections/story/AiOrb";
import type { CineBubbles as CineBubblesComponent } from "@/components/sections/story/CineBubbles";
import type { CineFlipDeck as CineFlipDeckComponent } from "@/components/sections/story/CineFlipDeck";
import type { CineLine as CineLineComponent } from "@/components/sections/story/CineLine";
import type { CinematicScrollStage as CinematicScrollStageComponent } from "@/components/sections/story/CinematicScrollStage";
import type { PointerDrift as PointerDriftComponent } from "@/components/sections/story/PointerDrift";
import type { ParallaxStage as ParallaxStageComponent } from "@/components/sections/story/ParallaxStage";
import type { ProcessStage as ProcessStageComponent } from "@/components/sections/story/ProcessStage";
import type { RailStage as RailStageComponent } from "@/components/sections/story/RailStage";
import type { StoryStage as StoryStageComponent } from "@/components/sections/story/StoryStage";
import type { PillarsStage as PillarsStageComponent } from "@/components/sections/pillars/PillarsStage";
import type { FaqList as FaqListComponent } from "@/components/sections/faq/FaqList";
import type { TimelineSpine as TimelineSpineComponent } from "@/components/sections/timeline/TimelineSpine";
import type { IndiaMapStage as IndiaMapStageComponent } from "@/components/map/IndiaMapStage";
import type {
  AnimatedList as AnimatedListComponent,
  AnimatedListItem as AnimatedListItemComponent
} from "@/components/motion/AnimatedList";
import type { CountUp as CountUpComponent } from "@/components/motion/CountUp";
import type { ArcCarousel as ArcCarouselComponent } from "@/components/site/ArcCarousel";
import type {
  LightboxTrigger as LightboxTriggerComponent,
  MediaLightboxProvider as MediaLightboxProviderComponent
} from "@/components/site/MediaLightbox";
import type { PointerGlow as PointerGlowComponent } from "@/components/site/PointerGlow";
import type { VideoPlayer as VideoPlayerComponent } from "@/components/site/VideoPlayer";
import type { HostedVideoFrame as HostedVideoFrameComponent } from "@/components/site/HostedVideoFrame";
import type {
  MapAttribution as MapAttributionComponent,
  MapCanvas as MapCanvasComponent
} from "@/components/sections/MapSection";

// ── The cinematic story ───────────────────────────────────────────────────────────────────────────

export const AiOrb = dynamic(
  island("AiOrb", () => import("@/components/sections/story/AiOrb").then((module) => module.AiOrb))
) as unknown as typeof AiOrbComponent;

export const CineBubbles = dynamic(
  island("CineBubbles", () => import("@/components/sections/story/CineBubbles").then((module) => module.CineBubbles))
) as unknown as typeof CineBubblesComponent;

export const CineFlipDeck = dynamic(
  island("CineFlipDeck", () => import("@/components/sections/story/CineFlipDeck").then((module) => module.CineFlipDeck))
) as unknown as typeof CineFlipDeckComponent;

export const CineLine = dynamic(
  island("CineLine", () => import("@/components/sections/story/CineLine").then((module) => module.CineLine))
) as unknown as typeof CineLineComponent;

export const CinematicScrollStage = dynamic(
  island("CinematicScrollStage", () => import("@/components/sections/story/CinematicScrollStage").then((module) => module.CinematicScrollStage))
) as unknown as typeof CinematicScrollStageComponent;

export const PointerDrift = dynamic(
  island("PointerDrift", () => import("@/components/sections/story/PointerDrift").then((module) => module.PointerDrift))
) as unknown as typeof PointerDriftComponent;

// ── Scroll stages of other blocks ─────────────────────────────────────────────────────────────────

export const ParallaxStage = dynamic(
  island("ParallaxStage", () => import("@/components/sections/story/ParallaxStage").then((module) => module.ParallaxStage))
) as unknown as typeof ParallaxStageComponent;

export const ProcessStage = dynamic(
  island("ProcessStage", () => import("@/components/sections/story/ProcessStage").then((module) => module.ProcessStage))
) as unknown as typeof ProcessStageComponent;

export const RailStage = dynamic(
  island("RailStage", () => import("@/components/sections/story/RailStage").then((module) => module.RailStage))
) as unknown as typeof RailStageComponent;

export const StoryStage = dynamic(
  island("StoryStage", () => import("@/components/sections/story/StoryStage").then((module) => module.StoryStage))
) as unknown as typeof StoryStageComponent;

export const PillarsStage = dynamic(
  island("PillarsStage", () => import("@/components/sections/pillars/PillarsStage").then((module) => module.PillarsStage))
) as unknown as typeof PillarsStageComponent;

// ── Widgets one or two block types use ────────────────────────────────────────────────────────────

export const FaqList = dynamic(
  island("FaqList", () => import("@/components/sections/faq/FaqList").then((module) => module.FaqList))
) as unknown as typeof FaqListComponent;

export const TimelineSpine = dynamic(
  island("TimelineSpine", () => import("@/components/sections/timeline/TimelineSpine").then((module) => module.TimelineSpine))
) as unknown as typeof TimelineSpineComponent;

export const IndiaMapStage = dynamic(
  island("IndiaMapStage", () => import("@/components/map/IndiaMapStage").then((module) => module.IndiaMapStage))
) as unknown as typeof IndiaMapStageComponent;

export const AnimatedList = dynamic(
  island("AnimatedList", () => import("@/components/motion/AnimatedList").then((module) => module.AnimatedList))
) as unknown as typeof AnimatedListComponent;

export const AnimatedListItem = dynamic(
  island("AnimatedListItem", () => import("@/components/motion/AnimatedList").then((module) => module.AnimatedListItem))
) as unknown as typeof AnimatedListItemComponent;

export const CountUp = dynamic(
  island("CountUp", () => import("@/components/motion/CountUp").then((module) => module.CountUp))
) as unknown as typeof CountUpComponent;

export const ArcCarousel = dynamic(
  island("ArcCarousel", () => import("@/components/site/ArcCarousel").then((module) => module.ArcCarousel))
) as unknown as typeof ArcCarouselComponent;

// The provider and the trigger come from ONE module, so both lazy references resolve to the same module
// instance and therefore the same React context: the trigger always finds its provider.
export const MediaLightboxProvider = dynamic(
  island("MediaLightboxProvider", () => import("@/components/site/MediaLightbox").then((module) => module.MediaLightboxProvider))
) as unknown as typeof MediaLightboxProviderComponent;

export const LightboxTrigger = dynamic(
  island("LightboxTrigger", () => import("@/components/site/MediaLightbox").then((module) => module.LightboxTrigger))
) as unknown as typeof LightboxTriggerComponent;

export const PointerGlow = dynamic(
  island("PointerGlow", () => import("@/components/site/PointerGlow").then((module) => module.PointerGlow))
) as unknown as typeof PointerGlowComponent;

export const VideoPlayer = dynamic(
  island("VideoPlayer", () => import("@/components/site/VideoPlayer").then((module) => module.VideoPlayer))
) as unknown as typeof VideoPlayerComponent;

// The two video players are also used by RichText and the craft, event, album and project pages: a page
// whose record has no film no longer downloads a player.
export const HostedVideoFrame = dynamic(
  island("HostedVideoFrame", () => import("@/components/site/HostedVideoFrame").then((module) => module.HostedVideoFrame))
) as unknown as typeof HostedVideoFrameComponent;

export const MapCanvas = dynamic(
  island("MapCanvas", () => import("@/components/sections/MapSection").then((module) => module.MapCanvas))
) as unknown as typeof MapCanvasComponent;

export const MapAttribution = dynamic(
  island("MapAttribution", () => import("@/components/sections/MapSection").then((module) => module.MapAttribution))
) as unknown as typeof MapAttributionComponent;

// ── Starting them together on a client-side navigation ────────────────────────────────────────────

const subscribeToNothing = () => () => {};

/**
 * Starts every named piece's chunk at once, on a CLIENT-SIDE navigation only. Rendered by SectionRenderer
 * above the blocks (the names come from lib/sections/block-islands.ts), so it runs before React reaches
 * the first piece.
 *
 * Without it a client-side navigation fetched the pieces one after another: React reaches a piece, stops
 * until its chunk arrives, renders on to the next. On a full page load it does nothing: the server's
 * preload hints already fetch exactly the pieces the page renders, and that load stays as it was. It
 * tells the two apart with `useSyncExternalStore`, which returns the server snapshot (`false`) while
 * React hydrates server HTML and the client one (`true`) when React renders a tree itself, as on a
 * navigation. The fetch is in a `useState` initialiser, so it runs during this component's first render
 * and not again when React re-renders it with the client snapshot after hydration.
 *
 * Every `dynamic()` call above passes its loader through `island()` for this
 * (components/sections/island-registry.ts says why it must be that exact loader).
 */
export function PreloadIslands({ names }: { names: readonly string[] }) {
  const renderedByTheClient = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false
  );
  useState(() => {
    if (renderedByTheClient) preloadIslands(names);
  });
  return null;
}
