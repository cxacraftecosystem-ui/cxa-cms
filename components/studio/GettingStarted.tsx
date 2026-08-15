import Link from "next/link";
import { Circle, CircleCheck, Rocket, X, type LucideIcon } from "lucide-react";

import type { SessionUser } from "@/lib/auth/current-user";
import { livePublishableWhere, liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import {
  canManageSettings,
  canManageStructure,
  canManageStudioAccess,
  canManageUsers,
  type PermissionSubject
} from "@/lib/permissions";
import { SETTINGS_DEFAULTS } from "@/lib/settings/schema";
import { getSettingsCached } from "@/lib/settings/service";
import { Button } from "@/components/ui/Button";

/**
 * GETTING STARTED — the checklist a brand-new installation needs, and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ EVERY ITEM KNOWS IT IS DONE BY LOOKING AT THE DATA, NEVER BY REMEMBERING A CLICK.
 *
 * A checklist that ticks itself when somebody visits a screen is a checklist that lies: it goes green
 * while the About page is still empty, and the person who trusted it finds out from a visitor. So each
 * item below is a QUERY — is there a logo chosen, does the About page have any blocks on it, is there a
 * second administrator — and an item can go back to unticked if the thing it checked is undone. That is
 * the whole design, and it is why this component reads the database rather than taking props.
 *
 * A SERVER COMPONENT, AND THE DISMISSAL IS A PRE-PAINT SCRIPT rather than React state. A client component
 * cannot know whether this reader has dismissed the panel until AFTER it mounts, because `localStorage`
 * does not exist during the server render — so every return visit would paint the checklist, hydrate, and
 * remove it, which is a flash and a full-page jump at the top of the dashboard. `app/layout.tsx` solves
 * the identical problem for the theme in the identical way, and so does
 * components/site/AnnouncementBar.tsx, whose script this one is modelled on. It does three things:
 *
 *   1. reads the dismissal key from `localStorage` and hides the panel when it matches THIS reader;
 *   2. wires the hide button;
 *   3. survives `localStorage` being unavailable — every access is inside its own `try`/`catch`.
 *
 * The third point is not defensive habit. `window.localStorage` THROWS on access in Safari's private mode
 * and wherever site data is blocked, and an exception here would take the whole dashboard down with it.
 *
 * ⚠ THE KEY IS PER USER, and the reason is that two people share one installation but not one to-do list:
 * the founding administrator who has finished setting up should not be able to hide the list from the
 * colleague who joined last week. The user's identifier is passed as a `data-` attribute and never
 * interpolated into the script, which is a fixed string constant with no data in it at all.
 *
 * ⚠ THE PANEL DOES NOT RENDER AT ALL ONCE EVERY APPLICABLE ITEM IS DONE, so nothing has to be dismissed
 * to be rid of it. Dismissal is for the installation that has deliberately decided not to do one of them.
 *
 * EVERY ITEM IS GATED BY THE PREDICATE OF THE SCREEN IT LINKS TO, and the two that need more than an
 * administrator — the access list, the second administrator — simply disappear for a reader who cannot
 * reach them, rather than becoming a link that lands on a refusal (contract §1.8). "Done" is then measured
 * against what is left, so the list can be completed by whoever is looking at it.
 *
 * WITH JAVASCRIPT UNAVAILABLE the panel stays and the hide button does nothing, which is the same
 * deliberate trade the announcement band makes: a checklist that cannot be hidden is a checklist, and a
 * flashing one is a fault.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MOUNTED BY `app/studio/page.tsx`, immediately after the dashboard's `<header>` and above "Needs your
 * attention". That file already holds the authoritative `user` from `requireUser()`, and nothing else is
 * needed: the component asks its own questions, renders nothing for a reader it does not apply to, and
 * renders nothing once every applicable item is done.
 *
 * ⚠ It was written before it was mounted, and then went a whole release unmounted — so first-run
 * onboarding existed in the repository and never once appeared on a screen. Nothing surfaced that: it
 * typechecks, it lints, and a component nobody renders has no failing test. If this is ever taken off
 * the dashboard, delete it rather than leaving it here to look finished.
 *
 * ⚠ It imports `lib/db.ts`, so it can only be mounted from a Server Component. A `"use client"` parent
 * importing it fails the build, which is the correct outcome rather than a bundled Prisma client.
 */

/** The element ids the script below reaches for. Fixed, because the panel is mounted once. */
const PANEL_ID = "cxa-getting-started";
const DISMISS_ID = "cxa-getting-started-dismiss";

/**
 * The pre-paint script. A CONSTANT with no interpolation — see the header.
 *
 * `data-wired` guards against running twice, which happens on a client navigation that remounts the
 * panel: a second listener would be harmless, but a second pass is work nobody asked for.
 */
const DISMISS_SCRIPT = `(function () {
  try {
    var panel = document.getElementById("${PANEL_ID}");
    if (!panel || panel.getAttribute("data-wired") === "true") return;
    panel.setAttribute("data-wired", "true");

    var key = panel.getAttribute("data-checklist") || "";
    if (key.length === 0) return;

    var store = null;
    try { store = window.localStorage; } catch (blocked) { store = null; }

    if (store) {
      var seen = null;
      try { seen = store.getItem(key); } catch (blocked) { seen = null; }
      if (seen === "hidden") { panel.hidden = true; return; }
    }

    var button = document.getElementById("${DISMISS_ID}");
    if (!button) return;
    button.addEventListener("click", function () {
      panel.hidden = true;
      try { if (store) store.setItem(key, "hidden"); } catch (blocked) {}
    });
  } catch (unexpected) {}
})();`;

/**
 * The storage key.
 *
 * Namespaced, because this is the same origin as the public site and an unprefixed "checklist" would be a
 * name any future script could collide with. Per user — see the header.
 */
function storageKeyFor(userId: string): string {
  return `cxa.studio.getting-started.${userId}`;
}

interface ChecklistItem {
  key: string;
  /** The task, as an instruction. "Add your logo and the Centre's name". */
  label: string;
  /** ONE sentence: what it changes on the site, so the item is a reason rather than an order. */
  why: string;
  href: string;
  done: boolean;
  /** The predicate of the screen this links to. A reader who fails it does not see the item at all. */
  can: (subject: PermissionSubject | null | undefined) => boolean;
}

export interface GettingStartedProps {
  /** The authoritative user, already read from the database by the dashboard. */
  user: SessionUser;
}

export async function GettingStarted({ user }: GettingStartedProps) {
  /**
   * The whole panel is for whoever is setting the installation up, which is an administrator: five of the
   * seven items lead to Settings, the access list or the users screen. A failing check renders NOTHING
   * rather than a checklist of links that would be refused (contract §1.8).
   */
  if (!canManageSettings(user)) return null;

  const now = new Date();

  const [
    aboutPage,
    peopleCount,
    livePages,
    livePosts,
    livePeople,
    accessGrants,
    administrators
  ] = await prisma.$transaction([
    /**
     * The About page, by its address.
     *
     * `sections: { take: 1 }` rather than a count: the question is "has anybody written anything on it",
     * and one row answers it. A page that exists with no blocks is exactly the state this item exists to
     * catch — it is what `/studio/pages/new` leaves behind.
     */
    prisma.page.findFirst({
      where: { slug: "about", deletedAt: null },
      select: { id: true, sections: { take: 1, select: { id: true } } }
    }),
    prisma.person.count({ where: { deletedAt: null } }),

    // "Publish something" is answered by the same read-time filters the public site uses, so the tick
    // means "a visitor can see it" rather than "a status column says so" (lib/content.ts).
    prisma.page.count({ where: livePublishableWhere(now) }),
    prisma.post.count({ where: livePublishableWhere(now) }),
    prisma.person.count({ where: liveStatusWhere() }),

    // A revoked grant is kept so the record of who was once allowed in survives, so "can sign in" is the
    // rows without a revocation. More than one means somebody besides the founder has been invited.
    prisma.studioAccess.count({ where: { revokedAt: null } }),
    prisma.user.count({
      where: {
        deletedAt: null,
        isActive: true,
        role: { in: ["ADMINISTRATOR", "MASTER_ADMIN"] }
      }
    })
  ]);

  const settings = await getSettingsCached();
  const branding = settings.branding;
  const contact = settings.contact;

  /**
   * "The logo and the name are done" needs both halves, and the NAME is compared against the built-in
   * default rather than against emptiness — the schema gives it a default of "Centre of Excellence", so an
   * installation nobody has touched has a name that looks filled in. An institution genuinely called that
   * can dismiss the list; the alternative, ticking the item for every fresh install, would make the
   * checklist wrong on the one day it matters most.
   */
  const brandingDone =
    branding.logoMediaId !== null &&
    branding.siteName.trim().length > 0 &&
    branding.siteName.trim() !== SETTINGS_DEFAULTS.branding.siteName;

  /**
   * Contact details are done when there is a way to reach the Centre AND somewhere to find it. Either an
   * email address or a telephone number satisfies the first — plenty of institutions publish one and not
   * the other, and demanding both would leave an item permanently unticked for a deliberate choice.
   */
  const contactDone =
    (contact.email.trim().length > 0 || contact.phone.trim().length > 0) &&
    (contact.addressLine1.trim().length > 0 || contact.city.trim().length > 0);

  const items: ChecklistItem[] = [
    {
      key: "branding",
      label: "Add your logo and the Centre's name",
      why: "They appear in the site header, in the browser tab and on every card shown when somebody shares a page.",
      href: "/studio/settings",
      done: brandingDone,
      can: canManageSettings
    },
    {
      key: "about",
      label: "Write the About page",
      why: "It is the page visitors open first after the homepage, and the one the site's own menu links to.",
      href: aboutPage ? `/studio/pages/${aboutPage.id}` : "/studio/pages/new",
      done: aboutPage !== null && aboutPage.sections.length > 0,
      can: canManageStructure
    },
    {
      key: "people",
      label: "Add the first person",
      why: "An institutional site is read as a group of people; the people pages are the part visitors spend longest on.",
      href: "/studio/people",
      done: peopleCount > 0,
      can: canManageStructure
    },
    {
      key: "publish",
      label: "Publish something",
      why: "Nothing is on the public site until it is published, and a draft looks finished from inside the studio.",
      href: "/studio/pages",
      done: livePages + livePosts + livePeople > 0,
      can: canManageStructure
    },
    {
      key: "contact",
      label: "Set the contact details",
      why: "The address and the email are shown on the contact page and beside every contact form, and nothing else supplies them.",
      href: "/studio/settings",
      done: contactDone,
      can: canManageSettings
    },
    {
      key: "invite",
      label: "Invite a colleague",
      why: "Nobody can sign in unless their address is on the studio access list — not with a password they were given, and not with a Google account at the right domain.",
      href: "/studio/access",
      done: accessGrants > 1,
      // Master administrator only, deliberately: an administrator runs the site, and deciding who may be
      // here at all is a different job (lib/permissions.ts).
      can: canManageStudioAccess
    },
    {
      key: "second-admin",
      label: "Add a second administrator",
      why: "One administrator is one forgotten password away from nobody being able to change the site at all.",
      href: "/studio/users",
      done: administrators > 1,
      can: canManageUsers
    }
  ];

  const applicable = items.filter((item) => item.can(user));
  const done = applicable.filter((item) => item.done).length;

  // Nothing left to say. See the header: the panel does not have to be dismissed to go away.
  if (applicable.length === 0 || done === applicable.length) return null;

  const storageKey = storageKeyFor(user.id);

  return (
    <>
      {/*
        `suppressHydrationWarning` because the script below may have set `hidden` on this element before
        React reaches it. React never rendered that attribute, so there is nothing for it to patch back —
        the flag only silences the development warning about an attribute that appeared from outside.
      */}
      <section
        id={PANEL_ID}
        data-checklist={storageKey}
        aria-labelledby={`${PANEL_ID}-heading`}
        suppressHydrationWarning
        className="panel px-5 py-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <h2
              id={`${PANEL_ID}-heading`}
              className="flex items-center gap-2 font-display text-base font-semibold text-ink-900"
            >
              <Rocket aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
              Setting up the site
            </h2>
            <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-500">
              {/* The figure is in words beside the list rather than only as a bar: a bar is a picture of
                  progress and tells a screen-reader user nothing (contract §1.4). */}
              {done} of {applicable.length} done. Each of these is checked by looking at the site itself, so
              a tick means the work is there and not that somebody opened the screen.
            </p>
          </div>

          {/*
            A real `<button type="button">` with no handler of its own: the pre-paint script below wires it
            by id. `Button` is not a client component, so a Server Component can render it — and going
            through it keeps this control the same shape and size as every other dense studio action.
          */}
          <Button id={DISMISS_ID} variant="ghost" size="sm" icon={X} className="shrink-0">
            Hide this
          </Button>
        </div>

        <ol className="mt-4 space-y-2.5">
          {applicable.map((item) => {
            const Icon: LucideIcon = item.done ? CircleCheck : Circle;
            return (
              <li key={item.key} className="flex items-start gap-3">
                <Icon
                  aria-hidden="true"
                  className={
                    item.done
                      ? "mt-0.5 h-4 w-4 shrink-0 text-success-600"
                      : "mt-0.5 h-4 w-4 shrink-0 text-ink-300"
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      href={item.href}
                      className={
                        item.done
                          ? "text-sm font-medium text-ink-500 underline decoration-line-200 underline-offset-2 transition hover:text-purple-700"
                          : "text-sm font-medium text-purple-700 transition hover:text-purple-800"
                      }
                    >
                      {item.label}
                    </Link>
                    {/*
                      THE WORD, always, beside the glyph. Colour never carries meaning alone, and a tick a
                      reader cannot see is a state they are never told (contract §11).
                    */}
                    <span
                      className={
                        item.done
                          ? "text-xs font-medium text-success-600"
                          : "text-xs font-medium text-ink-500"
                      }
                    >
                      {item.done ? "Done" : "Still to do"}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{item.why}</span>
                </span>
              </li>
            );
          })}
        </ol>

        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          This list disappears on its own once everything on it is done. Hiding it puts it away on this
          computer only, for your account — it does not mark anything as finished, and it will come back if
          the browser&rsquo;s stored data is cleared.
        </p>
      </section>

      {/*
        AFTER the panel, so the element it reaches for has already been parsed, and inline rather than a
        Next `<Script>`: every strategy that component offers runs later than the first paint, which is the
        one thing this must not do.
      */}
      <script dangerouslySetInnerHTML={{ __html: DISMISS_SCRIPT }} />
    </>
  );
}
