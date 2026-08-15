/**
 * PlatformPillarsSection — the platform, in three instruments.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE SIDE-BY-SIDE PANELS ON THE LIGHT PAGE, EACH DOMINATED BY ITS OWN ANIMATED DRAWING, each
 * captioned by one title and ONE short sentence. The owner's brief: more visual element than text
 * element. The drawings come from the repo's own craft vocabulary rather than stock ornament:
 *
 *   1. KNOWLEDGE BASES — "the shelf that remembers". A lattice of small record-cards that ASSEMBLE:
 *      scattered and faded while the section approaches, settled into a neat grid as it passes,
 *      over a faint star-and-hexagon jaali (the pierced screen a record shelf stands behind).
 *   2. FIELD REPOSITORIES — "what the field brings home". The kolam pulli with the single line
 *      drawn through them under the reader's own scroll — the same 5×3 single-stroke figure as the
 *      footer's mark — and a handful of photograph chips gathering into a neat stack in the corner,
 *      each travelling at its own rate, the way fieldwork comes home in pockets.
 *   3. KNOWLEDGE-BASED SYSTEMS — "connections that answer". A small network whose edges draw and
 *      whose nodes brighten as the reader passes, with one gold query node breathing at the centre
 *      (the breath lives in app/platform-pillars.css; its static pair is the always-drawn ring).
 *
 * ⚠ THE PILLARS ARE CODE, NOT CMS FIELDS, on purpose — see `platformPillarsSectionSchema`. The copy
 * and the drawings are one composition; only the header above them is editable.
 *
 * THE ARCHITECTURE IS THE NARRATIVE BLOCKS', DELIBERATELY: a SERVER COMPONENT holding every word
 * and every stroke, wrapped by `PillarsStage` — a thin client stage that adds only scroll-scrubbed
 * motion over a layout that is already complete. Everything GSAP touches RESTS in its final
 * designed state (grid neat, line drawn, chips stacked, edges joined): no JavaScript, a failed
 * chunk and reduced motion all leave three composed, readable panels (contract §8's invariant).
 *
 * ⚠ EVERY DRAWING IS `aria-hidden` AND THE MEANING IS IN THE TEXT beside it — the title and the
 * sentence say everything the picture says (contract §11).
 *
 * ⚠ THE CHIP PHOTOGRAPHS BYPASS `CraftPhoto`, AND THEIR ATTRIBUTION LIVES ON /credits — the
 * owner's direction for the landing (CraftPhoto's licence note carries the CC BY 4.0 §3(a)(2)
 * reasoning; the /credits page enumerates every manifest photograph in full). Discharged there,
 * never deleted.
 */

import "@/app/platform-pillars.css";

import Image from "next/image";
import type { PageSection } from "@prisma/client";

import { jaaliTile } from "@/components/craft/motifs";
import { KolamMark } from "@/components/craft/KolamMark";
import { STAGGER } from "@/components/motion/constants";
import { Reveal } from "@/components/motion/Reveal";
import { PillarsStage } from "@/components/sections/pillars/PillarsStage";
import { SectionHeading } from "@/components/site/SectionHeading";
import { craftImage, type CraftImage } from "@/lib/media/craft-imagery";
import { sectionLabel } from "@/lib/sections/registry";
import type { PlatformPillarsSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// The copy — fixed, and kept exactly this terse (the drawings do the talking).
// ─────────────────────────────────────────────────────────────────────────────

/*
 * The names were recast by the owner's direction ("not just these systems in particular, but
 * something better that really makes sense"): system-architecture nouns became the three things a
 * VISITOR can hold — the archive that keeps, the record that arrives, the layer that answers. The
 * drawings were composed for exactly these meanings, so only the words moved.
 */
const PILLAR_TITLES = {
  bases: "The living archive",
  field: "The field record",
  systems: "The intelligence layer"
} as const;

const PILLAR_LINES = {
  bases: "Every material, technique and pattern the Centre holds, kept structured and queryable.",
  field: "What fieldwork brings home — catalogued with the place, hands and context it came from.",
  systems: "The layer that reasons over it all, connecting records to answer new questions."
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pillar 1 — the record cards, and where each one starts its journey from.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where each of the twelve cards is scattered TO at the start of the scrub (px and degrees, read by
 * PillarsStage as `data-dx`/`data-dy`/`data-rot`). Hand-seeded and deterministic — no Math.random,
 * for the hydration and re-render reasons components/craft/motifs.ts spells out. PIXELS, not
 * percentages: these are ~4rem cards, and a percentage of their own size is a drift of nothing
 * (the cinematic stage learnt this the measured way). The RESTING state is the neat grid below;
 * these offsets exist only while the reader is mid-scrub.
 */
const CARD_SCATTER: readonly { dx: number; dy: number; rot: number }[] = [
  { dx: -64, dy: -38, rot: -9 },
  { dx: 22, dy: -66, rot: 6 },
  { dx: -18, dy: -52, rot: -4 },
  { dx: 58, dy: -44, rot: 10 },
  { dx: -76, dy: 10, rot: 7 },
  { dx: 44, dy: -12, rot: -8 },
  { dx: -30, dy: 26, rot: 5 },
  { dx: 70, dy: 18, rot: -6 },
  { dx: -52, dy: 54, rot: -10 },
  { dx: 16, dy: 62, rot: 8 },
  { dx: -8, dy: 44, rot: -3 },
  { dx: 62, dy: 50, rot: 4 }
];

/**
 * The pierced screen behind the shelf: one `<pattern>` repeat of the star-and-hexagon lattice,
 * faint, in the story's own gold on the night panel — used exactly as its geometry file
 * instructs, as voids over a wash.
 * The radial mask fades it out so the texture never paints a hard rectangle inside the panel.
 */
function JaaliBackdrop() {
  const tile = jaaliTile(24, 0.22);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 text-gold-300"
      style={{
        maskImage: "radial-gradient(85% 85% at 50% 42%, black 35%, transparent 88%)",
        WebkitMaskImage: "radial-gradient(85% 85% at 50% 42%, black 35%, transparent 88%)"
      }}
    >
      <svg className="h-full w-full" role="presentation">
        <defs>
          {/* One PLATFORM_PILLARS per page (registry `allowMultiple: false`), so this id is unique. */}
          <pattern
            id="pillars-jaali"
            width={tile.width}
            height={tile.height}
            patternUnits="userSpaceOnUse"
          >
            {tile.stars.map((d, index) => (
              <path key={`star-${index}`} d={d} fill="currentColor" opacity={0.1} />
            ))}
            {tile.hexes.map((d, index) => (
              <path key={`hex-${index}`} d={d} fill="currentColor" opacity={0.06} />
            ))}
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#pillars-jaali)" />
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pillar 2 — the photograph chips and their seats in the stack.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The chips: which manifest photograph, WHERE IT RESTS in the corner stack (complete literal seat
 * and tilt classes — contract §5), and how far the scrub carries it in from (px and degrees).
 * Different travel distances over one scroll span ARE the different rates — the parallax depth is
 * the difference between them, the cinematic's own trick.
 *
 * ⚠ The static tilt lives on an INNER span and the GSAP travel on the OUTER one — two wrappers,
 * one transform system each, because GSAP writes the whole inline transform and would erase a
 * resting rotation on the same element (contract §8; DriftingButi documents the same split).
 */
const FIELD_CHIPS: readonly {
  slug: string;
  seat: string;
  tilt: string;
  dx: number;
  dy: number;
  rot: number;
}[] = [
  { slug: "warli", seat: "bottom-2 right-2", tilt: "-rotate-3", dx: -132, dy: -66, rot: -10 },
  { slug: "dhokra", seat: "bottom-5 right-9", tilt: "rotate-2", dx: -84, dy: -104, rot: 8 },
  { slug: "bandhani", seat: "bottom-9 right-4", tilt: "-rotate-1", dx: -170, dy: -30, rot: -6 },
  { slug: "terracotta", seat: "bottom-12 right-11", tilt: "rotate-3", dx: -58, dy: -140, rot: 12 }
];

// ─────────────────────────────────────────────────────────────────────────────
// Pillar 3 — the network, hand-seeded and deterministic.
// ─────────────────────────────────────────────────────────────────────────────

/** viewBox coordinates. Node 0 is the gold query node at the centre; the rest ring it. */
const NETWORK_NODES: readonly { x: number; y: number }[] = [
  { x: 100, y: 64 },
  { x: 30, y: 28 },
  { x: 82, y: 16 },
  { x: 152, y: 22 },
  { x: 180, y: 60 },
  { x: 160, y: 106 },
  { x: 104, y: 118 },
  { x: 44, y: 108 },
  { x: 18, y: 68 }
];

/** Index pairs into NETWORK_NODES: a ring around the field, and four spokes into the query. */
const NETWORK_EDGES: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 1],
  [0, 1],
  [0, 3],
  [0, 5],
  [0, 7]
];

/**
 * The network at rest: every edge joined, every node lit, the query node ringed. The stage scrubs
 * the edges' dash (the `pathLength=1000` trick, offset 1001 so no undrawn cap shows) and the nodes'
 * opacity; the gold breath is CSS in app/platform-pillars.css. The RING around the query node is
 * the pulse's static pair — a reader whose motion is stilled still sees which node is the question.
 */
function NetworkFigure() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 200 132"
      className="h-full w-full text-white/80"
    >
      {NETWORK_EDGES.map(([from, to], index) => {
        const a = NETWORK_NODES[from];
        const b = NETWORK_NODES[to];
        if (!a || !b) return null;
        return (
          <path
            key={`edge-${index}`}
            data-pillar-edge
            d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`}
            pathLength={1000}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            className="opacity-40"
          />
        );
      })}

      {NETWORK_NODES.map((node, index) =>
        index === 0 ? (
          <g key="node-query" data-pillar-node className="text-gold-300">
            {/* The static ring — always drawn, never animated. */}
            <circle
              cx={node.x}
              cy={node.y}
              r={10.5}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.2}
              opacity={0.45}
            />
            <g className="cxa-pillars-query">
              <circle cx={node.x} cy={node.y} r={6} fill="currentColor" />
            </g>
          </g>
        ) : (
          <g key={`node-${index}`} data-pillar-node>
            <circle cx={node.x} cy={node.y} r={4.5} fill="currentColor" />
            <circle
              cx={node.x}
              cy={node.y}
              r={7.5}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.25}
            />
          </g>
        )
      )}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/** The shared panel frame — the light half's card idiom, same as FeatureGridSection's. */
/*
 * ⚠ THE PANELS ARE NIGHT MINIATURES OF THE STORY'S WORLD, NOT CARDS. The first draft set three
 * white cards with grey wireframe drawings and the owner called them what they were. LITERAL
 * purple-950 (the story's own ground — never a themed token under this unconditional white text,
 * theme-check's rule), a per-pillar dye glow from NATURAL_DYES, and every drawing in the gold the
 * story taught the reader to follow. The section sits on the light page, so three deep panels
 * read as three windows back into the night the story was told in.
 */
const PANEL =
  "relative flex h-full flex-col overflow-hidden rounded-2xl bg-purple-950 p-6 shadow-xl ring-1 ring-purple-800/40";

function PillarWords({ pillar }: { pillar: keyof typeof PILLAR_TITLES }) {
  return (
    <>
      {/* A gold hairline leads the words in — the thread's own gesture, one panel wide. */}
      <span aria-hidden="true" className="mt-6 block h-px w-10 bg-gradient-to-r from-gold-300/80 to-transparent" />
      <h3 className="display-title mt-3 text-lg text-white">{PILLAR_TITLES[pillar]}</h3>
      <p className="mt-2.5 text-sm leading-relaxed text-white/65">{PILLAR_LINES[pillar]}</p>
    </>
  );
}

export interface PlatformPillarsSectionProps {
  data: PlatformPillarsSectionData;
  section: PageSection;
}

export function PlatformPillarsSection({ data, section }: PlatformPillarsSectionProps) {
  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  const showsHeader = Boolean(heading || eyebrow || body);

  // The manifest is compiled in, so a miss here is a typo in FIELD_CHIPS, not a runtime state — but
  // `craftImage` answers `null` by contract and the chips simply thin out rather than throw.
  const chips = FIELD_CHIPS.map((chip) => ({ chip, image: craftImage(chip.slug) })).filter(
    (entry): entry is { chip: (typeof FIELD_CHIPS)[number]; image: CraftImage } =>
      entry.image !== null
  );

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        {/*
          ALWAYS RENDERED — each panel carries an `<h3>`, so a block with no `<h2>` of its own would
          skip a level of the outline (contract §11). A heading the editor cleared goes off screen
          rather than being invented, with the block's registry name as the sr-only fallback —
          the same treatment as FeatureGridSection.
        */}
        <SectionHeading
          eyebrow={eyebrow || undefined}
          title={heading || sectionLabel(section.type)}
          titleClassName={heading ? undefined : "sr-only"}
          description={body || undefined}
          className={showsHeader ? "mb-12" : undefined}
        />

        <PillarsStage>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* ── 1. Knowledge bases — the shelf that remembers ─────────────── */}
            <Reveal className="h-full">
              <div data-pillar="bases" className={PANEL}>
                <div aria-hidden="true" className="relative h-52">
                  <JaaliBackdrop />
                  <div className="absolute inset-0 flex items-center justify-center p-3">
                    <div className="grid w-full grid-cols-4 gap-2">
                      {CARD_SCATTER.map((seat, index) => (
                        <span
                          key={index}
                          data-pillar-card
                          data-dx={seat.dx}
                          data-dy={seat.dy}
                          data-rot={seat.rot}
                          className="block rounded border border-gold-300/25 bg-white/5 p-1.5 shadow-sm backdrop-blur-[1px]"
                        >
                          <span className="block h-1 w-2/3 rounded-full bg-gold-300/80" />
                          <span className="mt-1 block h-0.5 w-full rounded-full bg-white/20" />
                          <span className="mt-0.5 block h-0.5 w-4/5 rounded-full bg-white/15" />
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <PillarWords pillar="bases" />
              </div>
            </Reveal>

            {/* ── 2. Field repositories — what the field brings home ────────── */}
            <Reveal delay={STAGGER.cards} className="h-full">
              <div data-pillar="field" className={PANEL}>
                <div aria-hidden="true" className="relative h-52">
                  {/*
                    The kolam at rest is the complete figure — KolamMark ships it fully drawn, and
                    the stage adds `pathLength` at runtime so the mark stays pure-static for its
                    other callers (the cinematic does exactly this).
                  */}
                  <div className="absolute inset-y-0 left-0 flex items-center">
                    <div data-pillar-kolam className="w-44 text-gold-300/80">
                      <KolamMark cols={5} rows={3} className="w-full" />
                    </div>
                  </div>

                  {chips.map(({ chip, image }) => (
                    <span
                      key={image.slug}
                      data-pillar-chip
                      data-dx={chip.dx}
                      data-dy={chip.dy}
                      data-rot={chip.rot}
                      className={cn("absolute", chip.seat)}
                    >
                      <span
                        className={cn(
                          "relative block h-14 w-14 overflow-hidden rounded-md bg-purple-900 ring-1 ring-white/25 shadow-lg",
                          chip.tilt
                        )}
                      >
                        {/* alt="" — decorative by design; the pillar's words carry the meaning and
                            the licence attribution sits under the panels. */}
                        <Image src={image.src} alt="" fill sizes="3.5rem" className="object-cover" />
                      </span>
                    </span>
                  ))}
                </div>
                <PillarWords pillar="field" />
              </div>
            </Reveal>

            {/* ── 3. Knowledge-based systems — connections that answer ──────── */}
            <Reveal delay={STAGGER.cards * 2} className="h-full">
              <div data-pillar="systems" className={PANEL}>
                <div aria-hidden="true" className="relative h-52 p-2">
                  <NetworkFigure />
                </div>
                <PillarWords pillar="systems" />
              </div>
            </Reveal>
          </div>

          {/* The chip photographs' attribution lives on /credits with the rest of the landing's
              (owner's direction; CraftPhoto's licence note carries the CC BY 4.0 §3(a)(2)
              reasoning). Discharged there — never deleted. */}
        </PillarsStage>
      </div>
    </section>
  );
}
