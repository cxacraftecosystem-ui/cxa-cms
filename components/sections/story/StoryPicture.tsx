/**
 * StoryPicture — "the picture this block was configured with", whichever of the two sources it came
 * from, and an honest sentence when it came from neither.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULE IT EXISTS TO STATE ONCE: AN UPLOADED ASSET ALWAYS WINS.
 *
 * The four narrative blocks each let a picture come from either of two places (see `craftImageSlug`
 * in lib/sections/schema.ts):
 *
 *   • `mediaId` — a `MediaAsset` an editor uploaded, resolved through the batched read and served
 *     from the CDN. Its alt text is the editor's, and replacing the asset changes every page that
 *     shows it without anybody editing a payload.
 *   • `craftImage` — a slug from the bundled manifest: an openly licensed photograph committed to
 *     `public/craft/`, with its attribution compiled in.
 *
 * Four renderers each deciding for themselves which one wins is four chances to decide differently,
 * and the symptom would be an editor uploading their own photograph of a loom and finding that one
 * block on the page still shows the bundled one. So the precedence lives here and nowhere else.
 *
 * ⚠ A `craftImage` NEVER CARRIES ITS CREDIT AS AN AFTERTHOUGHT. It is rendered through `CraftPhoto`,
 * which renders `ImageCredit` unconditionally — that is what makes publishing a CC BY photograph
 * lawful, and it is why these blocks must not compose `next/image` directly.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ AND A SLUG THAT NO LONGER EXISTS IS A STATED ABSENCE, NOT A GAP. Payloads outlive the picture
 * set: a slug retired from the manifest by a later run of the fetcher parses perfectly well and
 * resolves to nothing. `craftImage()` returns null and this renders the same "no picture" panel as
 * an unconfigured block — because a silent hole is indistinguishable from a bug (contract §1.6), and
 * an editor who cannot see that the picture is missing cannot put it back.
 *
 * A Server Component. `MediaImage` and `CraftPhoto` are both server-rendered, and the narrative
 * blocks' client pieces wrap this rather than containing it.
 */

import { ImageOff } from "lucide-react";

import { CraftPhoto } from "@/components/site/CraftPhoto";
import { MediaImage } from "@/components/ui/MediaImage";
import { craftImage } from "@/lib/media/craft-imagery";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import { cn } from "@/lib/utils";

export interface StoryPictureProps {
  /** A `MediaAsset` id from the payload. Wins over `craftSlug` whenever it resolves. */
  mediaId: string;
  /** A slug from `lib/media/craft-imagery.ts`. Used only when no uploaded asset resolved. */
  craftSlug: string;
  /** The batched read. `resolved.media` is keyed by asset id. */
  resolved: ResolvedSectionData | undefined;
  /** A CSS `aspect-ratio`. Both sources crop to it, so a row of pictures lines up. */
  aspect?: string;
  sizes: string;
  /** Only for a picture above the fold. */
  priority?: boolean;
  /** The site's own sentence under the picture. A craft photograph adds its credit beneath. */
  caption?: string;
  /** Marks the image for a parallax tween owned by an enclosing scope. Animates nothing itself. */
  parallax?: boolean;
  /**
   * Show a craft photograph's region line under the caption. `CraftPhoto`'s own control, forwarded.
   *
   * Like `creditOverlay` below, it means something on the craft branch only — an uploaded asset has
   * no region to show, so the flag is ignored there rather than invented. Default on, because the
   * narrative blocks that existed before this prop are craft-archive blocks where the region is part
   * of the story; a text block on an arbitrary page passes false.
   */
  showRegion?: boolean;
  /**
   * Put the credit ON the photograph rather than under it. For a full-bleed placement.
   *
   * ⚠ IT AFFECTS A CRAFT PHOTOGRAPH ONLY, and that asymmetry is real rather than an oversight. A
   * bundled photograph carries a licence obligation that must be discharged wherever it is placed,
   * so `CraftPhoto` always renders `ImageCredit` and the only question is where it goes. An UPLOADED
   * asset carries no such obligation — the Centre owns it, or has cleared it — so there is nothing
   * to overlay and the flag is ignored on that branch.
   *
   * It exists because a band spanning the window has no "under" to put a credit in: the strip below
   * it is the page's own ground, and a credit sitting there reads as belonging to whatever follows.
   */
  creditOverlay?: boolean;
  /**
   * Overrides the alt text. `""` marks the picture decorative, which is right when the caption
   * beside it already says the same words.
   */
  alt?: string;
  /** Classes for the outer frame. */
  className?: string;
  /**
   * What to say when there is no picture at all. Named after the block so the message points at the
   * thing an editor has to go and fix.
   */
  emptyLabel: string;
}

export function StoryPicture({
  mediaId,
  craftSlug,
  resolved,
  aspect,
  sizes,
  priority = false,
  caption,
  parallax = false,
  showRegion = true,
  creditOverlay = false,
  alt,
  className,
  emptyLabel
}: StoryPictureProps) {
  const asset = mediaId.trim() ? resolved?.media[mediaId.trim()] : undefined;

  if (asset) {
    return (
      <figure className={cn("m-0", className)}>
        <MediaImage
          media={asset}
          alt={alt}
          aspect={aspect ?? "none"}
          sizes={sizes}
          priority={priority}
          rounded="lg"
          className={cn("w-full border border-line-200 shadow-md", aspect ? "" : "h-full")}
          // The parallax marker goes on the `<img>` itself rather than the frame, because the frame
          // is what clips the travel. `MediaImage` passes `imageClassName` straight through.
          /*
           * ⚠ NO `will-change` HERE, AND THAT IS THE FIX RATHER THAN THE OMISSION.
           *
           * It used to be `will-change-transform scale-[1.18]`, keyed off the `parallax` prop — which
           * is a RENDER-TIME MARKER, not a signal that anything is currently moving. So the layer was
           * promoted for the whole life of the page: under reduced motion, when the GSAP chunk never
           * arrived, and while the chapter was nowhere near the viewport. A full-bleed 1600×900
           * photograph is roughly 5.8 MB of GPU memory as its own layer, and the corpus gives one
           * story eight chapters — tens of megabytes held for the visit, on the page that also pins a
           * rail.
           *
           * It bought nothing while animating either: GSAP's default `force3D: "auto"` already
           * promotes an element via `translate3d` for the duration of a tween and reverts it
           * afterwards, which IS "set while animating, cleared after" done by the library.
           */
          imageClassName={parallax ? "scale-[1.18]" : undefined}
        />
        {caption ? (
          <figcaption className="mt-3 text-sm leading-relaxed text-ink-500">{caption}</figcaption>
        ) : null}
      </figure>
    );
  }

  const craft = craftSlug.trim() ? craftImage(craftSlug.trim()) : null;

  if (craft) {
    return (
      <CraftPhoto
        image={craft}
        alt={alt}
        aspect={aspect}
        sizes={sizes}
        priority={priority}
        caption={caption}
        showRegion={showRegion}
        parallax={parallax}
        creditOverlay={creditOverlay}
        className={className}
        frameClassName="border border-line-200 shadow-md"
      />
    );
  }

  /*
   * Neither source produced anything. This is a normal state — a block added a minute ago, an asset
   * deleted from the library, a manifest slug retired — and it is stated rather than left blank.
   *
   * `role="img"` with no label would be a nameless graphic in the accessibility tree, and
   * `aria-hidden` would hide the one thing telling an editor what is wrong. So it is neither: it is
   * an ordinary box with ordinary text in it, which every reader gets.
   */
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-200 bg-surface-100 p-8 text-center",
        className
      )}
      style={aspect ? { aspectRatio: aspect } : undefined}
    >
      <ImageOff aria-hidden="true" className="h-6 w-6 text-ink-300" />
      <p className="text-xs font-medium text-ink-500">{emptyLabel}</p>
    </div>
  );
}
