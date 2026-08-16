/**
 * DocumentEmbedSection — one uploaded document, placed on the page where the editor put it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A BROWSER RENDERS A PDF. IT RENDERS NOTHING ELSE, AND THIS BLOCK SAYS SO OUT LOUD.
 *
 * There is no built-in PowerPoint, Word or OpenDocument renderer in any browser, so a block that
 * framed one would draw an empty box, or start a download the reader did not ask for, and look for
 * all the world like a broken page. Three consequences, all of them deliberate:
 *
 *  1. **A PDF is framed.** Native `<iframe>`, the browser's own viewer, no dependency added. pdf.js
 *     would be a ~1 MB parser and viewer shipped to every reader of every page carrying this block,
 *     to reimplement something Chrome, Firefox, Safari and Edge have all had for a decade. The one
 *     thing it would buy — a preview on a browser with the viewer disabled — is already covered by
 *     the link, which is on screen in every state.
 *  2. **Anything else is a DOWNLOAD CARD** naming the file, its type and its size, with the same
 *     link. Not a frame that fails quietly: the card states in words that the format cannot be shown
 *     in a browser, so a reader knows the page is finished and an editor knows the block is working.
 *  3. **⚠ NO THIRD-PARTY VIEWER.** Office Online (`view.officeapps.live.com/op/embed.aspx?src=…`)
 *     and Google's Docs Viewer both render a PowerPoint in a frame, and both do it by FETCHING THE
 *     DOCUMENT FROM OUR STORAGE INTO THEIRS. Every deck an editor placed on a page — including one
 *     published early, or withdrawn an hour later — would be handed to Microsoft or Google and cached
 *     there, from a public URL neither we nor the reader can recall. That is a decision for the Centre
 *     to take knowingly, if ever, and not one for a section renderer to take on their behalf.
 *
 * WHAT A REAL PREVIEW WOULD COST, so the option is on the record rather than rediscovered: a
 * server-side conversion step at upload, in `lib/storage/derivatives.ts` beside the image pipeline —
 * `soffice --headless --convert-to pdf` from LibreOffice, writing a PDF derivative under the
 * original's variant prefix, which this block would then frame exactly as it frames a PDF today. The
 * price is a LibreOffice install in the runtime image (several hundred megabytes, and the reason the
 * conversion cannot run on a serverless function), tens of seconds of CPU per deck, a fourth
 * derivative kind with its own failure reporting (rule 4 of that file), and fonts — a deck converted
 * without its typefaces comes out reflowed and wrong, which is worse than a download card.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ AN `<iframe>`, NEVER AN `<object>` OR AN `<embed>`. `next.config.ts` sets `object-src 'none'` on
 * every response, so an `<object data=…>` — the shape most examples of PDF embedding reach for — is
 * blocked by the browser and draws nothing at all, with a console message as the only trace. The CSP
 * carries no `frame-src` and no `default-src`, so the `<iframe>` is unrestricted; that is why the
 * choice between the two tags is not a matter of taste here.
 *
 * ⚠ NO `sandbox` ATTRIBUTE, WHICH IS A DEPARTURE FROM `FormEmbedSection` AND NEEDS ITS REASON. A
 * sandboxed frame has no plugin access, and Chrome's PDF viewer will not render inside one — the
 * frame comes up blank, which is the exact failure this block exists to prevent, and it fails on the
 * majority browser. What a sandbox would buy is protection against a hostile PDF; what makes that
 * acceptable to forgo is that the frame's origin is the object store's public base, NOT this site's,
 * so nothing inside it can reach this page, its cookies or its session, and the documents are
 * uploaded by signed-in staff through the media library rather than by the public.
 *
 * A SERVER COMPONENT. Nothing here holds state or a handler: the frame is a static document on our
 * own CDN, so there is no third-party request to defer behind a press the way `EmbedSection` and
 * `FormEmbedSection` must. `loading="lazy"` does the deferring instead, in the browser, with no
 * JavaScript of ours — a 30 MB report is not fetched until the reader has scrolled near it, and a
 * reader who never gets there never pays for it.
 *
 * THE LINK IS RENDERED IN EVERY STATE WHERE THERE IS A DOCUMENT. It is the way through for a reader
 * whose browser has the PDF viewer switched off, for one using a screen reader (for whom a document
 * opened in its own tab is measurably better than one nested inside a page), and for anyone who
 * wants the file rather than a look at it. Its words carry the size, so nobody starts a 40 MB
 * download on a phone by accident — the same rule `DownloadsSection` states for the file store.
 */

import type { PageSection } from "@prisma/client";
import { Download, FileText, Presentation, TriangleAlert, type LucideIcon } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import { cdnConfigured, publicObjectUrl } from "@/lib/media/url";
import { sectionLabel } from "@/lib/sections/registry";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import {
  documentFormat,
  type DocumentEmbedSectionData,
  type DocumentFormat
} from "@/lib/sections/schema";
import { cn, formatBytes } from "@/lib/utils";

export interface DocumentEmbedSectionProps {
  data: DocumentEmbedSectionData;
  section: PageSection;
  /** The batched read from `lib/sections/resolve.ts`; `resolved.media` is keyed by ASSET id. */
  resolved?: ResolvedSectionData;
}

/**
 * How tall the frame is.
 *
 * Complete literal class strings, and a pair per size — an `h-[${n}rem]` assembled from the payload
 * is purged by Tailwind and leaves an unstyled frame (contract §5).
 *
 * ⚠ EVERY SIZE IS SHORTER ON A PHONE, and that is not a detail. A frame taller than the viewport is
 * a scrolling document inside a scrolling page: a reader's flick either moves the page or moves the
 * document depending on where their thumb landed, and on the tallest setting the block would be two
 * full screens of somebody else's scrollbar. The document scrolls internally at every size, so a
 * shorter frame costs nothing but the number of lines visible at once.
 */
const HEIGHT_CLASS: Record<DocumentEmbedSectionData["height"], string> = {
  sm: "h-[20rem] sm:h-[26rem]",
  md: "h-[26rem] sm:h-[40rem]",
  lg: "h-[30rem] sm:h-[54rem]",
  xl: "h-[34rem] sm:h-[70rem]"
};

/**
 * Everything this block says about the document, gathered once.
 *
 * The format itself comes from `documentFormat()` in `lib/sections/schema.ts` rather than from a
 * table here, so the studio's form promises exactly what this renderer delivers — see that
 * function's own header for why one copy rather than two.
 */
interface DocumentFacts extends DocumentFormat {
  /** The name the reader sees and the file saves as. */
  fileName: string;
  size: string;
  icon: LucideIcon;
}

function factsOf(asset: { fileName: string; objectKey: string; byteSize: number }): DocumentFacts {
  const format = documentFormat(asset.fileName, asset.objectKey);
  return {
    ...format,
    fileName: asset.fileName.trim() || "Document",
    size: formatBytes(asset.byteSize),
    icon: format.isPresentation ? Presentation : FileText
  };
}

export function DocumentEmbedSection({ data, section, resolved }: DocumentEmbedSectionProps) {
  const asset = data.mediaId ? resolved?.media[data.mediaId] : undefined;
  const title = data.title.trim();
  const description = data.description.trim();

  // `publicObjectUrl` answers null where no public storage base is configured, and returning a
  // plausible relative path instead is the failure its own header refuses (lib/media/url.ts). Null
  // here therefore means "cannot be addressed", which the notice below states rather than papers over.
  const href = asset ? publicObjectUrl(asset.objectKey) : null;
  const facts = asset ? factsOf(asset) : null;

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        <Reveal className="mx-auto max-w-4xl">
          {/*
            The title is the heading AND the frame's accessible name. A cleared title is taken off
            screen rather than invented: the block's own name from `SECTION_REGISTRY` keeps the `<h2>`
            in the outline, because a page whose heading levels skip is one a screen-reader user
            cannot navigate (contract §11).
          */}
          <SectionHeading
            title={title || sectionLabel(section.type)}
            titleClassName={title ? undefined : "sr-only"}
            description={description || undefined}
          />

          <div className="mt-8">
            {asset === undefined || facts === null ? (
              <Unavailable
                reason={
                  data.mediaId === ""
                    ? "No document has been chosen for this block yet."
                    : "The document chosen for this block is no longer in the media library, so there is nothing to show. Choose it again in the studio, or take the block off the page."
                }
              />
            ) : href === null ? (
              <Unavailable
                // The reader gets a sentence they can act on; the `title` names the cause for whoever
                // has to fix it, exactly as `MediaImage` does for a picture that cannot be addressed.
                title={
                  cdnConfigured()
                    ? "This asset has no public URL, so the document cannot be addressed."
                    : "No CDN or public storage base URL is configured, so stored documents cannot be addressed."
                }
                reason={`“${facts.fileName}” cannot be reached from this site at the moment. Nothing has been deleted — please tell the Centre if this does not right itself.`}
              />
            ) : facts.previewable ? (
              <>
                <div className="overflow-hidden rounded-lg border border-line-200 bg-card shadow-sm">
                  <iframe
                    src={href}
                    /*
                      THE FRAME'S ONLY DESCRIPTION, and the reason the schema makes `title`
                      conditionally required. A screen reader announces an untitled frame as "frame".
                      The fallback is never reached on a saved payload — it exists for the studio's
                      recovery path, which can hand a preview an unparsed row.
                    */
                    title={title || `${facts.label}: ${facts.fileName}`}
                    // See the header: not fetched until the reader is near it, in the browser, with
                    // no JavaScript of ours and no click for anybody to have to find.
                    loading="lazy"
                    className={cn("w-full border-0", HEIGHT_CLASS[data.height])}
                  />
                </div>

                {/*
                  The way through for a reader whose PDF viewer is switched off, whose extension
                  strips frames, or who would simply rather have the file. Exactly ONE link is
                  rendered per block: the download card carries its own, and a second copy beside it
                  would read to a screen reader as two different destinations.
                */}
                <DocumentLink facts={facts} href={href} downloadLabel={data.downloadLabel} />
              </>
            ) : (
              <DownloadCard facts={facts} href={href} downloadLabel={data.downloadLabel} />
            )}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/**
 * A block with no document behind it.
 *
 * It states its emptiness on screen rather than rendering nothing (contract §1.6): a block that
 * quietly disappears is indistinguishable from one nobody finished, and the editor who left it half
 * done is the person most likely to be reading the page.
 */
function Unavailable({ reason, title }: { reason: string; title?: string }) {
  return (
    <div
      title={title}
      className="flex items-start gap-3 rounded-lg border border-dashed border-line-200 bg-surface-50 px-5 py-4"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
      <p className="text-sm leading-relaxed text-ink-500">{reason}</p>
    </div>
  );
}

/**
 * What a format no browser can draw looks like.
 *
 * ⚠ IT SAYS WHY, IN WORDS. "PowerPoint presentation — 4.2 MB" beside a button would leave a reader
 * wondering whether the preview failed to load; naming the limitation is the difference between a
 * page that is finished and a page that looks broken. The sentence names the format rather than
 * saying "this file type", because "PowerPoint files cannot be shown inside a web page" is a fact a
 * reader can carry away and an editor can act on.
 */
function DownloadCard({
  facts,
  href,
  downloadLabel
}: {
  facts: DocumentFacts;
  href: string;
  downloadLabel: string;
}) {
  const Icon = facts.icon;

  return (
    <div className="rounded-lg border border-line-200 bg-card p-6 shadow-sm">
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-purple-50 text-purple-700"
        >
          <Icon className="h-5 w-5" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="display-title break-words text-base leading-snug">{facts.fileName}</p>

          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-500">
            <Badge size="sm">{facts.label}</Badge>
            <span className="tabular-nums">{facts.size}</span>
          </p>

          <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-500">
            {facts.isPresentation
              ? `A ${facts.label.toLowerCase()} cannot be shown inside a web page — no browser can draw one — so it is offered here as a download. It opens in PowerPoint, Keynote, LibreOffice Impress or Google Slides.`
              : `This format cannot be shown inside a web page, so it is offered here as a download. Only PDFs can be read on the page itself.`}
          </p>

          <p className="mt-4">
            {/*
              A PLAIN `<a>` WEARING THE BUTTON'S CLASSES, WHICH `buttonClasses` ITSELF ADVISES
              AGAINST — it says to reach for `LinkButton` instead, and the exception is worth stating.
              `LinkButton` routes any href beginning with `/` through `next/link`, and
              `NEXT_PUBLIC_CDN_URL` may legitimately be a same-origin path in a deployment that
              proxies its bucket. The client router would then ask this address for an RSC payload
              and get a document — the trap `DownloadsSection` documents for the file store's links.
            */}
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses({ variant: "primary" })}
            >
              {/* The file's own glyph is above; the action here is the download. */}
              <Download aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span>{downloadLabel.trim() || `Download the ${facts.label.toLowerCase()}`}</span>
              <span className="sr-only">
                {" "}
                — {facts.fileName}, {facts.size} (opens in a new tab)
              </span>
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The plain link under a framed document.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ NO `download` ATTRIBUTE ON EITHER OF THIS FILE'S LINKS, AND THE REASON IS THAT IT WOULD NOT
 * WORK. `download` is honoured only for a SAME-ORIGIN url (and for `blob:`/`data:`); against a
 * cross-origin address every browser has ignored it since 2018. These documents are served from the
 * object store's public base, which is a different origin from the site by construction — that is
 * the very property that lets a PDF render in the frame above (see the file header). So the
 * attribute would be a promise the browser silently declines: the reader would get a navigation,
 * which is what they get anyway, and whoever added it would believe a save dialogue was guaranteed.
 *
 * `target="_blank"` INSTEAD, with the pair and the announcement. It is right in both directions a
 * click can go: the browser either shows the document in the new tab or saves it and closes the tab
 * itself, and either way the page the reader was on is still there behind it. Announcing the new tab
 * is not politeness — focus landing in a new tab unannounced loses a screen-reader user their place
 * and their Back button.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE FORMAT AND SIZE ARE INSIDE THE LINK'S OWN TEXT rather than beside it, so both are announced to
 * somebody tabbing through the page or reading a list of its links out of context — where "Download
 * the document" on its own says neither what it is nor what it will cost them.
 *
 * A plain `<a>` rather than `LinkButton` for the reason set out on the download card above.
 */
function DocumentLink({
  facts,
  href,
  downloadLabel
}: {
  facts: DocumentFacts;
  href: string;
  downloadLabel: string;
}) {
  return (
    <p className="mt-4 text-sm">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 font-medium text-purple-700 transition-colors hover:text-purple-800"
      >
        <Download aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>
          {downloadLabel.trim() || "Download the document"} ({facts.label}, {facts.size})
          <span className="sr-only"> (opens in a new tab)</span>
        </span>
      </a>
    </p>
  );
}
