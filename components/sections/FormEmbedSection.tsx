"use client";

/**
 * FormEmbedSection — a Google Form, Microsoft Form or Typeform, which is how a small institution
 * actually collects applications.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE RULES, AND NONE OF THEM IS A PREFERENCE.
 *
 *  1. **THE HOST IS ON AN ALLOW-LIST.** An arbitrary page rendered in a frame on
 *     `centre.example/apply` is under somebody else's control while wearing the Centre's domain, its
 *     padlock and its header. That is not "an embed with a risk attached" — it is the whole
 *     construction of a credential-harvesting page, and every instinct we teach a reader ("check the
 *     address bar") returns the wrong answer inside it. The list lives in `lib/sections/schema.ts`
 *     beside the payload, so the schema, the studio's editor and this renderer reach one verdict; a
 *     host that is not on it is offered as an ORDINARY LINK instead, which is safe precisely because a
 *     link shows its destination and leaves our origin.
 *
 *  2. **CLICK TO LOAD, NEVER AN EAGER FRAME.** A third-party form mounted on page view is a request to
 *     Google for every visitor who was only reading, hands that visitor's address and referrer to a
 *     third party without being asked, and is reliably the heaviest thing on the page it sits on. So
 *     the card starts as a poster we draw ourselves, naming the host that will be contacted, and the
 *     frame mounts on a press. Same argument, same shape, as `EmbedSection`.
 *
 *  3. **THE PLAIN LINK IS ALWAYS THERE.** Rendered in every state — before the frame is opened, after
 *     it is opened, when the host is refused, and when a reader's browser or extension blocks frames
 *     outright. It is also the honest answer for anybody using a screen reader, for whom entering a
 *     nested application form inside a page is measurably worse than opening it in its own tab. An
 *     application that can only be reached through an `<iframe>` is an application some people cannot
 *     make at all.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `title` IS REQUIRED once there is a URL — enforced in the schema, as one of the only two conditional
 * requirements in that file. A screen reader announces an untitled frame as "frame", which tells the
 * reader nothing about whether entering it is worth their time. Here it does double duty as the visible
 * heading, so there is no way to have a labelled frame and an unlabelled card.
 *
 * ⚠ THE SANDBOX IS NARROW ON PURPOSE, and it may be narrower than some future provider needs. That is
 * an acceptable trade only BECAUSE of rule 3: an over-tight sandbox degrades to "use the link", never
 * to "you cannot apply". Widen it only against a provider that has actually been observed to need it,
 * and say which in a comment.
 */

import { useState } from "react";
import type { PageSection } from "@prisma/client";
import { ExternalLink, FileInput, TriangleAlert } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { Button } from "@/components/ui/Button";
import { sectionLabel } from "@/lib/sections/registry";
import {
  describeFormHosts,
  formHostAllowed,
  type FormEmbedProvider,
  type FormEmbedSectionData
} from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

/** Complete literal class strings — an `h-[${n}rem]` built from data is purged (contract §5). */
const HEIGHT_CLASS: Record<FormEmbedSectionData["height"], string> = {
  sm: "h-[28rem]",
  md: "h-[38rem]",
  lg: "h-[48rem]",
  xl: "h-[62rem]"
};

/**
 * What may be done with the address an editor pasted.
 *
 * A discriminated union rather than a bag of optional fields, so the component cannot render a frame
 * for a target that has no `src` — the case that would otherwise put `undefined` in an iframe's source
 * and load our own page inside itself.
 */
export type FormTarget =
  | {
      kind: "embed";
      /** The frame's source, carrying the provider's own "this is embedded" parameter. */
      src: string;
      /** The address for the plain link — the ORIGINAL, without the embed parameter. */
      href: string;
      /** Named on the poster, so nobody is surprised by the request. */
      host: string;
    }
  | { kind: "link"; href: string; host: string; reason: string }
  | { kind: "none"; reason: string };

/**
 * Decide what to do with `url` for `provider`.
 *
 * Exported because the studio's editor form shows the reader exactly the verdict this renderer will
 * reach, while the URL is still being typed. Two copies of this decision would disagree the first time
 * either one learned about a new provider — and one of the two copies is a security check.
 */
export function resolveFormTarget(provider: FormEmbedProvider, rawUrl: string): FormTarget {
  const trimmed = rawUrl.trim();
  if (trimmed === "") {
    return { kind: "none", reason: "This form block has no address yet." };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      kind: "none",
      reason:
        "This form block has an address that could not be read. Paste the whole address, starting with https://."
    };
  }

  // https only. Every one of these services is https-only, and a form collecting somebody's name,
  // address and date of birth over plain http is not something a pasted link should be able to publish.
  if (url.protocol !== "https:") {
    return {
      kind: "none",
      reason: `This form's address starts with ${url.protocol} rather than https://. A form that collects personal details has to be on a secure address.`
    };
  }

  const host = url.hostname.replace(/^www\./, "");

  if (!formHostAllowed(provider, host)) {
    return {
      kind: "link",
      href: url.toString(),
      host,
      // `describeFormHosts` writes the sentence, so the studio and the page word the refusal identically.
      reason:
        provider === "other"
          ? describeFormHosts(provider)
          : `This form is on ${host}, which is not shown inside the page. ${describeFormHosts(provider)}`
    };
  }

  // The provider's own "I am inside a frame" parameter, which drops their page chrome and leaves the
  // questions. `searchParams.set` rather than string concatenation, so a share link that already carries
  // parameters keeps them. The plain link deliberately does NOT get the parameter: a reader opening the
  // form in its own tab wants the provider's ordinary page.
  const framed = new URL(url.toString());
  if (host === "docs.google.com") framed.searchParams.set("embedded", "true");
  if (host === "forms.office.com" || host === "forms.microsoft.com") {
    framed.searchParams.set("embed", "true");
  }

  return { kind: "embed", src: framed.toString(), href: url.toString(), host };
}

export interface FormEmbedSectionProps {
  data: FormEmbedSectionData;
  /** Unused beyond the anchor id — a FORM_EMBED block needs no resolved rows. */
  section: PageSection;
}

export function FormEmbedSection({ data, section }: FormEmbedSectionProps) {
  const [opened, setOpened] = useState(false);

  const title = data.title.trim();
  const description = data.description.trim();
  const target = resolveFormTarget(data.provider, data.url);

  const linkLabel = data.openInNewTabLabel.trim() || "Open the form in a new tab";
  // The spoken warning is added only when the visible words do not already carry it, so the default
  // label is not read out as "Open the form in a new tab (opens in a new tab)".
  const announceNewTab = !/new tab/i.test(linkLabel);

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        <Reveal className="mx-auto max-w-3xl">
          {/*
            The title is the heading AND the frame's label. A cleared title is taken off screen rather
            than invented — the block's own name from `SECTION_REGISTRY` keeps the `<h2>` in the outline,
            because a page whose heading levels skip is a page a screen-reader user cannot navigate
            (contract §11).
          */}
          <SectionHeading
            title={title || sectionLabel(section.type)}
            titleClassName={title ? undefined : "sr-only"}
            description={description || undefined}
          />

          <div className="mt-8">
            {target.kind === "none" ? (
              <div className="flex items-start gap-3 rounded-lg border border-dashed border-line-200 bg-surface-50 px-5 py-4">
                <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
                <p className="text-sm leading-relaxed text-ink-500">{target.reason}</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-line-200 bg-card shadow-sm">
                {target.kind === "embed" && opened ? (
                  <iframe
                    src={target.src}
                    // The frame's only description. Never "Form" — see the header.
                    title={title || "Embedded form"}
                    loading="lazy"
                    referrerPolicy="strict-origin-when-cross-origin"
                    /*
                      THE NARROWEST SET THAT STILL LETS A FORM BE SUBMITTED.
                        • allow-forms      — the submit itself.
                        • allow-scripts    — every one of these providers is a JavaScript application.
                        • allow-same-origin — lets the provider's page reach ITS OWN storage and cookies.
                          Safe here because the frame's origin is the provider's, never ours; the
                          allow-list above is what guarantees that. (Paired with `allow-scripts` on a
                          SAME-origin frame the two would cancel the sandbox out — which is exactly why
                          this block refuses to frame anything but a known third party.)
                        • allow-popups + allow-popups-to-escape-sandbox — a file-upload question and a
                          sign-in step both open a window, and a popup inherits the sandbox unless told
                          otherwise, so without the second flag the window opens and cannot work.

                      Deliberately ABSENT: allow-top-navigation (a framed page must never be able to
                      move the reader's whole tab), allow-modals, allow-downloads, allow-pointer-lock.
                    */
                    sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                    /*
                      An EMPTY permissions policy: no camera, no microphone, no geolocation, no payment
                      handler. A form that needs any of those is not a form this block should be
                      carrying, and the plain link below is where such a form belongs.
                    */
                    allow=""
                    className={cn("w-full border-0", HEIGHT_CLASS[data.height])}
                  />
                ) : (
                  /*
                    THE POSTER. Its height is not reserved at the frame's full height on purpose: a
                    48rem empty card, held open in case somebody presses the button, is a page-long hole
                    for every reader who does not. The box growing when the form opens is a change the
                    reader asked for a moment earlier.
                  */
                  <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
                    <span
                      aria-hidden="true"
                      className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-purple-50 text-purple-700"
                    >
                      <FileInput className="h-5 w-5" />
                    </span>

                    {target.kind === "embed" ? (
                      <>
                        <Button onClick={() => setOpened(true)}>Open the form</Button>
                        <p className="prose-measure text-sm leading-relaxed text-ink-500">
                          The form is not loaded until you open it. Opening it loads it from{" "}
                          {target.host}.
                        </p>
                      </>
                    ) : (
                      // A refused host, or a service we do not recognise. No frame, and the sentence
                      // says which hosts ARE shown in the page, so an editor reading their own page can
                      // see what to change (contract §1.6 — never leave a gap that explains nothing).
                      <p className="prose-measure text-sm leading-relaxed text-ink-500">
                        {target.reason}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/*
            ALWAYS RENDERED where there is an address at all — see rule 3 in the header. It is the route
            through for a reader whose browser blocks frames, for an extension that strips them, and for
            anyone who would simply rather fill the form in on the provider's own page.
          */}
          {target.kind !== "none" ? (
            <p className="mt-4 text-sm">
              <a
                href={target.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-medium text-purple-700 transition-colors hover:text-purple-800"
              >
                <ExternalLink aria-hidden="true" className="h-4 w-4 shrink-0" />
                {linkLabel}
                {announceNewTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
              </a>
            </p>
          ) : null}
        </Reveal>
      </div>
    </section>
  );
}
