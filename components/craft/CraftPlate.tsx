/**
 * CraftPlate — what stands in a craft card when the archive holds no photograph of that craft.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: A DIAGNOSTIC WAS BEING SHOWN AS CONTENT, ON THE ARCHIVE'S FLAGSHIP PAGE.
 *
 * `MediaImage`'s placeholder — a grey box reading "No image" — is a DIAGNOSTIC. It means "this record
 * points at a file that did not arrive", and for a missing upload that is exactly the right thing to
 * say, to the one person who can fix it. It is the wrong thing to say about an absence that is
 * permanent and expected: the Centre has 26 openly-licensed photographs and 42 crafts, so SIXTEEN
 * craft records have no photograph and never will until somebody licenses one. Measured on the live
 * corpus, `/craft-explorer` rendered sixteen grey "No image" boxes — on the page that is the archive.
 *
 * ⚠ THIS IS THE SAME DEFECT ALREADY FIXED FOR PEOPLE, ON A SURFACE NOBODY RE-CHECKED. A directory of
 * 24 people with no portraits showed 24 grey boxes; `EntityCard` gained `mediaFallback` and
 * `PersonCard` supplied an initials plate. The mechanism has been sitting there since — the craft
 * cards simply never passed one. Nothing mechanical could see it: every page answers 200, every image
 * that exists renders, and the placeholder is behaving exactly as designed. Somebody had to look.
 *
 * WHY A MOTIF AND NOT INITIALS. `personInitials` works because a person's initials ARE a short form of
 * their name — "MR" for Meera Ranganathan reads as a stand-in for a face. A craft's initials do not:
 * "Coir spinning and weaving" gives "CS", which is not a short form of anything and tells a reader
 * nothing. So this draws a `buti` from `motifs.ts` instead — the printed motifs the archive already
 * uses elsewhere — chosen deterministically from the craft's slug, so a given craft always shows the
 * same one and a grid of them does not look shuffled between renders.
 *
 * ⚠ IT MUST NOT BE MISTAKEN FOR A PHOTOGRAPH OF THE CRAFT, and it cannot be: it is a flat two-tone
 * drawing at low contrast on a tinted plate, in the site's own purple, next to cards that carry real
 * photographs. That contrast is the point. Inventing an illustrative image for an undocumented craft
 * would be the archive asserting something it does not know, which is the one thing this Centre's
 * pages may never do.
 *
 * ⚠ `aria-hidden`, ALWAYS. The card's heading already carries the craft's name; announcing a decorative
 * motif as well would read the entry twice. There is no `alt` text to write here, because there is no
 * information in it — it is a texture standing in for a missing one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { BUTI_BOX, BUTI_BY_ID, hashRange, hashUnit, type ButiId } from "@/components/craft/motifs";

/** The four blocks a field is built from, in a fixed order so the hash below is stable. */
const PLATE_BUTI: readonly ButiId[] = ["ambi", "phool", "patti", "bindi"];

export interface CraftPlateProps {
  /**
   * The craft's slug — stable, unique, and never re-generated, which is what makes the motif stable.
   * ⚠ NOT the name: a craft renamed in the studio would silently change motif, and a reader who knows
   * the archive would see a card they recognise wearing somebody else's mark.
   */
  slug: string;
}

export function CraftPlate({ slug }: CraftPlateProps) {
  // "buti" as a channel name, per `hashUnit`'s own note: a second thing derived from this slug must
  // pass a different channel, or the two would move together and read as a mistake rather than a hand.
  const index = Math.min(
    PLATE_BUTI.length - 1,
    Math.floor(hashUnit(slug, "buti") * PLATE_BUTI.length)
  );
  const buti = BUTI_BY_ID[PLATE_BUTI[index] ?? "ambi"];

  /*
   * A small turn, on its OWN hash channel.
   *
   * ⚠ NOT DECORATION — IT IS WHAT STOPS THE PLATE READING AS A BUG. There are four blocks and sixteen
   * crafts without a photograph, so repeats are certain, and the list is ordered by relevance rather
   * than by anything that separates them: two neighbouring rows drawing an identical mango looked like
   * one row rendered twice. A few degrees of rotation reads as two impressions of the same block,
   * which is what a printed field actually looks like.
   *
   * `hashRange` with "rotate" as the channel, per its own note: deriving the turn from the same hash
   * that chose the block would correlate them, so every ambi would lean the same way and the field
   * would look mechanical instead of hand-printed.
   */
  const rotation = hashRange(-9, 9, slug, "rotate");
  const centre = BUTI_BOX / 2;

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${BUTI_BOX} ${BUTI_BOX}`}
      // Sized in `em` off the card's own font size rather than a fixed pixel box, so the plate holds
      // its proportion in every slot `EntityCard` is rendered at without a second size prop to keep
      // in step with `sizes`.
      className="h-[3.5em] w-[3.5em] text-purple-700/35"
    >
      {/*
        The `datta` block — the raised face that lays solid colour — and then the `rekh`, the finer
        outline printed over it in a second pass. Drawing both in one colour at two opacities is the
        honest reduction: this is a stand-in, not a reproduction of a two-block print.
      */}
      <g transform={`rotate(${rotation.toFixed(2)} ${centre} ${centre})`}>
        {buti.solid.map((d) => (
          <path key={d} d={d} fill="currentColor" />
        ))}
        {buti.line.map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.7}
          />
        ))}
      </g>
    </svg>
  );
}
