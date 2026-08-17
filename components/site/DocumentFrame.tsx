import { cn } from "@/lib/utils";

/**
 * The one `<iframe>` in this application that shows a document, and every decision behind it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ EXTRACTED SO THERE IS EXACTLY ONE. Two places now frame a PDF — a DOCUMENT_EMBED block on a page and
 * a publication's full text — and the four decisions below are not obvious enough to survive being made
 * twice. A second copy would be a second set of security assumptions, and the first time one of them was
 * revised the other would keep the old one silently.
 *
 * ⚠ AN `<iframe>`, NEVER AN `<object>` OR AN `<embed>`. `next.config.ts` sets `object-src 'none'` on every
 * response, so an `<object data=…>` — the shape most examples of PDF embedding reach for — is blocked by
 * the browser and draws nothing at all, with a console message as the only trace. The CSP carries no
 * `frame-src` and no `default-src`, so the `<iframe>` is unrestricted; the choice between the tags is not
 * a matter of taste here.
 *
 * ⚠ NO `sandbox` ATTRIBUTE, WHICH IS A DEPARTURE FROM `FormEmbedSection` AND CARRIES A CONDITION. A
 * sandboxed frame has no plugin access and Chrome's PDF viewer will not render inside one — the frame
 * comes up blank, on the majority browser, which is the exact failure a preview exists to prevent. What a
 * sandbox would buy is protection against a hostile PDF, and what makes that acceptable to forgo is that
 * THE FRAMED DOCUMENT IS NOT ON THIS SITE'S ORIGIN: nothing inside it can reach the page, its cookies or
 * its session.
 *
 * ⚠ SO `src` MUST RESOLVE TO A DIFFERENT ORIGIN, AND THAT IS A REQUIREMENT ON THE CALLER RATHER THAN
 * SOMETHING THIS FILE CAN CHECK. Both callers satisfy it, differently:
 *
 *   • DOCUMENT_EMBED points straight at the object store's public base (`publicObjectUrl`).
 *   • A publication points at `/api/public/files/[slug]/inline`, which is on this origin but answers 302
 *     to a signed storage URL — so the document that ends up loaded is cross-origin. That route explains
 *     why it must stay a redirect rather than becoming a proxy, and this is the reason.
 *
 * A caller that streams bytes through its own origin would silently invalidate the paragraph above. If one
 * ever needs to, the sandbox question has to be reopened here, not worked around there.
 *
 * `loading="lazy"` DOES THE DEFERRING, in the browser, with no JavaScript of ours: a 30 MB report is not
 * fetched until the reader has scrolled near it, and a reader who never gets there never pays for it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export type DocumentFrameHeight = "sm" | "md" | "lg" | "xl";

/**
 * ⚠ NOT `h-screen` OR A VIEWPORT UNIT AT ANY SIZE. A frame as tall as the window makes a phone reader
 * scroll either the page or the document depending on where their thumb landed, and on the tallest
 * setting the block would be two full screens of somebody else's scrollbar. The document scrolls
 * internally at every size, so a shorter frame costs nothing but the number of lines visible at once.
 */
const HEIGHT_CLASS: Record<DocumentFrameHeight, string> = {
  sm: "h-[20rem] sm:h-[26rem]",
  md: "h-[26rem] sm:h-[40rem]",
  lg: "h-[30rem] sm:h-[54rem]",
  xl: "h-[34rem] sm:h-[70rem]"
};

export interface DocumentFrameProps {
  /** Must resolve to an origin other than this site's — see the header. */
  src: string;
  /**
   * The frame's ONLY description.
   *
   * A screen reader announces an untitled frame as "frame", which tells the reader nothing about what is
   * inside. Required rather than optional for that reason: there is no sensible default, and a caller with
   * nothing to say has a content problem rather than a markup one.
   */
  title: string;
  height?: DocumentFrameHeight;
  className?: string;
}

export function DocumentFrame({ src, title, height = "md", className }: DocumentFrameProps) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-line-200 bg-card shadow-sm", className)}>
      <iframe
        src={src}
        title={title}
        loading="lazy"
        className={cn("w-full border-0", HEIGHT_CLASS[height])}
      />
    </div>
  );
}
