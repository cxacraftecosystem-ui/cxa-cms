/**
 * SiteFooter — the immersive close of every public page, and the studio's front door.
 *
 * A SERVER COMPONENT, deliberately. It renders links, addresses and text; nothing in it needs an
 * event handler, a hook or the browser. Marking it `"use client"` would push the whole footer — every
 * link, every column, the address — into the JavaScript bundle of every page for no behaviour at all.
 * The two islands that DO need the client (`SiteBrand`'s seven-click door and `AccessibilityMenu`)
 * carry their own directive and are the only things here that ship as script.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE BAND IS PERMANENTLY DARK, IN BOTH THEMES
 *
 * `bg-purple-950` is from the brand ramp, which is literal oklch and does not invert — that is the
 * point of a closing band, and it is why every colour inside it is written against white rather than
 * against the themed `ink-*` ladder. The one thing that would otherwise get this wrong is the
 * accessibility menu, whose trigger is `text-ink-700`: dark ink on a dark band in the LIGHT theme.
 * It is corrected at the call site below with a scoped override rather than by giving the component a
 * second appearance nobody else needs.
 *
 * The keyboard focus ring gets the same treatment. globals.css draws it in `purple-700`, which is
 * only just visible against `purple-950`, and that rule out-specifies any utility (it is
 * `a:focus-visible`, a pseudo-class), so the override has to be `!`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE WORDMARK IS THE SEVEN-CLICK STUDIO DOOR (contract §0). It renders through `SiteBrand` with
 * `asStudioDoor`; nothing here hints that it does, because a hint would be a visible link to the
 * studio written in words instead of markup.
 */

import Link from "next/link";
import {
  Facebook,
  Github,
  Globe,
  Instagram,
  Linkedin,
  Mail,
  MapPin,
  Phone,
  Rss,
  Twitter,
  Youtube,
  type LucideIcon
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { NavNode } from "@/lib/navigation";
import { KolamMark } from "@/components/craft/KolamMark";
import { Reveal } from "@/components/motion/Reveal";
import {
  SOCIAL_FALLBACK_ICON,
  SOCIAL_PLATFORMS,
  type BrandingSettings,
  type ContactSettings,
  type FooterSettings,
  type SocialLink,
  type SocialSettings
} from "@/lib/settings/schema";
import { AccessibilityMenu } from "@/components/ui/AccessibilityMenu";
import { NewsletterSignup } from "@/components/site/NewsletterSignup";
import { SiteBrand } from "@/components/site/SiteBrand";

export interface SiteFooterProps {
  branding: BrandingSettings;
  contact: ContactSettings;
  social: SocialSettings;
  footer: FooterSettings;
  /** The `footer` location of the navigation tree, from `getNavigation()`. */
  items: NavNode[];
}

/**
 * The lucide exports named by `SOCIAL_PLATFORMS`, resolved here.
 *
 * A map rather than a dynamic lookup on the lucide namespace: `icons[name]` would defeat tree-shaking
 * and pull the entire icon set — some 1,500 components — into the bundle of every public page.
 * `Globe` is the documented fallback for a platform nobody has written an icon for (contract §13:
 * lucide, and only lucide).
 */
const SOCIAL_ICONS: Record<string, LucideIcon> = {
  Linkedin,
  Twitter,
  Youtube,
  Instagram,
  Facebook,
  Github,
  Rss,
  Globe
};

/** Complete literal class strings — a name assembled by concatenation is purged (contract §5). */
const FOOTER_LINK =
  "inline-flex min-h-9 items-center gap-1.5 text-sm text-white/70 transition hover:text-white focus-visible:!outline-logo-cream";

/** Gold-300 — ChartMate's own column-heading rung, and the middle of the ramp the band runs. */
const COLUMN_HEADING = "text-xs font-semibold uppercase tracking-[0.14em] text-gold-300";

/** `/path` and `#anchor` are ours; everything else is another origin, a mailto or a tel. */
function isInternalHref(href: string): boolean {
  return href.startsWith("/") || href.startsWith("#");
}

function isWebExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function platformMeta(platform: string) {
  return SOCIAL_PLATFORMS.find((entry) => entry.value === platform);
}

/**
 * The accessible name for a social link.
 *
 * An icon-only link with no name is unusable — a screen reader announces "link" and stops. The
 * editor's own label wins; failing that the platform's name; failing that the host, because "other"
 * is a picker option ("Something else") and not something to read out loud. `new URL` cannot throw on
 * a value that reached here — `socialLinkSchema` validated it — but the guard costs nothing and a
 * footer is not worth crashing a page over.
 */
function socialLabel(link: SocialLink): string {
  if (link.label) return link.label;

  const meta = platformMeta(link.platform);
  if (meta && meta.value !== "other") return meta.label;

  try {
    return new URL(link.url).hostname.replace(/^www\./i, "");
  } catch {
    return link.platform;
  }
}

function socialIcon(platform: string): LucideIcon {
  const meta = platformMeta(platform);
  return SOCIAL_ICONS[meta?.icon ?? SOCIAL_FALLBACK_ICON] ?? Globe;
}

/** The postal address as the lines a person would actually write on an envelope. */
function addressLines(contact: ContactSettings): string[] {
  const locality = [contact.city, contact.state, contact.postalCode].filter(Boolean).join(" ");
  return [contact.addressLine1, contact.addressLine2, locality, contact.country].filter(
    (line) => line.trim().length > 0
  );
}

export function SiteFooter({ branding, contact, social, footer, items }: SiteFooterProps) {
  const lines = addressLines(contact);
  const year = new Date().getFullYear();
  const legal = footer.legalNote || `© ${year} ${branding.siteName}. All rights reserved.`;

  return (
    /*
      TWO LAYERS, AND THE OUTER ONE IS THE PAGE. The band inside is inset and rounded at the top —
      the ChartMate form this redesign follows — so the page's own themed ground shows through the
      corner notches, which is what makes the curve read as a curve rather than as clipping. The
      outer element carries no text, so the themed token under unconditionally-white type is never
      in play (theme-check's rule).

      ⚠ `z-10` IS ALSO THE FLUID CURSOR'S STACKING CONTRACT, not decoration — see the header of
      `components/site/SplashCursor.tsx`. That canvas is `fixed … z-0` and is the LAST child of the
      site wrapper, so without an index here the footer loses to DOM order and the trail paints over
      the whole band. This element was already `relative`, which is what makes an index take effect;
      `<main>` carries the matching class in app/(site)/layout.tsx.
    */
    <footer className="relative z-10 bg-bg-0">
      {/* `text-white` lives HERE, beside the literal purple-950 it depends on — putting it on the
          themed outer element above is exactly the inverting-scrim defect theme-check exists to
          catch (it did). */}
      <div
        // The splash cursor stands down over the closing band, like the other purple grounds.
        data-splash-off=""
        className="noise relative isolate mx-auto max-w-[96rem] overflow-hidden rounded-t-[2.5rem] bg-purple-950 text-white md:rounded-t-[3rem]"
      >
      {/* The mesh glow. Ornament, so it is out of the accessibility tree and out of the way of the
          pointer; `.grad-mesh` is one of the three sanctioned gradient recipes (contract §4). */}
      <div aria-hidden="true" className="grad-mesh pointer-events-none absolute inset-0 opacity-60" />

      {/*
        THE CROWN — a glowing gold→violet hairline where the footer meets the page, with a soft
        radial bloom beneath it. Adapted from ChartMate's footer (this redesign's acknowledged
        inspiration): the hairline is what makes the band read as a deliberate close rather than a
        place the page ran out. Both layers are ornament — aria-hidden, pointer-transparent — and
        both are literal brand colours on a literal purple-950 ground, so neither can invert out
        from under the white text in either theme.
      */}
      {/* The crown runs the RAMP, not one gold: 200 at the bright centre, 400 at the shoulders,
          600 fading into the violet — the same ladder the headings (300) and the resolve's kolam
          (500) sit on, so the whole band reads as one metal. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 h-px w-2/3 -translate-x-1/2 rounded-full"
        style={{
          background:
            "linear-gradient(90deg, transparent, oklch(0.6 0.13 75 / 0.7) 18%, oklch(0.78 0.135 84 / 0.95) 36%, oklch(0.9 0.08 88 / 1) 50%, oklch(0.78 0.135 84 / 0.95) 62%, oklch(0.6 0.18 300 / 0.8) 80%, transparent)"
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-56"
        style={{
          background:
            "radial-gradient(42% 140px at 50% 0%, oklch(0.7 0.145 80 / 0.16), transparent), radial-gradient(70% 240px at 50% 0%, oklch(0.47 0.198 305 / 0.3), transparent)"
        }}
      />

      {/*
        THE RESOLVE — the identity statement the page closes on, before any column of links. The
        positioning line is the owner's own, from the closing chapter of the Centre's story script
        ("Where heritage meets intelligence."), so the last thing every page says is the same thing
        the story ends on. The kolam beside it is the same mark the story closes with — drawn
        complete here, not animating: a footer is arrived at mid-scroll dozens of times, and a
        threshold drawing that redraws itself on every pass stops being a threshold.
      */}
      <div className="shell relative">
        <Reveal className="flex flex-col items-start gap-8 border-b border-white/10 py-14 sm:py-16 md:flex-row md:items-center md:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-gold-300">
              IIT Kharagpur · Centre of Excellence
            </p>
            <p className="mt-4 font-display text-3xl font-extrabold leading-[1.12] tracking-tight text-white sm:text-4xl md:text-[2.75rem]">
              Where heritage meets{" "}
              <span className="text-gold-gradient">intelligence.</span>
            </p>
          </div>
          {/* `KolamMark`, not `KolamLattice`: the mark is complete and still here, so it ships as
              plain server HTML instead of a client island on every public page (see its header). */}
          <KolamMark className="w-28 shrink-0 text-gold-500/45 sm:w-32" cols={7} rows={5} />
        </Reveal>
      </div>

      <div className="shell relative py-16 sm:py-20">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)]">
          {/* The two halves rise as they arrive — the ChartMate footer's staggered entrance, done
              with the house `Reveal` (translate + opacity only; its reduced-motion collapse is
              built in). The stagger is two delays, not a `staggerChildren`, because the halves are
              server-rendered columns, not siblings inside one client tree. */}
          <Reveal>
            {/* The door. It is an ordinary link to "/" for everyone who is not counting. */}
            <SiteBrand branding={branding} variant="footer" asStudioDoor />

            {/*
              ══════════════════════════════════════════════════════════════════════════════════════
              THE NEWSLETTER SIGN-UP, AND WHY THE FOOTER IS ITS HOME.

              It is here rather than on a page of its own because of what the alternative would mean.
              A newsletter reachable only from `/newsletter` is reachable only by somebody who already
              knows it exists — and the whole failure this feature was rescued from is a facility that
              was completely built and reached by nothing. The footer is rendered by
              `app/(site)/layout.tsx` on EVERY public page, so the one thing that cannot happen now is
              that a reader finishes an article about a craft and has no way to hear about the next one.
              `/newsletter` exists as well, as the address a printed leaflet or an email can quote.

              ⚠ IT IS THE ONLY CLIENT ISLAND IN THIS COLUMN, and it is one deliberately: it holds the
              double opt-in form, which needs a submit handler to stay on the page. `SiteFooter` itself
              stays a Server Component (see the header) — importing this one component does not change
              that, it only adds this subtree to the page's client graph.

              ⚠ `source="footer"` IS FROM THE CLOSED LIST in lib/newsletter/address.ts, never a literal
              typed here. `source` is a filter on the studio's subscribers screen, and a second spelling
              would create a second option in that filter that looks identical to the first and matches
              none of the same rows.

              ⚠ THE COMPONENT PAINTS ITS OWN THEMED CARD, and that is why nothing here overrides a colour
              inside it. This band is `bg-purple-950` in both themes while the `ink-*` ladder inverts, so
              a form control written straight onto it would be dark-on-dark in the LIGHT theme — the same
              trap the accessibility menu below fell into. The card is an ordinary themed surface floating
              above the band, so every label and input inside is correct in both themes by construction.
              Its header sets this out at length.
            */}
            <NewsletterSignup
              source="footer"
              className="mt-8"
              // `h2`: the page's own `h1` is the only level above anything in this footer, so an `h2` can
              // never skip — the same reasoning as the column headings (contract §11).
              headingLevel={2}
              blurb="A few times a year: what the Centre has recorded, published and restored. No more than that, and nothing else."
            />

            {social.links.length > 0 ? (
              <ul className="mt-8 flex flex-wrap items-center gap-2">
                {social.links.map((link, index) => {
                  const Icon = socialIcon(link.platform);
                  const name = socialLabel(link);

                  return (
                    // Keyed by position as well as value: these lists are editor-ordered arrays with
                    // no ids, and two rows pointing at the same URL would otherwise share a key.
                    <li key={`${index}-${link.url}`}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/80 transition hover:border-gold-400/50 hover:bg-gold-500/10 hover:text-gold-200 focus-visible:!outline-logo-cream"
                      >
                        <Icon aria-hidden="true" className="h-4 w-4" />
                        {/* The icon is decorative; this is the link's whole accessible name. */}
                        <span className="sr-only">{name} (opens in a new tab)</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </Reveal>

          <Reveal delay={0.12} className="grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
            {items.length > 0 ? (
              <nav aria-label="Footer">
                {/*
                  h2 throughout the footer. The page's own h1 is the only level above it, so an h2 can
                  never skip; an h3 would, on any page whose last section heading was an h2
                  (contract §11). The heading is fixed text because the navigation table stores a
                  location, not a column title.
                */}
                <h2 className={COLUMN_HEADING}>Explore</h2>
                <ul className="mt-4 flex flex-col gap-1">
                  {items.map((item) => (
                    <li key={item.id}>
                      <FooterNavLink node={item} />

                      {item.children.length > 0 ? (
                        // Two levels are possible in the navigation tree, so both are rendered.
                        // Dropping the second would lose destinations with nothing on screen to say
                        // that it had (contract §1.6).
                        <ul className="mb-1 ml-3 flex flex-col gap-1 border-l border-white/10 pl-3">
                          {item.children.map((child) => (
                            <li key={child.id}>
                              <FooterNavLink node={child} />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}

            {footer.columns.map((column, columnIndex) => (
              <div key={`${columnIndex}-${column.heading}`}>
                <h2 className={COLUMN_HEADING}>{column.heading}</h2>
                <ul className="mt-4 flex flex-col gap-1">
                  {column.links.map((link, linkIndex) => (
                    <li key={`${linkIndex}-${link.href}`}>
                      {isInternalHref(link.href) ? (
                        <Link href={link.href} className={FOOTER_LINK}>
                          {link.label}
                        </Link>
                      ) : (
                        <a
                          href={link.href}
                          // Only a web address leaves for another tab. A `mailto:` or `tel:` hands
                          // over to another application and would leave an empty tab behind.
                          {...(isWebExternal(link.href)
                            ? { target: "_blank", rel: "noopener noreferrer" }
                            : {})}
                          className={FOOTER_LINK}
                        >
                          {link.label}
                          {isWebExternal(link.href) ? (
                            <span className="sr-only"> (opens in a new tab)</span>
                          ) : null}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {lines.length > 0 || contact.email || contact.phone ? (
              <div>
                <h2 className={COLUMN_HEADING}>Contact</h2>

                {lines.length > 0 ? (
                  <address className="mt-4 flex items-start gap-2 text-sm not-italic leading-relaxed text-white/70">
                    <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-white/40" />
                    <span>
                      {lines.map((line) => (
                        <span key={line} className="block">
                          {line}
                        </span>
                      ))}
                    </span>
                  </address>
                ) : null}

                <ul className="mt-3 flex flex-col gap-1">
                  {contact.email ? (
                    <li>
                      <a href={`mailto:${contact.email}`} className={FOOTER_LINK}>
                        <Mail aria-hidden="true" className="h-4 w-4 shrink-0 text-white/40" />
                        {contact.email}
                      </a>
                    </li>
                  ) : null}
                  {contact.phone ? (
                    <li>
                      {/* Spaces are for reading, not for dialling: a `tel:` with them in is refused
                          outright by some handsets. */}
                      <a href={`tel:${contact.phone.replace(/\s+/g, "")}`} className={FOOTER_LINK}>
                        <Phone aria-hidden="true" className="h-4 w-4 shrink-0 text-white/40" />
                        {contact.phone}
                      </a>
                    </li>
                  ) : null}
                </ul>

                {/* Departmental addresses live on the contact page, where each one can carry the
                    sentence that stops the wrong mail arriving. This column is the Centre's own
                    address and nothing more, so nothing is being truncated here. */}
              </div>
            ) : null}
          </Reveal>
        </div>

        {/*
          THE REFERENCE ROW — three pages that must be reachable whatever an editor has done to the
          navigation, and that is the whole reason it is hard-coded here rather than seeded into
          `DEFAULT_FOOTER`.
          
          The footer's columns above are editor-controlled: an administrator can rename, reorder or
          delete any of them, which is right for "About" and "Research" and wrong for these:
          
            • `/credits` carries the photographer, licence and source for every bundled photograph.
              The Creative Commons BY licences on that imagery REQUIRE that attribution to be
              carried, so a route to it cannot be something somebody can remove by tidying a menu.
            • `/accessibility` is the statement. A reader who needs it is the reader least well served
              by having to hunt for it.
            • `/a-z` is the index of everything, and is what somebody who knows a name but not where
              it lives actually wants.
          
          They are small and last on purpose: this is reference matter, not navigation, and it should
          not compete with the columns above it.
        */}
        <nav aria-label="Reference" className="mt-12 border-t border-white/10 pt-6">
          <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {REFERENCE_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={FOOTER_LINK}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-8 flex flex-col gap-4 border-t border-white/10 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm leading-relaxed text-white/50">
            <p>{legal}</p>
            {footer.showCredit ? (
              // Deliberately non-specific: the setting is a switch, not a text field, so this line
              // cannot name anybody without inventing an attribution the Centre never wrote.
              <p className="mt-1">Built and maintained in-house.</p>
            ) : null}
          </div>

          {/*
            The menu opens UPWARDS — it is the last thing on the page and a downward panel would open
            off the bottom of the document. The scoped overrides re-colour only the trigger, which is
            the one part that sits on the permanently dark band; the panel itself is a `bg-card`
            surface floating above the page and reads correctly in both themes as it is. `!` is
            needed because `cn()` is a plain join and one utility cannot beat another without it
            (contract §5).
          */}
          <AccessibilityMenu
            side="top"
            align="end"
            showLabel
            className={cn(
              "shrink-0",
              "[&>button]:!text-white [&>button:hover]:!bg-white/10 [&>button:hover]:!text-white"
            )}
          />
        </div>
      </div>
      </div>
    </footer>
  );
}

/**
 * The reference row's destinations. See the comment at the call site for why these are here and not
 * in the editor-controlled navigation.
 *
 * All three are internal, so `Link` is unconditional and there is no external-link handling to do.
 */
const REFERENCE_LINKS: readonly { href: string; label: string }[] = [
  { href: "/a-z", label: "A–Z index" },
  { href: "/accessibility", label: "Accessibility" },
  { href: "/credits", label: "Photography credits" }
];

/** One navigation destination in the footer. Mirrors the header's external-link handling. */
function FooterNavLink({ node }: { node: NavNode }) {
  if (node.isExternal) {
    return (
      <a
        href={node.href}
        target="_blank"
        rel="noopener noreferrer"
        className={FOOTER_LINK}
      >
        {node.label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }

  return (
    <Link href={node.href} className={FOOTER_LINK}>
      {node.label}
    </Link>
  );
}
