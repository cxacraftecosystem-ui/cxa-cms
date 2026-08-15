import type { Metadata } from "next";
import Link from "next/link";
import {
  Accessibility,
  Contrast,
  CornerUpLeft,
  Keyboard,
  Languages,
  Map,
  SunMoon,
  Type,
  Waves
} from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { PageHero } from "@/components/site/PageHero";
import { SectionHeading } from "@/components/site/SectionHeading";
import { pageMetadata } from "@/lib/seo";
import { cn } from "@/lib/utils";

/**
 * /accessibility — what has actually been built for readers with access needs, in enough detail to be
 * checked, and what has not.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY AN INSTITUTIONAL SITE OWES ITS READERS THIS PAGE, AND WHY IT EARNS ITS PLACE HERE IN
 * PARTICULAR.
 *
 * An accessibility statement is normally a compliance gesture. This one is a FINDING AID. The site
 * carries four preference controls, a skip link, a keyboard-reachable substitute for its map, a print
 * edition and a `lang` switch on every craft's local name — and a reader who needs any of that has no
 * way to discover it exists. A control nobody can find is a control nobody has. So the register here is
 * the same as the rest of the public site: plain sentences, no jargon, and every feature named where it
 * physically is on screen rather than described in the abstract.
 *
 * ⚠ EVERY CLAIM ON THIS PAGE WAS READ OUT OF THE IMPLEMENTATION, NOT REMEMBERED. A statement that
 * overstates is worse than no statement at all: it tells somebody with a need that a feature exists,
 * they fail to find it, and the reasonable conclusion they draw is that the site is broken and the
 * institution careless. The sources, so the next editor can re-verify rather than re-guess:
 *
 *   • the four controls and their wording  → components/ui/AccessibilityMenu.tsx
 *   • what is stored and how it is applied → lib/preferences.ts, components/providers/PreferencesProvider
 *   • the two unioned reduced-motion rules, the focus treatment, the high-contrast and larger-text
 *     blocks, and the print sheet at the foot → app/globals.css
 *   • the JavaScript half of the motion union → components/motion/useReducedMotionPreference.ts
 *   • inertia disabled outright rather than softened → components/motion/SmoothScroll.tsx
 *   • the skip link and its focusable target → app/(site)/layout.tsx
 *   • alt text, and the empty string as a MEANINGFUL value → lib/media/url.ts, components/ui/MediaImage
 *   • the report that finds undescribed images → lib/health.ts (`images-with-no-description`)
 *   • the map's list equivalent → components/site/CraftMap.tsx
 *   • disclosures unmount when closed → components/ui/Accordion.tsx
 *
 * ⚠ NO WCAG LEVEL IS CLAIMED, AND NONE MAY BE ADDED WITHOUT AN AUDIT TO POINT AT. Nobody has tested
 * this site against WCAG. A conformance level is a legal statement about work that has been done, not a
 * summary of intentions, and an unaudited claim is the one sentence on a page like this that can do
 * real harm. The same rule covers a compliance date, a review cycle and a response time: this page
 * commits the Centre to nothing it has not already built.
 *
 * ⚠ NO PATH INTO THE STUDIO IS NAMED. The section on images has to describe the editors' own
 * content-health report, because that report is the mechanism that finds a missing description — but
 * naming its address would be a visible route to the CMS written in words instead of in markup, which
 * contract §0 forbids just as firmly as a link element would be.
 *
 * ⚠ FEATURE-GATED SURFACES ARE DESCRIBED, NEVER LINKED. `/craft-explorer` is behind the
 * `craftExplorer` flag and answers 404 when an administrator switches it off; the header and footer
 * filter their menus for exactly that reason (see app/(site)/layout.tsx). A hard-coded link from this
 * page would have no such filter, so the craft archive is referred to by name only. `/contact` has no
 * flag on the page itself — only on its enquiry form — so that one is a real link.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A Server Component that reads nothing. `Reveal` is the only client piece, exactly as /credits.
 */

export const metadata: Metadata = pageMetadata({
  title: "Accessibility",
  description:
    "The reading controls this site provides — reduced motion, larger text, higher contrast, light and dark — how its keyboard and screen-reader support works, and the limits we know about.",
  path: "/accessibility"
});

/**
 * ⚠ Five minutes, matching /contact and every other settings-driven public page — and deliberately
 * NOT `force-static`, which is what /credits sets on the same reasoning about its own content.
 *
 * The prose below is compiled in and can only change when the bundle does, so on the page's own
 * content a static render would be correct. The FRAME is not: the shared (site) layout reads the
 * navigation tree, the footer columns and the Centre's postal address out of the settings document, and
 * a route with no revalidation window freezes all three at build time. A corrected address that never
 * appears on one page of the site is a worse fault than a re-render producing identical bytes.
 */
export const revalidate = 300;

const BREADCRUMBS = [
  { name: "Home", href: "/" },
  { name: "Accessibility", href: "/accessibility" }
] as const;

/**
 * Every link to a point on this page is a plain `<a href="#…">`, and never a `next/link`.
 *
 * The same decision the A–Z jump bar documents: a fragment link is the one piece of navigation the
 * platform has always done natively, so it works on a slow phone and with the bundle blocked — which
 * is precisely the state a reader who came to this page may be in. `next/link` would buy nothing here
 * and would make a contents list depend on the router. Links that leave for another route stay
 * `next/link`, because those genuinely are navigations.
 *
 * A complete literal class string. Anything assembled by concatenation is purged (contract §5), and
 * `cn()` is a plain join — a later utility does not win, so the one size override is appended rather
 * than replacing anything.
 */
const ANCHOR_LINK =
  "font-medium text-purple-700 transition-colors hover:text-purple-800";

/**
 * The sections, in reading order.
 *
 * ⚠ THE CONTENTS LIST AND THE HEADINGS ARE GENERATED FROM THIS ONE ARRAY, and that is the point of its
 * existing at all. A hand-written list of anchors beside a hand-written set of headings disagrees with
 * itself the first time a section is renamed, and the failure is silent: the link still looks like a
 * link and simply lands nowhere. `SectionHeading` stamps `data-anchor` alongside the id, which is what
 * makes globals.css pay `--nav-clearance` for the jump — never restate that as a `scroll-mt-*`
 * (contract §7).
 */
const SECTIONS = [
  { id: "controls", title: "The reading controls, and where they are" },
  { id: "motion", title: "Motion, and the two switches over it" },
  { id: "keyboard", title: "Keyboard and screen readers" },
  { id: "images", title: "Colour, and the descriptions on images" },
  { id: "print", title: "Printing a page" },
  { id: "claims", title: "What this statement does not claim" },
  { id: "limits", title: "Limits we know about" },
  { id: "reporting", title: "Telling us something is wrong" }
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** The heading text for one section. Never inlined at the call site — see the note on `SECTIONS`. */
function titleOf(id: SectionId): string {
  // `find` cannot miss: `SectionId` is derived from this array. The fallback exists because
  // noUncheckedIndexedAccess is on and a heading is not worth a crashed page over.
  return SECTIONS.find((section) => section.id === id)?.title ?? "";
}

export default function AccessibilityPage() {
  return (
    <>
      <PageHero
        eyebrow="Reading this site"
        title="Accessibility"
        description="This site can be read with less motion, in larger text, at higher contrast and in a dark or light palette, and the controls for all four are on every page. This is what has been built, where to find it, and what is still missing."
        breadcrumbs={BREADCRUMBS}
      />

      <section className="shell pb-24">
        <Reveal className="shell-narrow px-0">
          <div className="panel p-6 sm:p-8">
            <h2 className="display-title text-xl">How to read this page</h2>
            <p className="prose-measure mt-4 text-base leading-relaxed text-ink-700">
              Everything described below is in the site as it stands today, and each paragraph names
              the control or the behaviour precisely enough that you can go and check it. Where
              something works only partly, the same sentence says so — a statement that promises a
              feature a reader then cannot find is worse than no statement, because the fair conclusion
              to draw is that the site is broken.
            </p>
            <p className="prose-measure mt-4 text-base leading-relaxed text-ink-700">
              No conformance level is claimed anywhere on this page. Nobody has audited this site
              against WCAG or any other standard, so there is nothing honest to claim yet;{" "}
              <a href="#claims" className={ANCHOR_LINK}>
                what this statement does not claim
              </a>{" "}
              says what that does and does not mean for you.
            </p>

            <nav aria-label="On this page" className="mt-6 border-t border-line-200 pt-5">
              <h3 className="field-label">On this page</h3>
              <ul className="mt-3 flex flex-col gap-1.5">
                {SECTIONS.map((section) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`} className={cn(ANCHOR_LINK, "text-sm")}>
                      {section.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </Reveal>

        {/* ── The controls ──────────────────────────────────────────────────────────────────── */}
        <Reveal as="section" className="mt-14">
          {/* Level 2 throughout: `PageHero` above owns the page's one `<h1>` (contract §11). */}
          <SectionHeading
            level={2}
            id="controls"
            title={titleOf("controls")}
            description="Four settings, in one panel, reachable from two places on every page of the site."
          />

          <div className="shell-narrow mt-6 px-0">
            <p className="prose-measure text-base leading-relaxed text-ink-700">
              At the very foot of every page, beside the copyright line, there is a control labelled{" "}
              <strong>Accessibility</strong> — a small figure icon with the word spelled out next to it.
              That opens the panel. The same control sits in the floating bar at the top of every page,
              immediately after the search icon; up there it is the icon alone, with no visible word,
              though it is still named &ldquo;Accessibility&rdquo; for a screen reader or voice control.
              Both open the identical set of controls; there is no separate settings screen and nothing
              to sign in to.
            </p>

            <dl className="mt-6 divide-y divide-line-200 border-y border-line-200">
              <div className="py-5">
                <dt className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                  <SunMoon aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
                  Theme — Light, Dark or System
                </dt>
                <dd className="prose-measure mt-2 text-sm leading-relaxed text-ink-700">
                  Three buttons. <strong>System</strong> follows whatever your device is set to and
                  keeps following it, so a phone that turns dark in the evening turns this site dark
                  with it. Choosing Light or Dark pins the palette and stops it following the device.
                </dd>
              </div>

              <div className="py-5">
                <dt className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                  <Waves aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
                  Reduced motion
                </dt>
                <dd className="prose-measure mt-2 text-sm leading-relaxed text-ink-700">
                  Stops decorative animation, the parallax and scroll-driven effects on the longer
                  pages, and the smooth-scrolling inertia. It is described in full under{" "}
                  <a href="#motion" className={ANCHOR_LINK}>
                    motion
                  </a>
                  , because it works together with the setting on your own device rather than instead
                  of it.
                </dd>
              </div>

              <div className="py-5">
                <dt className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                  <Type aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
                  Larger text
                </dt>
                <dd className="prose-measure mt-2 text-sm leading-relaxed text-ink-700">
                  Raises the site&rsquo;s base text size by an eighth — from the usual sixteen pixels
                  to eighteen. It is not a font-size-only change: every measurement on the site is
                  expressed relative to that base, so spacing, buttons and headings grow in proportion
                  and the layout reflows rather than breaking. It multiplies whatever text size your
                  browser is already set to, so if you have raised that, this raises it again from
                  there. Your browser&rsquo;s own zoom works normally as well; nothing here prevents
                  pinch-zoom on a phone.
                </dd>
              </div>

              <div className="py-5">
                <dt className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                  <Contrast aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
                  High contrast
                </dt>
                <dd className="prose-measure mt-2 text-sm leading-relaxed text-ink-700">
                  Darkens the faintest parts of the palette — the hairlines between rows, the grey used
                  for captions, dates and other secondary text, and the placeholder text in form fields
                  — and thickens the keyboard focus outline from two pixels to three, with more space
                  around it. It works in both the light and the dark palette.
                </dd>
              </div>
            </dl>

            <p className="prose-measure mt-6 text-base leading-relaxed text-ink-700">
              Every one of the four applies the instant you change it, with no reload and no page jump.
              They are remembered in this browser&rsquo;s own storage: there is no account behind them,
              which means they do not follow you to another device or another browser, and if your
              browser blocks local storage — private browsing, or a managed device — they will hold for
              the visit and be forgotten afterwards. On every later page load your settings are applied
              by a small script that runs before the page is first drawn, so a reader who has chosen the
              dark palette does not get a flash of the light one on the way in.
            </p>
          </div>
        </Reveal>

        {/* ── Motion ────────────────────────────────────────────────────────────────────────── */}
        <Reveal as="section" className="mt-14">
          <SectionHeading
            level={2}
            id="motion"
            title={titleOf("motion")}
            description="Your device's setting is honoured on its own. The switch on this site can only ever add to it."
          />

          <div className="shell-narrow mt-6 px-0">
            <p className="prose-measure text-base leading-relaxed text-ink-700">
              Most operating systems have a &ldquo;reduce motion&rdquo; or &ldquo;minimise
              animation&rdquo; setting. This site reads it. If you have already turned it on you need do
              nothing here: the animation is reduced on arrival, and the smooth-scrolling library is not
              even downloaded, because inertia is precisely the motion being objected to and a gentler
              version of an unwanted effect is still the unwanted effect.
            </p>
            <p className="prose-measure mt-4 text-base leading-relaxed text-ink-700">
              The <strong>Reduced motion</strong> switch in the accessibility panel is the second route
              to the same result, for a reader who wants it here and not everywhere. The two are
              combined by addition and never by subtraction: turning the site&rsquo;s switch on adds
              reduction, and turning it off cannot take away the reduction your device asked for. There
              is no setting on this site that can make the site move more than your own device permits.
            </p>
            <p className="prose-measure mt-4 text-base leading-relaxed text-ink-700">
              Because a signal that exists only as movement is a signal a reader with less motion never
              receives, anything the site would otherwise say by moving is also said statically. A row
              that flashes to show it is the one you just picked also gains a solid outline that stays.
              A switch reports its state three ways at once — the position of its knob, the word
              &ldquo;On&rdquo; or &ldquo;Off&rdquo; beside it, and the state announced to assistive
              technology. A loading placeholder keeps a plain tint when its shimmer is switched off.
            </p>
          </div>
        </Reveal>

        {/* ── Keyboard and screen readers ───────────────────────────────────────────────────── */}
        <Reveal as="section" className="mt-14">
          <SectionHeading
            level={2}
            id="keyboard"
            title={titleOf("keyboard")}
            description="What the site does for a reader who never touches a pointer."
          />

          <div className="shell-narrow mt-6 px-0">
            <ul className="flex flex-col gap-5">
              <li className="flex gap-3">
                <Keyboard aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-purple-700" />
                <div>
                  <h3 className="font-display text-base font-semibold text-ink-900">
                    The skip link is the first thing you reach
                  </h3>
                  <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                    Press Tab once on any page and a <strong>Skip to content</strong> link appears in
                    the top-left corner. It moves your focus — not merely the scroll position — into the
                    main region of the page, past the whole navigation menu. Where a page carries a
                    site-wide announcement, that is the first thing you land on.
                  </p>
                </div>
              </li>

              <li className="flex gap-3">
                <Accessibility aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-purple-700" />
                <div>
                  <h3 className="font-display text-base font-semibold text-ink-900">
                    Controls are real controls
                  </h3>
                  <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                    Everything you can act on is a real button or a real link, so it is reachable by
                    keyboard, operable with Enter or Space, and speakable by voice control. The order
                    you tab through a page is the order the page is written in. Keyboard focus is drawn
                    as a purple outline set slightly away from whatever holds it; inside a form field it
                    is a purple ring around the field instead, which is the same signal in the shape the
                    box needs.
                  </p>
                </div>
              </li>

              <li className="flex gap-3">
                <CornerUpLeft aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-purple-700" />
                <div>
                  <h3 className="font-display text-base font-semibold text-ink-900">
                    Panels and dialogues hand focus back
                  </h3>
                  <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                    A dialogue keeps focus inside itself while it is open, closes on Escape, and returns
                    focus to whatever opened it. One that is about to delete something starts with{" "}
                    <strong>Cancel</strong> already focused and refuses to close on a stray click
                    outside, so no reflex press can destroy a record. The accessibility panel itself
                    behaves the same way, except that it does not claim the rest of the page is inert,
                    because it is not.
                  </p>
                </div>
              </li>

              <li className="flex gap-3">
                <Languages aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-purple-700" />
                <div>
                  <h3 className="font-display text-base font-semibold text-ink-900">
                    Names, languages and new tabs are announced
                  </h3>
                  <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                    An icon-only control — search, the menu, the accessibility panel — carries a written
                    name that a screen reader and a voice-control user both get, even where no text is
                    on screen. A link that opens in a new tab says so as part of its name. The page
                    declares its language as English; where a craft record carries its name in its own
                    language, and an editor has recorded which language that is, that name is marked
                    with it so it is not pronounced with English rules.
                  </p>
                </div>
              </li>

              <li className="flex gap-3">
                <Map aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-purple-700" />
                <div>
                  <h3 className="font-display text-base font-semibold text-ink-900">
                    The map has a written equivalent beside it
                  </h3>
                  <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                    In the craft archive the markers on the map are real buttons rather than shapes
                    painted into a canvas, and each one is numbered to match a row in the list beside
                    it. Everything the map shows — which crafts exist, where they are and in which
                    region — is on the page as text, at the same number, whether or not the map itself
                    can be used.
                  </p>
                </div>
              </li>
            </ul>
          </div>
        </Reveal>

        {/* ── Colour and images ────────────────────────────────────────────────────────────── */}
        <Reveal as="section" className="mt-14">
          <SectionHeading
            level={2}
            id="images"
            title={titleOf("images")}
            description="Nothing is said with colour alone, and every image carries a description or is explicitly marked as decorative."
          />

          <div className="shell-narrow mt-6 px-0">
            <p className="prose-measure text-base leading-relaxed text-ink-700">
              Colour is never the only carrier of meaning on this site. Every status, every warning and
              every &ldquo;this is the one you chose&rdquo; is a word and a symbol as well as a tint, so
              nothing is lost to colour blindness, to a monochrome screen or to a black-and-white print.
              The same rule is what makes the print edition safe to flatten to black ink: doing so
              removes decoration and never information.
            </p>
            <p className="prose-measure mt-4 text-base leading-relaxed text-ink-700">
              Every image published through the Centre&rsquo;s editing system carries a text
              description — the &ldquo;alt text&rdquo; a screen reader reads in place of the picture —
              and the attribute is always written, never left off. Where an editor has described the
              image, that description is what you hear. Where a picture is genuinely decorative, such as
              a texture or the wash behind a headline, it is explicitly marked as decorative so a screen
              reader passes over it rather than interrupting with a filename, which is what an image
              with no attribute at all would produce.
            </p>
            <p className="prose-measure mt-4 text-base leading-relaxed text-ink-700">
              An image whose description has simply not been written yet is treated the same way as a
              decorative one, and passed over silently. That is the least bad of the available
              behaviours and it is still a gap, so it is not left to chance: the editing system runs a
              content-health report that counts every image with no description, names the files and
              takes the editor straight to them. Photography that ships with the site is credited and
              described on the{" "}
              <Link href="/credits" className={ANCHOR_LINK}>
                photography credits
              </Link>{" "}
              page.
            </p>
            <p className="prose-measure mt-4 text-base leading-relaxed text-ink-700">
              One more habit is worth naming because it changes what you can trust on a page: wherever a
              list has been cut short, capped or filtered, the page says so in words and gives the full
              number. A list that quietly stops looks exactly like a place with no records, and the two
              mean very different things when the subject is an archive.
            </p>
          </div>
        </Reveal>

        {/* ── Print ─────────────────────────────────────────────────────────────────────────── */}
        <Reveal as="section" className="mt-14">
          <SectionHeading
            level={2}
            id="print"
            title={titleOf("print")}
            description="Printing or saving to PDF gives a page laid out for paper, not a photograph of a screen."
          />

          <div className="shell-narrow mt-6 px-0">
            <p className="prose-measure text-base leading-relaxed text-ink-700">
              Every page has a print edition. Printing from the dark palette gives dark text on white
              paper rather than white text on nothing, because the paper version fixes its own colours
              regardless of the theme you were reading in — and it comes out the same whether or not you
              tick your printer&rsquo;s &ldquo;background graphics&rdquo; box.
            </p>
            {/* A plain marked list, with no icon per item. Four identical glyphs down the margin would
                be decoration a reader has to look past — the icons elsewhere on this page each stand
                for a DIFFERENT thing, which is the only work an icon does here. */}
            <ul className="prose-measure mt-5 list-disc space-y-2.5 pl-6 text-sm leading-relaxed text-ink-700">
              <li>
                The header, the footer, the navigation, the skip link and the buttons are all removed:
                on paper they are either meaningless or a stamp across the first sheet.
              </li>
              <li>
                Links to other sites print their full web address after the link text, so a printed
                citation is still followable. Links to a point on the same page, and the ones inside
                navigation, deliberately do not — forty addresses nobody asked for is not a service.
              </li>
              <li>
                Sections that would normally fade in as you scroll to them are forced visible, so a
                long page prints whole rather than as one screenful followed by blank sheets. Rows that
                scroll sideways on screen wrap onto as many lines as they need, so nothing is cut off at
                the edge of the paper.
              </li>
              <li>
                Photographs are bounded so that none of them takes a sheet to itself, a heading is never
                left alone at the foot of a page, and a caption is never separated from the picture it
                belongs to.
              </li>
            </ul>
            <p className="prose-measure mt-5 text-base leading-relaxed text-ink-700">
              There is one thing the print edition cannot do, and it is listed under{" "}
              <a href="#limits" className={ANCHOR_LINK}>
                limits we know about
              </a>
              .
            </p>
          </div>
        </Reveal>

        {/* ── No conformance claim ─────────────────────────────────────────────────────────── */}
        <Reveal as="section" className="mt-14">
          <SectionHeading
            level={2}
            id="claims"
            title={titleOf("claims")}
            description="An unaudited conformance level is a statement about work nobody has done."
          />

          <div className="shell-narrow mt-6 px-0">
            <div className="panel p-6 sm:p-8">
              <p className="prose-measure text-base leading-relaxed text-ink-700">
                This site has <strong>not</strong> been audited against the Web Content Accessibility
                Guidelines or any other standard, by the Centre or by anybody else. So no conformance
                level is claimed here — not A, not AA, not partial — and no date is given by which one
                will be. Naming a level the site has not been tested against would be a statement about
                work that has not happened, and it is the kind of statement a reader is entitled to rely
                on.
              </p>
              <p className="prose-measure mt-4 text-base leading-relaxed text-ink-700">
                What is above is a description of what has been built, written to be checked rather than
                believed. Judge it against your own needs; if it falls short of them, the last section
                is how to say so.
              </p>
            </div>
          </div>
        </Reveal>

        {/* ── Known limits ─────────────────────────────────────────────────────────────────── */}
        <Reveal as="section" className="mt-14">
          <SectionHeading
            level={2}
            id="limits"
            title={titleOf("limits")}
            description="The gaps we have found ourselves. They are listed because a reader who hits one deserves to know it is known."
          />

          <div className="shell-narrow mt-6 px-0">
            <ul className="divide-y divide-line-200 border-y border-line-200">
              <li className="py-5">
                <h3 className="font-display text-base font-semibold text-ink-900">
                  A closed section does not print
                </h3>
                <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                  Where a page folds its content into expandable sections, a closed one is not on the
                  page at all — it is removed rather than hidden — so no print rule can recover it. A
                  printed sheet therefore shows the section you had open and no others. Open each
                  section before printing, or print the sections you need one at a time.
                </p>
              </li>
              <li className="py-5">
                <h3 className="font-display text-base font-semibold text-ink-900">
                  The craft map is a visual instrument
                </h3>
                <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                  The interactive map in the craft archive is drawn on a canvas and cannot be read
                  aloud, and geography is genuinely part of what it communicates. Its markers are
                  keyboard-reachable buttons and it has a numbered list beside it carrying the same
                  records, and each craft has a page of its own with its region and location written
                  out — but a reader who cannot use the map does lose the shape of the distribution.
                  Where several crafts sit close together the map groups them behind one marker that
                  says how many it covers, and it is the list, not the map, that gets you to each one
                  individually.
                </p>
              </li>
              <li className="py-5">
                <h3 className="font-display text-base font-semibold text-ink-900">
                  The archive&rsquo;s filters need JavaScript
                </h3>
                <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                  With scripting switched off or blocked, the site is still readable: pages, listings
                  and records are all delivered as complete text. What stops working is changing a
                  view — the archive&rsquo;s filters, the period slider and the accessibility panel
                  itself all need scripting. If you rely on your device&rsquo;s own reduce-motion
                  setting, that is honoured without any scripting at all.
                </p>
              </li>
              <li className="py-5">
                <h3 className="font-display text-base font-semibold text-ink-900">
                  Not every target is the same size
                </h3>
                <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                  The switches in the accessibility panel are deliberately built as full-width rows
                  forty-four pixels tall, because a twenty-pixel switch is the last thing that should be
                  hard to hit on the panel somebody opens <em>because</em> pointing is hard. Elsewhere
                  the sizes are not uniform: some small icon-only buttons, such as the cross that closes
                  a panel, are about thirty-two pixels square, which is smaller than a reader with a
                  tremor needs. Every one of them can also be reached by keyboard, and a panel can
                  always be closed with Escape instead.
                </p>
              </li>
              <li className="py-5">
                <h3 className="font-display text-base font-semibold text-ink-900">
                  Only English is declared
                </h3>
                <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                  Pages declare their language as English. A craft&rsquo;s name in its own language is
                  marked with that language where an editor has recorded which one it is, but individual
                  words and phrases elsewhere in the prose are not, so a screen reader will pronounce
                  them with English rules.
                </p>
              </li>
              <li className="py-5">
                <h3 className="font-display text-base font-semibold text-ink-900">
                  Your settings stay in this browser
                </h3>
                <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                  The four controls are remembered in this browser only. They do not travel to another
                  device, another browser or a private window, and where storage is blocked they last
                  for the visit and no longer. A setting your device or operating system provides — dark
                  mode, reduce motion, a larger default text size — is read on every visit, so those are
                  the ones worth setting if you would rather not set anything twice.
                </p>
              </li>
            </ul>
          </div>
        </Reveal>

        {/* ── Reporting ────────────────────────────────────────────────────────────────────── */}
        <Reveal as="section" className="mt-14">
          <SectionHeading
            level={2}
            id="reporting"
            title={titleOf("reporting")}
            description="A barrier we do not know about is one we cannot fix."
          />

          <div className="shell-narrow mt-6 px-0">
            <div className="panel p-6 sm:p-8">
              <p className="prose-measure text-base leading-relaxed text-ink-700">
                If any part of this site keeps you from something you came for, please tell us. The{" "}
                <Link href="/contact" className={ANCHOR_LINK}>
                  contact page
                </Link>{" "}
                lists the inboxes the Centre reads, and carries an enquiry form where one is switched on
                for this deployment.
              </p>
              <p className="prose-measure mt-4 text-base leading-relaxed text-ink-700">
                Three things make a report far quicker to act on, if you have them: the address of the
                page you were on, what you were using to read it — a screen reader and its version, a
                keyboard alone, a magnifier, voice control — and what you expected to happen instead of
                what did. None of them is required; a sentence saying something is unusable is worth
                much more than nothing.
              </p>
              <p className="prose-measure mt-4 text-base leading-relaxed text-ink-700">
                No response time is published here, because none has been agreed, and this page will not
                promise you one it cannot keep. What we will do is read what you send and correct what we
                can — and when a fix lands, or when a limit above stops being true, this page is updated
                with it.
              </p>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
