/**
 * THE STUDIO NAVIGATION REGISTRY — one list, read by everything that offers a destination.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ADDING A DESTINATION IS APPENDING ONE OBJECT TO `STUDIO_NAV`. Nothing else. There is no JSX in
 * the sidebar to edit, no second array in a command palette to keep in step, and no `if (role ===
 * "ADMINISTRATOR")` written out by hand anywhere.
 *
 * WHY IT IS A FILE OF ITS OWN, AND WHY `visibleStudioNav()` IS THE ONLY WAY IN.
 *
 *   1. **A hidden entry must not reappear somewhere else.** The sidebar and the jump-to panel are two
 *      components rendered from two places; if each filtered the list itself, one of them would
 *      eventually filter it differently and a screen an author cannot open would still be offered to
 *      them by name. They call the same function and get the same tree.
 *   2. **The predicates come from lib/permissions.ts, never a hand-rolled role comparison.** A second
 *      rank test that disagrees with the first is how a rule silently stops matching (contract §1.7).
 *      `can` below is a REFERENCE to the predicate, so the sidebar and the route handler behind the
 *      screen are literally calling the same function.
 *   3. **This is not the guard.** Hiding a link is a courtesy; the page it points at still calls
 *      `requireUser()` / `requireCapability()` as its first statement. A client guard that only hides
 *      a control is not a guard (contract §1.7).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `description` is a plain sentence for a non-technical administrator, and it is not decoration: it is
 * the `title` a collapsed sidebar shows on hover and the second line in the jump-to panel. Written so
 * that somebody who has never used this CMS can tell "Pages" from "Navigation" without opening either.
 */

import {
  ArrowRightLeft,
  BookMarked,
  CalendarDays,
  ChartLine,
  // NOT `UserRound` — "People" already uses that, and two identical glyphs in one sidebar is a
  // sidebar where the icon has stopped carrying information.
  CircleUserRound,
  FileStack,
  Fingerprint,
  FlaskConical,
  Images,
  Inbox,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutTemplate,
  Layers,
  // NOT `Mail` — the single envelope is the generic "a message arrived" glyph, and `Inbox` is already
  // spoken for by "Enquiries", the other entry in the "Records" group that lists what members of the
  // public sent through a form. Two readings of one idea inside one group is a sidebar where the icon
  // has stopped carrying information — the same argument as the `UserRound` note above. The stack says
  // "a list of addresses", which is what the screen behind it actually is.
  //
  // ⚠ THE ARGUMENT ABOVE NAMES NO COUNT OR POSITION, DELIBERATELY. It used to: it said `Inbox` was "two
  // entries above it in this same group", and that was wrong in both readings — in the "Records" group
  // `Inbox` is ONE entry above `/studio/subscribers`, and in this import block four names sit between
  // them. The collision is what the argument rests on, and it does not depend on how far apart the two
  // sit today, so the argument cannot go stale as entries are inserted. Leave the count out.
  Mails,
  Microscope,
  Newspaper,
  Paperclip,
  ScrollText,
  Settings,
  ShieldCheck,
  Signpost,
  Stethoscope,
  Trash2,
  UserRound,
  Users,
  type LucideIcon
} from "lucide-react";

import {
  canAccessStudio,
  canAuthor,
  canManageContent,
  canManageInquiries,
  canManageMedia,
  canManageResearch,
  canManageSettings,
  canManageStructure,
  canManageStudioAccess,
  canManageUsers,
  canRestoreDeleted,
  canViewAnalytics,
  canViewAuditLog,
  canViewProvenance,
  type PermissionSubject
} from "@/lib/permissions";

/**
 * The eight groups, IN ORDER. The order is an editorial claim about how an administrator thinks: what
 * the site says, what the Centre researches, who is here, what is stored, how the site is shaped, the
 * records nobody edits, the two screens that are about the studio itself rather than about the
 * website — and, last of all, the one screen that is about the READER rather than about either.
 *
 * OVERSIGHT IS A SEPARATE GROUP RATHER THAN TWO MORE ENTRIES UNDER "People" OR "Records", and the
 * separation is the point. "Users" decides what somebody may change; "Studio access" decides whether
 * they may be here at all, and "Provenance" is a record of colleagues' activity rather than of content.
 * Both are master-administrator only (lib/permissions.ts explains why that is deliberately not the same
 * tier as administrator), so for everybody else the heading and its links simply do not exist — a group
 * with nothing left in it is dropped by `visibleStudioNav()`.
 */
export type StudioNavGroup =
  | "Content"
  | "Research"
  | "People"
  | "Library"
  | "Site"
  | "Records"
  | "Oversight"
  | "You";

export const STUDIO_NAV_GROUPS: readonly StudioNavGroup[] = [
  "Content",
  "Research",
  "People",
  "Library",
  "Site",
  "Records",
  "Oversight",
  "You"
];

export interface StudioNavEntry {
  /** An absolute studio path. Also the key the active-entry resolver matches against. */
  href: string;
  /** Two or three words. It is the link text, and the first of the jump-to panel's search targets. */
  label: string;
  /**
   * One plain sentence. Shown on hover in a collapsed sidebar and under the label in the palette.
   *
   * ⚠ IT IS ALSO SEARCHED. `StudioTopBar` matches a typed query against `label`, `description` AND the
   * group name together, so a word an administrator is likely to reach for — "newsletter", "email",
   * "photo" — finds the screen from here even when the label does not contain it. Which means a
   * description that describes the wrong screen does not merely mislead on hover; it returns the wrong
   * screen from a search. (The label alone was documented as the search target here, and that has not
   * been true since the panel started reading all three.)
   */
  description: string;
  icon: LucideIcon;
  /**
   * A predicate from lib/permissions.ts — a reference, never a copy of its logic. It is the same
   * function the route handler behind this screen calls.
   */
  can: (subject: PermissionSubject | null | undefined) => boolean;
  group: StudioNavGroup;
}

/**
 * The dashboard.
 *
 * Deliberately NOT a member of `STUDIO_NAV`: it belongs to no group, it sits above all of them, and
 * putting it in one would make every group heading a lie. `Omit<…, "group">` is the honest type — the
 * shape is otherwise identical, so the sidebar and the palette render it with the same code.
 */
export const STUDIO_HOME: Omit<StudioNavEntry, "group"> = {
  href: "/studio",
  label: "Dashboard",
  description: "What is waiting for you, and what has changed on the site recently.",
  icon: LayoutDashboard,
  can: canAccessStudio
};

export const STUDIO_NAV: readonly StudioNavEntry[] = [
  // ── Content ───────────────────────────────────────────────────────────────
  {
    href: "/studio/pages",
    label: "Pages",
    description:
      "The pages of the website and the blocks each one is built from — the homepage, About, and anything you add.",
    icon: FileStack,
    can: canManageStructure,
    group: "Content"
  },
  {
    href: "/studio/templates",
    label: "Page templates",
    description:
      "Ready-made arrangements of blocks. Choosing one makes a new page with those blocks already in place, and they can be edited here.",
    icon: LayoutTemplate,
    // The same predicate as Pages, and necessarily so: using a template creates a page, and editing one
    // changes what every colleague's next page starts as.
    can: canManageStructure,
    group: "Content"
  },
  {
    href: "/studio/news",
    label: "News",
    description: "Announcements and articles for the newsroom, with their categories and tags.",
    icon: Newspaper,
    // The floor for any write at all: an author drafts their own news and cannot publish it.
    can: canAuthor,
    group: "Content"
  },
  {
    href: "/studio/events",
    label: "Events",
    description: "Seminars, workshops and conferences, their programmes and who has registered.",
    icon: CalendarDays,
    can: canManageContent,
    group: "Content"
  },
  {
    href: "/studio/gallery",
    label: "Gallery",
    description: "Photo albums and virtual tours, grouped by occasion.",
    icon: Images,
    can: canManageContent,
    group: "Content"
  },

  // ── Research ──────────────────────────────────────────────────────────────
  {
    href: "/studio/research",
    label: "Research areas",
    description: "The themes the Centre works on. Projects and publications are filed under these.",
    icon: Microscope,
    can: canManageResearch,
    group: "Research"
  },
  {
    href: "/studio/projects",
    label: "Projects",
    description: "Funded work, who is on it, how far along it is and what it has produced.",
    icon: FlaskConical,
    can: canManageResearch,
    group: "Research"
  },
  {
    href: "/studio/publications",
    label: "Publications",
    description: "Papers, books, patents and datasets, with their citations and downloadable files.",
    icon: BookMarked,
    can: canManageResearch,
    group: "Research"
  },
  {
    href: "/studio/crafts",
    label: "Craft archive",
    description:
      "The living record of crafts — their regions, materials, techniques and photographs.",
    icon: Layers,
    can: canManageResearch,
    group: "Research"
  },

  // ── People ────────────────────────────────────────────────────────────────
  {
    href: "/studio/people",
    label: "People",
    description:
      "Everybody shown on the public site: faculty, scientists, students, staff and alumni.",
    icon: UserRound,
    can: canManageContent,
    group: "People"
  },
  {
    href: "/studio/users",
    label: "Users",
    description: "Who can sign in to this studio, and what each of them is allowed to change.",
    icon: Users,
    can: canManageUsers,
    group: "People"
  },

  // ── Library ───────────────────────────────────────────────────────────────
  {
    href: "/studio/media",
    label: "Media",
    description: "Every photograph, video and audio recording, with its caption and credit.",
    icon: ImageIcon,
    can: canManageMedia,
    group: "Library"
  },
  {
    href: "/studio/files",
    label: "Files",
    description:
      "Documents, datasets and slide decks people download, each keeping its earlier versions.",
    icon: Paperclip,
    can: canManageMedia,
    group: "Library"
  },

  // ── Site ──────────────────────────────────────────────────────────────────
  {
    href: "/studio/navigation",
    label: "Navigation",
    description: "The menus in the site header, the footer columns and the small top bar.",
    icon: Signpost,
    can: canManageStructure,
    group: "Site"
  },
  {
    href: "/studio/settings",
    label: "Settings",
    description:
      "The Centre's name and logo, contact details, social accounts and the homepage arrangement.",
    icon: Settings,
    can: canManageSettings,
    group: "Site"
  },
  {
    href: "/studio/redirects",
    label: "Redirects",
    description:
      "Send an old web address to a new one, so a link printed in a paper keeps working after a page moves.",
    icon: ArrowRightLeft,
    can: canManageStructure,
    group: "Site"
  },

  // ── Records ───────────────────────────────────────────────────────────────
  {
    href: "/studio/health",
    label: "Content health",
    description:
      "Everything wrong with the site that software can spot: pictures with no description, empty pages, links pointing nowhere — and the button that takes a copy of everything.",
    icon: Stethoscope,
    can: canAccessStudio,
    group: "Records"
  },
  {
    href: "/studio/inquiries",
    label: "Enquiries",
    description: "Messages sent through the contact forms on the website, and who is handling each.",
    icon: Inbox,
    can: canManageInquiries,
    group: "Records"
  },
  /*
   * ⚠ UNTIL THIS ENTRY EXISTED, `/studio/subscribers` WAS REACHABLE BY TYPING THE ADDRESS AND BY NOTHING
   * ELSE — the same defect the "Your account" note below records, and the same one this repository has
   * produced eight times. The newsletter is complete: three public endpoints, a double opt-in token flow,
   * a sign-up form in the footer of every public page, this screen with its per-status counts and its
   * unsent-outbox panel, and a CSV export with a formula-injection guard. All of it shipped in the build
   * while no link, no nav entry and no string anywhere outside its own files pointed at the screen that
   * administers it, so the only person who could reach it was somebody who had read the source. It was
   * reported three times before it could be landed, because this file was in no agent's file set.
   *
   * FILED UNDER "Records", DIRECTLY AFTER "Enquiries", because it is the same kind of thing: a list of
   * what members of the public submitted through a form, which nobody edits as content. That is also why
   * the predicate is the same one — see below.
   */
  {
    href: "/studio/subscribers",
    // The screen's own `StudioPageHeader` title, verbatim. Every label in this file is exactly what the
    // screen it opens calls itself ("Enquiries", "Recycle bin", "Audit log", "Studio access"), and a
    // second name for one screen is a second screen as far as the person hunting for it is concerned.
    label: "Newsletter subscribers",
    // Quotes the screen's own opening clause rather than paraphrasing it. "Everybody who has ASKED for
    // the newsletter" would have been the shorter sentence and a wrong one: the list also holds the
    // addresses that never confirmed and the ones that have asked to stop, and those have not asked for
    // anything. `consentText` is a column on the screen, so "what they agreed to" is a real promise.
    description:
      "Everybody who has put their address into the newsletter form, what they agreed to, what has happened to each one, and which messages have not been sent yet.",
    icon: Mails,
    /*
     * ⚠ THE SAME REFERENCE the screen and its export route use as their boundary —
     * `requireStudioCapability(canManageInquiries)` in app/studio/subscribers/page.tsx and
     * `requireCapability(canManageInquiries, …)` in app/studio/subscribers/export/route.ts — never a
     * second rank test that happens to agree today (contract §1.7). That screen's header argues the
     * choice at length: it holds reader-submitted personal data, which is what the contact inbox holds,
     * so it takes the inbox's predicate. One rule for "may this person read what the public typed".
     *
     * ⚠ NOT `canPurge`, although erasing a subscriber does take it. The higher permission guards ONE
     * action inside the screen, not the door to it; hiding the whole screen from everybody who cannot
     * erase would take the list away from exactly the colleagues it is for.
     */
    can: canManageInquiries,
    group: "Records"
  },
  {
    href: "/studio/analytics",
    label: "Analytics",
    description: "How many people read each page and downloaded each file, by day.",
    icon: ChartLine,
    can: canViewAnalytics,
    group: "Records"
  },
  {
    href: "/studio/audit",
    label: "Audit log",
    description: "Every change made in this studio: who made it, when, and what it replaced.",
    icon: ScrollText,
    can: canViewAuditLog,
    group: "Records"
  },
  {
    href: "/studio/recycle-bin",
    label: "Recycle bin",
    description: "Anything deleted recently. Restore it here, or remove it for good.",
    icon: Trash2,
    can: canRestoreDeleted,
    group: "Records"
  },

  // ── Oversight ─────────────────────────────────────────────────────────────
  // Master administrator only. See the note on `StudioNavGroup` for why these two are not filed with
  // "Users" and the audit log.
  {
    href: "/studio/access",
    label: "Studio access",
    description:
      "The list of email addresses allowed to sign in at all. Users decides what an account may change; this decides who may have one.",
    icon: ShieldCheck,
    can: canManageStudioAccess,
    group: "Oversight"
  },
  {
    href: "/studio/provenance",
    label: "Provenance",
    description:
      "The whole record of who did what, everywhere — including sign-ins that did not succeed, and the addresses they came from.",
    icon: Fingerprint,
    can: canViewProvenance,
    group: "Oversight"
  },

  // ── You ───────────────────────────────────────────────────────────────────
  // ⚠ ITS OWN GROUP, AND NOT ONE OF THE SEVEN ABOVE, because `canAccessStudio` means EVERY signed-in
  // reader sees it: filing it under "Oversight" would show that master-administrator heading to an
  // author, and "People" or "Site" would be a lie about what the screen is. It is the only screen in
  // the studio that is about the READER rather than about the studio or the website, and that is a
  // category of one.
  //
  // Until this entry existed, /studio/account was reachable by typing the address and by nothing
  // else — no link anywhere in the product — which made changing your own password a feature only
  // somebody who had read the source could find.
  {
    href: "/studio/account",
    label: "Your account",
    description:
      "Your name and picture as colleagues see them, the address you sign in with, your password, and the two-step verification that protects them.",
    icon: CircleUserRound,
    can: canAccessStudio,
    group: "You"
  }
];

export interface StudioNavSection {
  group: StudioNavGroup;
  entries: StudioNavEntry[];
}

/**
 * The nav tree this person may see.
 *
 * A group with nothing left in it is DROPPED rather than rendered empty — a heading over no links
 * reads as a screen that failed to load. The group order comes from `STUDIO_NAV_GROUPS`, not from the
 * order entries happen to appear in the array, so appending an entry can never reorder the sidebar.
 */
export function visibleStudioNav(
  subject: PermissionSubject | null | undefined
): StudioNavSection[] {
  // A Map rather than an index into a Record: with `noUncheckedIndexedAccess` every bucket read would
  // otherwise be `T | undefined` and need a guard that can only ever be dead code.
  const buckets = new Map<StudioNavGroup, StudioNavEntry[]>();
  for (const group of STUDIO_NAV_GROUPS) buckets.set(group, []);

  for (const entry of STUDIO_NAV) {
    if (!entry.can(subject)) continue;
    buckets.get(entry.group)?.push(entry);
  }

  const sections: StudioNavSection[] = [];
  for (const group of STUDIO_NAV_GROUPS) {
    const entries = buckets.get(group) ?? [];
    if (entries.length > 0) sections.push({ group, entries });
  }
  return sections;
}

/**
 * Every href in the visible tree, including the dashboard's — the input to `resolveActiveHref()`.
 *
 * The dashboard is included on purpose. `/studio` prefixes every other studio path, and the resolver's
 * LONGEST BASE WINS rule is what stops it lighting up on all of them: on `/studio/pages` both `/studio`
 * and `/studio/pages` match and the longer one is chosen, so exactly one link ever carries
 * `aria-current="page"`.
 */
export function studioNavHrefs(sections: readonly StudioNavSection[]): string[] {
  const hrefs = [STUDIO_HOME.href];
  for (const section of sections) {
    for (const entry of section.entries) hrefs.push(entry.href);
  }
  return hrefs;
}

/** Every visible entry as one flat list, dashboard first. For the jump-to panel and breadcrumbs. */
export function flatStudioNav(
  sections: readonly StudioNavSection[]
): Array<{ entry: Omit<StudioNavEntry, "group">; group: StudioNavGroup | null }> {
  const out: Array<{ entry: Omit<StudioNavEntry, "group">; group: StudioNavGroup | null }> = [
    { entry: STUDIO_HOME, group: null }
  ];
  for (const section of sections) {
    for (const entry of section.entries) out.push({ entry, group: section.group });
  }
  return out;
}

/**
 * Which entry does `activeBase` belong to?
 *
 * `activeBase` is the answer from `resolveActiveHref()` — already the longest matching base, so this
 * is an exact comparison rather than a second prefix test. Two prefix tests written in two files is
 * two chances to disagree about which screen the reader is on.
 */
export function findStudioNavEntry(
  sections: readonly StudioNavSection[],
  activeBase: string | null
): { entry: Omit<StudioNavEntry, "group">; group: StudioNavGroup | null } | null {
  if (!activeBase) return null;
  return flatStudioNav(sections).find(({ entry }) => entry.href === activeBase) ?? null;
}

/**
 * The event the top bar's search trigger raises, and Ctrl/Cmd+K with it.
 *
 * A HAND-OFF, NOT A DEPENDENCY. The trigger dispatches this on `window` as a CANCELABLE event. A
 * richer command palette mounted anywhere inside the studio may listen for it and call
 * `preventDefault()` to say "I have this"; if nothing does, `dispatchEvent` returns true and the top
 * bar opens its own jump-to panel instead. That is what keeps Ctrl+K from ever being a control that
 * looks live and does nothing — which is worse than no control at all.
 */
export const STUDIO_SEARCH_EVENT = "cxa:studio-search";
