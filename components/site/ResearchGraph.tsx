"use client";

/**
 * ResearchGraph — the Centre's research areas and the people who work across them, drawn as a graph.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LAYOUT IS DETERMINISTIC AND THERE IS NO SIMULATION. Every position is a pure function of the
 * node's id (through `stableHash`) and its index in the array the server sent, so:
 *
 *   • the picture is identical on the server and on the hydrated client — a force simulation seeded by
 *     `Math.random()` or by a first animation frame produces two different pictures and therefore a
 *     hydration mismatch on a prerendered page;
 *   • it is identical on every visit, so "the node at the top right" is something a reader can be told
 *     about, remember and come back to. A graph that rearranges itself every visit is a picture of
 *     nothing;
 *   • it costs no frames. A physics loop on a public index page is a tab that never goes idle.
 *
 * The cost is that the layout is not optimal — nodes can sit closer together than a solver would
 * allow. That is the right trade here: legible-and-stable beats prettier-and-different-every-time.
 *
 * SVG, NOT CANVAS. The labels are real text, so they can be selected, found with the browser's own
 * search, translated, and scaled by pinch or browser zoom without going soft. A canvas would be a
 * picture of the data with none of those properties.
 *
 * IT IS A REAL NAVIGATION CONTROL, NOT A DECORATION.
 *
 *   • Every node is an `<a href>` — a real link, so it can be middle-clicked, copied and announced as
 *     a link. It is a PLAIN anchor and not `next/link`: an SVG `<a>` lives in the SVG namespace and
 *     `Link` cannot render one, so a node press is a full navigation. The list below uses plain
 *     anchors too, because two routes to the same page that behave differently is worse than both
 *     being ordinary.
 *   • The nodes share ONE tab stop (a roving `tabindex`) and the arrow keys move between them. Forty
 *     nodes as forty tab stops would put a wall between the graph and everything after it on the page,
 *     which is how a keyboard user comes to hate a visualisation.
 *   • The edges are `aria-hidden`: a line is not something to announce, and every relationship one
 *     draws is written out in the list.
 *   • A VISUALLY-HIDDEN `<ul>` LISTS EVERY NODE AS A LINK, with what it is connected to and through
 *     which project. That list — not the drawing — is the accessible copy of this data. Two
 *     representations do mean an assistive-technology reader meets each destination twice; that is the
 *     price of the graph being genuinely operable rather than an image with a caption.
 *   • ⚠ EVERY LINK IN THAT LIST IS `tabIndex={-1}`, AND THAT IS LOAD-BEARING. `sr-only` hides an
 *     element from the screen and NOT from the tab order, so ordinary links there put one invisible tab
 *     stop per node in front of the drawing: a sighted keyboard user presses Tab and the focus ring
 *     disappears for as many presses as there are nodes, with nothing on screen to say where it has
 *     gone or how far it has to go. Taking them out of the tab order costs a screen-reader user
 *     nothing — a screen reader walks the document, not the tab order, so every link is still
 *     announced and still followable. THE VISIBLE NODES ARE THE FOCUSABLE COPY OF THIS DATA; the list
 *     is the readable one, and they carry the same destinations.
 *
 * REDUCED MOTION: NO TRANSITIONS, ONLY THE FINAL LAYOUT. Nothing here animates a position — the
 * highlight is the only thing that moves, as a CSS transition, and the JS branch below drops it
 * outright. The global rule in globals.css would collapse it anyway; the branch is here because this
 * is exactly the kind of component somebody later adds a framer entrance to, and the hook is then
 * already in place (contract §1.3). It never branches an `initial` state, because it has none.
 *
 * ⚠ IT NEVER QUERIES AND HOLDS NO OPINION ABOUT WHAT IS PUBLISHED. The page assembles the nodes and
 * edges from live rows and passes plain serialisable data. Where it had to cap the graph, it says so in
 * `note`, which is rendered under the drawing — a graph that quietly leaves out half the corpus is
 * indistinguishable from a Centre with half as much work (contract §1.6).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Network } from "lucide-react";

import { useReducedMotionPreference } from "@/components/motion";
import { EmptyState } from "@/components/ui/EmptyState";
import { clamp, cn, stableHash, truncateWords } from "@/lib/utils";

export type ResearchGraphNodeKind = "area" | "collaborator";

export interface ResearchGraphNode {
  /** Stable across requests — it is the layout seed as well as the React key. Use the row id. */
  id: string;
  /** The name. Area labels are always drawn; a collaborator's appears on hover or focus. */
  label: string;
  /** Where the node goes. An internal path — every node is a real link. */
  href: string;
  kind: ResearchGraphNodeKind;
  /**
   * A literal CSS colour, for an AREA node only, from `ResearchArea.accentColor`.
   *
   * This is one of the two places in the product a second colour is allowed, because here it is a
   * data-encoding channel and not an accent: it is what makes one area the same colour in this graph
   * as it is on its card (contract §1.1). It never carries meaning alone — the label, the node size
   * and the list all say the same thing.
   */
  accent?: string | null;
  /** How many edges touch this node. Drives the node's size and is spoken in its accessible name. */
  weight: number;
  /** One short phrase for the list — "6 projects, 12 publications", or a person's designation. */
  detail?: string | null;
}

export interface ResearchGraphEdge {
  /** Unique per edge; a project joining three people is three edges with three ids. */
  id: string;
  /** The `id` of an area node. */
  from: string;
  /** The `id` of a collaborator node. */
  to: string;
  /** The project this edge IS. Named in the list, so it is never only a tooltip. */
  label: string;
}

export interface ResearchGraphProps {
  nodes: readonly ResearchGraphNode[];
  edges: readonly ResearchGraphEdge[];
  /**
   * The sentence that owns the cap. Pass it whenever the graph is showing fewer areas, projects or
   * collaborators than exist, and say where the rest can be read.
   */
  note?: string | null;
  /** Names the figure — "How the research areas connect". */
  label?: string;
  className?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The drawing surface
//
// A fixed viewBox with the SVG scaled to its container: one coordinate system for the maths, and the
// browser does the fitting.
// ─────────────────────────────────────────────────────────────────────────────

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 640;
/** Keeps a node and its label off the edge of the frame. */
const PADDING = 72;

/** Rows for the keyboard order, in user units. See `readingOrder`. */
const ROW_BAND = 80;

/**
 * How much of a name is DRAWN.
 *
 * A 45-character area title centred on a node 150 units from the frame's edge overflows the viewBox
 * and is clipped — a silent, ragged truncation. Cutting it here on a word boundary is the visible
 * version of the same constraint, and the full name is still in the node's accessible name and in the
 * list, so nothing is actually lost.
 */
const MAX_DRAWN_LABEL = 24;

interface Point {
  x: number;
  y: number;
}

interface PlacedNode extends ResearchGraphNode {
  x: number;
  y: number;
  /** Circle radius, in user units. */
  r: number;
}

interface PlacedEdge extends ResearchGraphEdge {
  path: string;
}

/**
 * A stable number in [0, 1) from an id and a named channel.
 *
 * The channel is part of the hashed string so a node's angle, radius and curvature are three
 * independent-looking values rather than three functions of one number — without it, every node with a
 * large hash would sit far out AND bow strongly, and the layout would visibly have a pattern in it.
 */
function hashUnit(id: string, channel: string): number {
  // `stableHash` returns a uint32, so this lands in [0, 1) with no bias worth caring about.
  return stableHash(`${channel}:${id}`) / 4294967296;
}

/**
 * Areas sit on an ellipse, evenly spaced by their SERVER-GIVEN ORDER (which is the editor's curated
 * order), with a small hash-derived wobble in angle and radius.
 *
 * The even spacing is what makes the ring legible; the wobble is what stops it looking like a clock
 * face — and it is deterministic, so it is the same not-quite-clock-face every time.
 */
function placeAreas(areas: readonly ResearchGraphNode[]): Map<string, Point> {
  const positions = new Map<string, Point>();
  const cx = VIEW_WIDTH / 2;
  const cy = VIEW_HEIGHT / 2;

  const only = areas[0];
  if (areas.length === 1 && only) {
    // One area has no ring to sit on, and a lone node in the corner of an empty frame reads as a
    // rendering fault. It takes the middle, and its collaborators fan out around it.
    positions.set(only.id, { x: cx, y: cy });
    return positions;
  }

  const rx = ((VIEW_WIDTH - PADDING * 2) / 2) * 0.82;
  const ry = ((VIEW_HEIGHT - PADDING * 2) / 2) * 0.78;
  const step = (Math.PI * 2) / Math.max(1, areas.length);

  areas.forEach((area, index) => {
    // Starting at the top means the first area in the editor's order is the first the eye meets.
    const angle = index * step - Math.PI / 2 + (hashUnit(area.id, "angle") - 0.5) * step * 0.4;
    const pull = 0.88 + hashUnit(area.id, "radius") * 0.12;
    positions.set(area.id, {
      x: cx + Math.cos(angle) * rx * pull,
      y: cy + Math.sin(angle) * ry * pull
    });
  });

  return positions;
}

/**
 * A collaborator sits near the areas it is connected to, pushed outward from the centre of the frame.
 *
 * The CENTROID of its areas is the meaningful part: somebody working across two areas lands between
 * them, which is the one fact this graph exists to show. The outward push is what keeps them off the
 * ring itself, and its angle and distance are hash-derived so two collaborators on the same single
 * area do not land on top of each other.
 */
function placeCollaborator(
  node: ResearchGraphNode,
  areaIds: readonly string[],
  areaPositions: ReadonlyMap<string, Point>
): Point {
  const cx = VIEW_WIDTH / 2;
  const cy = VIEW_HEIGHT / 2;

  const anchors: Point[] = [];
  for (const areaId of areaIds) {
    const point = areaPositions.get(areaId);
    if (point) anchors.push(point);
  }

  if (anchors.length === 0) {
    // Joined to nothing that survived the publication filters. They are still a real person and still
    // belong on the page, so they go on an outer ring rather than vanishing without explanation.
    const angle = hashUnit(node.id, "orphan") * Math.PI * 2;
    return {
      x: clamp(cx + Math.cos(angle) * (VIEW_WIDTH / 2 - PADDING), PADDING, VIEW_WIDTH - PADDING),
      y: clamp(cy + Math.sin(angle) * (VIEW_HEIGHT / 2 - PADDING), PADDING, VIEW_HEIGHT - PADDING)
    };
  }

  const centroid = anchors.reduce(
    (sum, point) => ({ x: sum.x + point.x / anchors.length, y: sum.y + point.y / anchors.length }),
    { x: 0, y: 0 }
  );

  const dx = centroid.x - cx;
  const dy = centroid.y - cy;
  const length = Math.hypot(dx, dy);
  // A centroid sitting on the centre (two opposite areas, or the single-area case) has no outward
  // direction to speak of, so the hash picks one.
  const base = length < 1 ? hashUnit(node.id, "fallback") * Math.PI * 2 : Math.atan2(dy, dx);
  const angle = base + (hashUnit(node.id, "spread") - 0.5) * 1.2;
  const distance = 52 + hashUnit(node.id, "distance") * 84;

  return {
    x: clamp(centroid.x + Math.cos(angle) * distance, PADDING, VIEW_WIDTH - PADDING),
    y: clamp(centroid.y + Math.sin(angle) * distance, PADDING, VIEW_HEIGHT - PADDING)
  };
}

function radiusOf(node: ResearchGraphNode): number {
  // Sub-linear and capped on purpose: an area with forty collaborations would otherwise be a disc that
  // swallows its neighbours. The size is a hint; the number is in the label and in the list.
  const weight = Math.max(0, node.weight);
  return node.kind === "area" ? 15 + Math.min(weight, 10) * 1.4 : 5.5 + Math.min(weight, 5) * 0.9;
}

/**
 * The order the arrow keys walk.
 *
 * Quantised into horizontal bands and then sorted left to right inside each — the order the eye reads
 * a page. A pure y-sort scatters (two nodes 3px apart vertically become two rows), and a true
 * two-dimensional spatial walk on a graph with no grid takes the reader somewhere they did not expect
 * about half the time. All four arrows therefore walk this one order: right and down are "next", left
 * and up are "previous". Predictable and complete beats clever and surprising.
 *
 * It is also the DOM order, so the tab order, the reading order and the picture agree.
 */
function readingOrder(nodes: readonly PlacedNode[]): PlacedNode[] {
  return [...nodes].sort((a, b) => {
    const bandA = Math.round(a.y / ROW_BAND);
    const bandB = Math.round(b.y / ROW_BAND);
    if (bandA !== bandB) return bandA - bandB;
    if (a.x !== b.x) return a.x - b.x;
    // Never a partial order: two nodes at one point must still have a fixed sequence, or the keyboard
    // walk changes between renders.
    return a.id.localeCompare(b.id);
  });
}

const KIND_WORD: Record<ResearchGraphNodeKind, string> = {
  area: "research area",
  collaborator: "collaborator"
};

/**
 * The brand fallback for an area with no stored accent — purple-700, written literally because it is
 * used as an SVG `fill` value alongside stored colours and the two must come from one place.
 */
const DEFAULT_ACCENT = "oklch(0.47 0.198 305)";

export function ResearchGraph({ nodes, edges, note, label, className }: ResearchGraphProps) {
  const reduce = useReducedMotionPreference();

  /** The node under the pointer or holding focus. Null means "nothing picked out". */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Which node owns the graph's single tab stop. */
  const [tabStop, setTabStop] = useState(0);
  /**
   * Typed as `HTMLAnchorElement` because that is what TypeScript's JSX says an `<a>` is — the real DOM
   * node here is an `SVGAElement`, which also implements `focus()`. The lie is confined to this line.
   */
  const nodeRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  const layout = useMemo(() => {
    const areas = nodes.filter((node) => node.kind === "area");
    const collaborators = nodes.filter((node) => node.kind === "collaborator");
    const nodeById = new Map(nodes.map((node) => [node.id, node]));

    const areaPositions = placeAreas(areas);

    // Built once here rather than searched per render. `connections` is what the hidden list reads out
    // and `neighbours` is what the highlight tests, so the drawing and the list cannot disagree.
    const areasByCollaborator = new Map<string, string[]>();
    const connections = new Map<string, string[]>();
    const neighbours = new Map<string, Set<string>>();

    const push = <T,>(map: Map<string, T[]>, key: string, value: T) => {
      const existing = map.get(key);
      if (existing) existing.push(value);
      else map.set(key, [value]);
    };

    const link = (a: string, b: string) => {
      const set = neighbours.get(a);
      if (set) set.add(b);
      else neighbours.set(a, new Set([b]));
    };

    for (const edge of edges) {
      const area = nodeById.get(edge.from);
      const collaborator = nodeById.get(edge.to);
      // An edge naming a node that is not in the list is an assembly mistake, not a reason to throw:
      // it is dropped and the rest of the graph still draws.
      if (!area || !collaborator) continue;

      push(areasByCollaborator, edge.to, edge.from);
      push(connections, edge.from, `${collaborator.label} on ${edge.label}`);
      push(connections, edge.to, `${area.label} through ${edge.label}`);
      link(edge.from, edge.to);
      link(edge.to, edge.from);
    }

    const positions = new Map(areaPositions);
    for (const collaborator of collaborators) {
      positions.set(
        collaborator.id,
        placeCollaborator(collaborator, areasByCollaborator.get(collaborator.id) ?? [], areaPositions)
      );
    }

    const placed: PlacedNode[] = [];
    for (const node of nodes) {
      const point = positions.get(node.id);
      if (!point) continue;
      placed.push({ ...node, x: point.x, y: point.y, r: radiusOf(node) });
    }
    const placedById = new Map(placed.map((node) => [node.id, node]));

    const drawnEdges: PlacedEdge[] = [];
    for (const edge of edges) {
      const from = placedById.get(edge.from);
      const to = placedById.get(edge.to);
      if (!from || !to) continue;

      // A gentle quadratic bow, offset perpendicular to the line by a hash-derived amount. Two edges
      // between the same pair of regions would otherwise lie exactly on top of one another, and a
      // straight-line graph at this density reads as a ball of wool.
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const span = Math.max(1, Math.hypot(dx, dy));
      const bow = (hashUnit(edge.id, "bow") - 0.5) * Math.min(span * 0.28, 70);

      drawnEdges.push({
        ...edge,
        path: `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${(midX + (-dy / span) * bow).toFixed(1)} ${(midY + (dx / span) * bow).toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`
      });
    }

    return {
      order: readingOrder(placed),
      edges: drawnEdges,
      connections,
      neighbours,
      areaCount: areas.length,
      collaboratorCount: collaborators.length
    };
  }, [nodes, edges]);

  const figureLabel = label ?? "Research areas and their collaborators";

  if (layout.areaCount === 0) {
    return (
      <div className={className}>
        <EmptyState
          icon={Network}
          headingLevel={3}
          title="There is no research graph to draw yet"
          description="The graph appears once at least one research area has been published in the studio. Projects, and the people working on them, are what draw the lines between areas."
        />
      </div>
    );
  }

  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    const count = layout.order.length;
    if (count === 0) return;

    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;

    // Wraps rather than stopping, exactly as the lightbox's arrows do: two dead keys at the ends of a
    // list is a control that appears to have broken.
    const from = Math.min(Math.max(0, tabStop), count - 1);
    const next =
      step !== 0
        ? (((from + step) % count) + count) % count
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? count - 1
            : null;

    if (next === null) return;

    // Without this the same press also scrolls the region the figure sits in, so focus would move and
    // the frame would slide out from under it at the same time.
    event.preventDefault();
    setTabStop(next);
    nodeRefs.current[next]?.focus();
  };

  /**
   * The highlight transition, dropped under reduction (see the header). `transition-opacity` rather
   * than `transition`, so nothing else on these elements — a colour, a radius — is caught up in it.
   */
  const fade = reduce ? undefined : "transition-opacity duration-200 ease-out";

  /**
   * The tab stop, clamped to the nodes that exist.
   *
   * `tabStop` is state and `nodes` is a prop: a graph re-rendered with fewer nodes than the reader had
   * walked to would leave the index past the end and NOTHING tabbable — the whole figure silently
   * dropping out of the keyboard's reach, which is precisely the failure the roving index exists to
   * avoid. Clamping at render costs one comparison and cannot get out of step.
   */
  const stop = Math.min(Math.max(0, tabStop), Math.max(0, layout.order.length - 1));

  const dimmed = (nodeId: string): boolean => {
    if (!activeId || nodeId === activeId) return false;
    // A node stays lit when it shares an edge with the active one: the point of picking a node out is
    // to see what it is joined to.
    return !(layout.neighbours.get(activeId)?.has(nodeId) ?? false);
  };

  const clearActive = (nodeId: string) =>
    setActiveId((current) => (current === nodeId ? null : current));

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {/*
        THE ACCESSIBLE COPY OF THE DATA. Rendered before the drawing so it is met first in DOM order,
        and NAMED rather than headed — a heading here would put a rung in the page outline that nothing
        on screen corresponds to.

        Its links are OUT OF THE TAB ORDER and the visible nodes are in it. See the file header: this is
        the difference between a keyboard user who can drive the graph and one whose focus vanishes into
        a list they cannot see.
      */}
      <ul aria-label={`${figureLabel} — every node as a list`} className="sr-only">
        {layout.order.map((node) => {
          const links = layout.connections.get(node.id) ?? [];
          return (
            <li key={node.id}>
              {/* A real `<a href>` so it is announced as a link and can be followed, but never a tab
                  stop — the node in the drawing is the tab stop for this destination. */}
              <a href={node.href} tabIndex={-1}>
                {node.label}
              </a>
              {` — ${KIND_WORD[node.kind]}`}
              {node.detail ? `, ${node.detail}` : ""}
              {links.length > 0
                ? `. Connected to: ${links.join("; ")}.`
                : ". Not connected to anything else in this graph."}
            </li>
          );
        })}
      </ul>

      {/*
        The figure scrolls inside its own box below about 44rem rather than shrinking its labels past
        reading size — wide content scrolls, the page never does. Focusable and named, because a
        scrollable region only a mouse can reach is content some readers cannot get to at all.
      */}
      <div
        role="region"
        aria-label={`${figureLabel} — scrollable diagram`}
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-line-200 bg-card p-2 sm:p-4"
      >
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          // NOT `aria-hidden`: the nodes inside are real, focusable links, and hiding their container
          // would leave focusable elements outside the accessibility tree (contract §11).
          role="group"
          aria-label={figureLabel}
          onKeyDown={onKeyDown}
          className="h-auto w-full min-w-[44rem]"
        >
          {/* Edges say nothing a reader is not told in words — the list names every project. */}
          <g aria-hidden="true" fill="none">
            {layout.edges.map((edge) => {
              const lit = activeId === edge.from || activeId === edge.to;
              return (
                <path
                  key={edge.id}
                  d={edge.path}
                  strokeWidth={lit ? 2 : 1.25}
                  opacity={activeId ? (lit ? 0.9 : 0.12) : 0.42}
                  className={cn("stroke-purple-600", fade)}
                />
              );
            })}
          </g>

          {layout.order.map((node, index) => {
            const isArea = node.kind === "area";
            const accent = isArea ? (node.accent ?? DEFAULT_ACCENT) : null;
            const active = activeId === node.id;
            const showLabel = isArea || active;
            const links = layout.connections.get(node.id)?.length ?? 0;

            return (
              <a
                key={node.id}
                ref={(element) => {
                  nodeRefs.current[index] = element;
                }}
                href={node.href}
                // The whole sentence: a node announced as "Heritage AI, link" says nothing about what
                // pressing it does or what this node is doing in the picture.
                aria-label={`${node.label} — ${KIND_WORD[node.kind]}${
                  node.detail ? `, ${node.detail}` : ""
                }${links > 0 ? `, ${links} ${links === 1 ? "connection" : "connections"} in this graph` : ""}`}
                // The roving tab stop: exactly one node is reachable by Tab, and the arrows do the
                // rest. No `outline-none` — the global `a:focus-visible` outline traces the node, and
                // the purple ring below is the second, static half of the same signal.
                tabIndex={index === stop ? 0 : -1}
                onFocus={() => {
                  setTabStop(index);
                  setActiveId(node.id);
                }}
                onBlur={() => clearActive(node.id)}
                onMouseEnter={() => setActiveId(node.id)}
                onMouseLeave={() => clearActive(node.id)}
                className="cursor-pointer"
              >
                {/* `opacity` sits on a group because TypeScript types every JSX `<a>` as an HTML
                    anchor, which has no such attribute. The group is also what keeps the halo, the
                    disc and the label fading as one thing. */}
                <g opacity={dimmed(node.id) ? 0.25 : 1} className={fade}>
                  {/* A halo in the card colour, so a node reads as sitting on top of the lines it joins. */}
                  <circle cx={node.x} cy={node.y} r={node.r + 3} className="fill-card" />
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r}
                    // The accent is INLINE because it is stored data: a Tailwind class assembled from a
                    // column value is purged by the content scanner (contract §5). Collaborators take
                    // the themed surface ladder — only areas are colour-coded.
                    style={accent ? { fill: accent } : undefined}
                    strokeWidth={active ? 3 : 1.5}
                    className={cn(
                      accent ? undefined : "fill-surface-300",
                      active ? "stroke-purple-700" : "stroke-card"
                    )}
                  />

                  {showLabel ? (
                    <text
                      x={node.x}
                      y={node.y + node.r + (isArea ? 20 : 16)}
                      textAnchor="middle"
                      fontSize={isArea ? 16 : 13}
                      // A halo drawn UNDER the glyphs, so a label crossing a line stays readable
                      // without a rectangle behind it that would have to know the theme's background.
                      strokeWidth={4}
                      paintOrder="stroke"
                      className={cn(
                        "stroke-card",
                        isArea ? "fill-ink-900 font-semibold" : "fill-ink-700"
                      )}
                    >
                      {truncateWords(node.label, MAX_DRAWN_LABEL)}
                    </text>
                  ) : null}
                </g>
              </a>
            );
          })}
        </svg>
      </div>

      {/*
        The legend. Size and shape already separate the two kinds and the areas carry their names, so
        nothing here rests on colour alone (contract §11) — this says what the reader is looking at and
        how to drive it.
      */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-500">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full bg-purple-700" />
          {layout.areaCount} {layout.areaCount === 1 ? "research area" : "research areas"}, sized by
          how many collaborations each carries
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-surface-300" />
          {layout.collaboratorCount}{" "}
          {layout.collaboratorCount === 1 ? "collaborator" : "collaborators"}; every line is a project
        </span>
        <span>Tab into the diagram, then use the arrow keys to move between nodes.</span>
      </div>

      {/* The sentence that owns the cap — see the header. */}
      {note ? <p className="text-sm text-ink-500">{note}</p> : null}
    </div>
  );
}
