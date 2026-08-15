/**
 * ImageCredit — the line under a photograph that makes publishing it lawful.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS COMPONENT IS A LICENCE OBLIGATION, NOT A DESIGN FLOURISH.
 *
 * Every photograph in `lib/media/craft-imagery.ts` comes from Wikimedia Commons, and most of them are
 * under a Creative Commons BY or BY-SA licence. Those licences grant the right to publish on one
 * condition, stated in §3(a) of the CC 4.0 text and its equivalents in earlier versions: retain the
 * creator's name, the licence, and a link to the material. Omitting it is not a missing caption — it
 * is publishing somebody's work outside the terms they offered it under.
 *
 * So the rule for this repository is: **a picture from the craft manifest never appears without this
 * component under it.** `CraftPhoto` renders it automatically, which is why that is the component
 * pages should reach for rather than composing `next/image` by hand.
 *
 * WHAT COUNTS AS "REASONABLE TO THE MEDIUM". The licences allow attribution to be satisfied by a link
 * to a page carrying the details, but a credit beside the picture costs one line and removes the
 * argument. `/credits` lists every photograph in one place for the same reason.
 *
 * PUBLIC-DOMAIN WORKS ARE STILL CREDITED. Nothing obliges it, and it is still right: a reader who
 * wants the original needs the link, and an editor who wants to know whether a picture may be
 * reused needs to see which of the two cases it is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No `"use client"`. It renders text and two links, in a Server Component, on every page it appears.
 */

import type { CraftImage } from "@/lib/media/craft-imagery";
import { cn } from "@/lib/utils";

/**
 * The value `scripts/fetch-craft-imagery.ts` canonicalises an unknown or anonymous author to.
 *
 * ⚠ It must match `UNKNOWN_AUTHOR` in that script. The two are compared as strings across a generated
 * file, so a change in one place and not the other prints the literal word "Unknown" under a
 * photograph as though it were the photographer's surname — which is exactly what the first draft of
 * the manifest did.
 */
const UNKNOWN_AUTHOR = "Unknown";

/** Licences that grant rights without conditions, so the credit is courtesy rather than obligation. */
const UNCONDITIONAL = new Set(["Public domain", "CC0", "CC PDM 1.0", "PD-USGov"]);

export interface ImageCreditProps {
  image: CraftImage;
  /**
   * `inline` sits under a caption in body text. `overlay` sits on top of a full-bleed photograph and
   * carries its own scrim, because a credit over an unknown image is a contrast failure waiting to
   * happen — the photograph underneath can be any colour at all.
   */
  variant?: "inline" | "overlay";
  className?: string;
}

export function ImageCredit({ image, variant = "inline", className }: ImageCreditProps) {
  const named = image.author !== UNKNOWN_AUTHOR && image.author.length > 0;
  const unconditional = UNCONDITIONAL.has(image.licence);

  return (
    <p
      className={cn(
        "text-[0.6875rem] leading-relaxed",
        variant === "inline" && "text-ink-500",
        // The scrim is on the TEXT rather than the frame: a band across the foot of the photograph
        // would hide part of the picture even where the credit is two words long.
        //
        // ⚠ `purple-950` AND NOT `ink-900`, AND THIS IS A CORRECTNESS FIX RATHER THAN A COLOUR
        // PREFERENCE. `ink-900` is a THEMED neutral: it is `30 27 46` in light and `242 240 249` in
        // dark, because the whole ink ladder inverts. Paired with the fixed `text-white` below, the
        // chip therefore became a near-WHITE plate carrying WHITE text in dark theme — an attribution
        // nobody can read, on the one element whose entire job is to satisfy a licence.
        //
        // It cannot track the theme at all, because what sits behind it is a PHOTOGRAPH and can be any
        // colour: the text is unconditionally white, so its scrim must be unconditionally dark.
        // `purple-950` is defined once in `:root` and never in the dark block, and pairing it with
        // `text-white` as a literal brand class is the established pattern for exactly this situation
        // (the hero bands and the footer do it — see the print-stylesheet note in globals.css). It is
        // also already the ground colour laid under photographs by the hero and the parallax banner,
        // so the chip reads as part of the picture's own furniture rather than a grey box on top of it.
        variant === "overlay" &&
          "inline-block rounded-sm bg-purple-950/70 px-2 py-1 text-white backdrop-blur-sm",
        className
      )}
    >
      {named ? (
        <>
          {unconditional ? "Photograph by " : "Photograph © "}
          <span className="font-medium">{image.author}</span>
          {", "}
        </>
      ) : null}

      {image.licenceUrl ? (
        <a
          href={image.licenceUrl}
          target="_blank"
          rel="license noopener noreferrer"
          className={cn(
            "underline underline-offset-2",
            variant === "inline" ? "decoration-line-200 hover:text-purple-700" : "decoration-white/40"
          )}
        >
          {image.licence}
        </a>
      ) : (
        image.licence
      )}

      {", via "}
      <a
        href={image.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "underline underline-offset-2",
          variant === "inline" ? "decoration-line-200 hover:text-purple-700" : "decoration-white/40"
        )}
      >
        Wikimedia Commons
      </a>
      {/*
        Both links leave the site in a new tab, and both say so. A `target="_blank"` with nothing
        spoken is a reader who has lost their place with no explanation (contract §11) — and this
        text is small and easy to overlook precisely because it is not the content.
      */}
      <span className="sr-only"> (opens in a new tab)</span>.
    </p>
  );
}
