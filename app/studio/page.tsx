import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import type { AuditAction } from "@prisma/client";
import {
  ArrowRight,
  BookMarked,
  CalendarClock,
  CalendarDays,
  CircleCheck,
  Eye,
  FileStack,
  Fingerprint,
  ImageOff,
  Inbox,
  KeyRound,
  Link2Off,
  Newspaper,
  ScrollText,
  ShieldCheck,
  ShieldOff,
  Upload,
  type LucideIcon
} from "lucide-react";

import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/current-user";
import { livePublishableWhere } from "@/lib/content";
import { pagePath } from "@/lib/pages";
import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  canAuthor,
  canManageContent,
  canManageInquiries,
  canManageMedia,
  canManageResearch,
  canManageStructure,
  canPublish,
  canViewAuditLog,
  isMasterAdmin,
  type PermissionSubject
} from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import { GettingStarted } from "@/components/studio/GettingStarted";

/**
 * The studio dashboard — "what needs me, and what has changed".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A SERVER COMPONENT READING PRISMA DIRECTLY, IN ONE BATCH. Twenty questions in one
 * `prisma.$transaction([...])` rather than sixteen awaited queries: sequentially each one pays a full
 * round trip to the database, and on a pooled connection over a network that is most of a second of
 * blank screen for numbers that are all small integers.
 *
 * "NEEDS YOUR ATTENTION" IS FIRST AND ABOVE EVERYTHING, and every row STATES ITS NUMBER and links to
 * the list already filtered. A dashboard whose top half is a decorative summary is a dashboard where
 * the three articles waiting for review are below the fold.
 *
 * EVERY ROW IS GATED BY THE SAME PREDICATE AS THE SCREEN IT POINTS AT. A row an author cannot act on
 * is not shown greyed out — it is not shown (contract §1.8). The review queues additionally require
 * `canPublish`, because "waiting for review" is a queue only somebody who can publish is able to
 * clear; showing it to the author who filled it would be a to-do list they cannot tick off.
 *
 * THE QUERIES ARE UNCONDITIONAL; THE RENDERING IS GATED. Building the batch from a set of predicates
 * would make the returned tuple's shape depend on the reader's role, which TypeScript cannot follow.
 * Counting rows a reader may not see costs one integer inside a transaction that was happening anyway,
 * and nothing leaves the server unless its predicate passes.
 *
 * THE FILTER LINKS DEGRADE GRACEFULLY. `?status=IN_REVIEW` and friends are what the list screens read;
 * a list screen that has not implemented a parameter yet simply shows its unfiltered self, which is a
 * useful screen rather than an error.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard"
};

/** How far ahead "publishing soon" looks. Seven days is a working week plus a weekend to prepare in. */
const SOON_DAYS = 7;

/**
 * How far BACK the master administrator's failed-sign-in figure looks.
 *
 * Its own constant rather than a reuse of `SOON_DAYS`: the two happen to be the same number of days and
 * mean opposite directions in time, and a later change to one must not silently move the other.
 */
const FAILED_SIGN_IN_DAYS = 7;

/**
 * How many audit entries the activity list shows.
 *
 * The cap is STATED ON SCREEN beside the list. A list that quietly stops is indistinguishable from a
 * place with only that many records (contract §1.6).
 */
const RECENT_ACTIVITY_LIMIT = 8;

/** How many broken menu links are named before the row says "and N more". */
const NAMED_BROKEN_LINKS = 3;

/**
 * Routes the CODE owns rather than a `Page` row: bespoke route files under `app/(site)`.
 *
 * A menu link to one of these is correct even though no `Page` row matches it, so the broken-link check
 * has to know them. Kept in step with the directory listing in contract §12 by hand — there is no
 * runtime way to enumerate a Next route tree, and a wrong entry here can only ever produce a false
 * alarm on the dashboard, never a broken link on the site.
 */
const CODE_OWNED_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/about",
  "/research",
  "/projects",
  "/publications",
  "/people",
  "/gallery",
  "/events",
  "/news",
  "/craft-explorer",
  "/contact",
  "/search"
]);

/**
 * First path segments whose CHILDREN are database-backed detail routes — `/research/heritage-ai`,
 * `/people/a-sharma`, `/news/tag/textiles`.
 *
 * Verifying those would mean a query per collection, which is not the "cheap to detect" this check is
 * allowed to be. They are therefore skipped rather than guessed at, and the row on screen says so.
 */
const UNCHECKABLE_COLLECTIONS: ReadonlySet<string> = new Set([
  "research",
  "projects",
  "publications",
  "people",
  "gallery",
  "events",
  "news",
  "craft-explorer",
  "search"
]);

/** "3 pages" / "1 page". Written out because an English plural is not a suffix rule worth guessing. */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Verb phrases for the audit log, in PLAIN WORDS.
 *
 * The audit SCREEN owns the fuller vocabulary (filters, the before/after view); this is the reading
 * version, and it is deliberately a sentence fragment that follows a person's name: "Priya published".
 *
 * A total `Record` so adding an `AuditAction` is a compile error here rather than a blank word on the
 * dashboard — and it is READ through a `Partial` view, so a row written by a newer deploy than this
 * one still renders something rather than `undefined`.
 */
const ACTION_PHRASES: Record<AuditAction, string> = {
  CREATE: "created",
  UPDATE: "updated",
  DELETE: "moved to the recycle bin",
  RESTORE: "restored from the recycle bin",
  PUBLISH: "published",
  UNPUBLISH: "took offline",
  ARCHIVE: "archived",
  LOGIN: "signed in",
  LOGIN_FAILED: "could not sign in",
  LOGOUT: "signed out",
  PERMISSION_CHANGE: "changed what one person is allowed to do —",
  UPLOAD: "uploaded",
  PURGE: "permanently deleted",
  ROLLBACK: "put back an earlier version of"
};

/** Plain nouns for the polymorphic `entityType`, for entries with no label of their own. */
const ENTITY_NOUNS: Record<string, string> = {
  Page: "a page",
  PageSection: "a block on a page",
  Post: "a news article",
  Person: "a person's profile",
  Project: "a project",
  Publication: "a publication",
  ResearchArea: "a research area",
  CoeEvent: "an event",
  Craft: "a craft record",
  GalleryAlbum: "a gallery album",
  MediaAsset: "a media file",
  FileAsset: "a file",
  User: "a user account",
  NavigationItem: "a menu item",
  Setting: "a setting",
  Redirect: "a redirect",
  Partner: "a partner",
  ContactSubmission: "an enquiry"
};

function nounFor(entityType: string): string {
  const known = ENTITY_NOUNS[entityType];
  if (known) return known;
  // "SomethingNew" → "a something new". Better than printing a class name at somebody.
  const words = entityType.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return `a ${words}`;
}

interface ActivityEntry {
  id: string;
  action: AuditAction;
  entityType: string;
  entityLabel: string | null;
  actorEmail: string | null;
  createdAt: Date;
  actor: { name: string } | null;
}

/** One sentence per audit entry: who, what, and what it was called. No enum names, ever. */
function describeActivity(entry: ActivityEntry): string {
  const phrases: Partial<Record<AuditAction, string>> = ACTION_PHRASES;
  // The actor's row may have been deleted since; `actorEmail` is denormalised onto the log for exactly
  // that reason, so the trail survives the account.
  const who = entry.actor?.name.trim() || entry.actorEmail || "Somebody";
  const label = entry.entityLabel?.trim();

  switch (entry.action) {
    case "LOGIN":
      return `${who} signed in`;
    case "LOGOUT":
      return `${who} signed out`;
    case "LOGIN_FAILED":
      // Never "who": a failed attempt names the address that was TRIED, which may not be a real person.
      return `A sign-in for ${label ?? "an account"} did not succeed`;
    default:
      return `${who} ${phrases[entry.action] ?? "changed"} ${label ?? nounFor(entry.entityType)}`;
  }
}

interface AttentionRow {
  key: string;
  /** True when this reader is allowed to act on it at all. A false row is absent, never disabled. */
  applies: boolean;
  count: number;
  href: string;
  /** States the number. This is the line an administrator scans. */
  title: string;
  detail: string;
  icon: LucideIcon;
}

/**
 * One figure in the master administrator's panel.
 *
 * `concern` is what decides the tile's tone AND whether the panel can say everything is in order — the
 * two must be driven by the same flag, or a panel could go amber while its own summary says all is well.
 * The number is in `title`, in words, because a large numeral with a caption under it is a figure people
 * read and do not act on.
 */
interface OversightFigure {
  key: string;
  href: string;
  title: string;
  detail: string;
  icon: LucideIcon;
  concern: boolean;
}

interface QuickCreate {
  href: string;
  label: string;
  icon: LucideIcon;
  can: (subject: PermissionSubject | null | undefined) => boolean;
}

const QUICK_CREATE: readonly QuickCreate[] = [
  { href: "/studio/pages/new", label: "New page", icon: FileStack, can: canManageStructure },
  { href: "/studio/news/new", label: "New news article", icon: Newspaper, can: canAuthor },
  { href: "/studio/events/new", label: "New event", icon: CalendarDays, can: canManageContent },
  {
    href: "/studio/publications/new",
    label: "New publication",
    icon: BookMarked,
    can: canManageResearch
  },
  { href: "/studio/media", label: "Upload media", icon: Upload, can: canManageMedia }
];

export default async function StudioDashboardPage() {
  // The authoritative role, re-read from the row. Middleware has already refused an anonymous request
  // to this path, so this is the second of the two guards rather than the only one.
  const user = await requireUser();

  const now = new Date();
  const soon = new Date(now.getTime() + SOON_DAYS * 24 * 60 * 60 * 1000);
  const signInWindowOpened = new Date(now.getTime() - FAILED_SIGN_IN_DAYS * 24 * 60 * 60 * 1000);

  const [
    pagesInReview,
    postsInReview,
    peopleInReview,
    projectsInReview,
    publicationsInReview,
    eventsInReview,
    craftsInReview,
    albumsInReview,
    areasInReview,
    pagesPublishingSoon,
    postsPublishingSoon,
    newEnquiries,
    imagesMissingAlt,
    recentActivity,
    navigationLinks,
    livePageSlugs,
    accessGrants,
    grantsNeverUsed,
    failedSignIns,
    privilegedWithoutTwoFactor
  ] = await prisma.$transaction([
    // Every count filters soft deletes. A row in the recycle bin is not waiting for anybody.
    prisma.page.count({ where: { deletedAt: null, status: "IN_REVIEW" } }),
    prisma.post.count({ where: { deletedAt: null, status: "IN_REVIEW" } }),
    prisma.person.count({ where: { deletedAt: null, status: "IN_REVIEW" } }),
    prisma.project.count({ where: { deletedAt: null, status: "IN_REVIEW" } }),
    prisma.publication.count({ where: { deletedAt: null, status: "IN_REVIEW" } }),
    prisma.coeEvent.count({ where: { deletedAt: null, status: "IN_REVIEW" } }),
    prisma.craft.count({ where: { deletedAt: null, status: "IN_REVIEW" } }),
    prisma.galleryAlbum.count({ where: { deletedAt: null, status: "IN_REVIEW" } }),
    prisma.researchArea.count({ where: { deletedAt: null, status: "IN_REVIEW" } }),

    // Only `Page` and `Post` carry `publishAt` — the other models have `status` alone, and asking them
    // for a column they do not have is a Prisma runtime error, not a type error (lib/content.ts).
    prisma.page.count({
      where: {
        deletedAt: null,
        status: "SCHEDULED",
        publishAt: { gte: now, lte: soon }
      }
    }),
    prisma.post.count({
      where: {
        deletedAt: null,
        status: "SCHEDULED",
        publishAt: { gte: now, lte: soon }
      }
    }),

    prisma.contactSubmission.count({ where: { deletedAt: null, state: "NEW" } }),

    /**
     * ⚠ `null` ONLY. An empty string is NOT a missing description, and counting it here is a real defect
     * rather than a harmless approximation.
     *
     * The two values mean different things, and `components/studio/media/MediaDetailPanel.tsx` is what
     * makes them mean it: `null` is "nobody has written one", while `""` is written deliberately by the
     * "this image is decorative" checkbox — and it is that checkbox, being the only thing that can tell
     * the two apart, that reads them back (`decorative: detail.altText !== null && …`).
     *
     * `alt=""` is MEANINGFUL HTML, not an absence: it instructs a screen reader to skip the image, which
     * for a border, a texture or a spacer is exactly right and exactly complete. So collapsing the two
     * with an OR makes this tile nag forever about images an editor has already finished — and a backlog
     * figure that never reaches zero however much work is done is a figure people stop reading, which
     * costs the genuine gaps their only prompt.
     */
    prisma.mediaAsset.count({
      where: { deletedAt: null, kind: "IMAGE", altText: null }
    }),

    prisma.auditLog.findMany({
      take: RECENT_ACTIVITY_LIMIT,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        action: true,
        entityType: true,
        entityLabel: true,
        actorEmail: true,
        createdAt: true,
        actor: { select: { name: true } }
      }
    }),

    // The cheap half of a link check: the menus are one small table, and the published pages are the
    // only destinations that can be verified without a query per collection.
    prisma.navigationItem.findMany({
      where: { isVisible: true, isExternal: false },
      select: { id: true, label: true, href: true, location: true }
    }),
    prisma.page.findMany({ where: livePublishableWhere(now), select: { slug: true } }),

    /**
     * The four master-administrator figures.
     *
     * They are asked UNCONDITIONALLY, like everything above, because building the batch from the
     * reader's role would make the returned tuple's shape depend on it and TypeScript cannot follow
     * that. Four integers cost nothing inside a transaction that was happening anyway, and none of them
     * leaves the server unless `isMasterAdmin` passes.
     */

    // Live grants. A revoked row is kept so the record of who was once allowed in survives
    // (prisma/schema.prisma), so "can sign in" is the ones without a revocation.
    prisma.studioAccess.count({ where: { revokedAt: null } }),
    // A grant nobody has ever used. The single most useful figure on the access screen: an access list
    // that cannot be pruned is one that only ever grows.
    prisma.studioAccess.count({ where: { revokedAt: null, lastSignInAt: null } }),
    prisma.auditLog.count({
      where: { action: "LOGIN_FAILED", createdAt: { gte: signInWindowOpened } }
    }),
    // Both top tiers, counted together: what matters is that the accounts which can change who gets in,
    // or what everybody may do, are behind more than a password.
    prisma.user.count({
      where: {
        deletedAt: null,
        isActive: true,
        twoFactorEnabled: false,
        role: { in: ["ADMINISTRATOR", "MASTER_ADMIN"] }
      }
    })
  ]);

  const livePagePaths = new Set(livePageSlugs.map((row) => pagePath(row.slug)));

  const brokenLinks: string[] = [];
  for (const item of navigationLinks) {
    const href = item.href.trim();
    // Anything that is not a site path is somebody else's problem: an absolute URL, a `mailto:`, a
    // `tel:`, or an in-page anchor.
    if (!href.startsWith("/")) continue;
    const base = href.split("?")[0]?.split("#")[0] ?? "";
    if (base.length === 0) continue;
    if (CODE_OWNED_ROUTES.has(base)) continue;
    if (UNCHECKABLE_COLLECTIONS.has(base.split("/")[1] ?? "")) continue;
    if (livePagePaths.has(base)) continue;
    brokenLinks.push(`${item.label} (${item.location})`);
  }

  /**
   * The broken-link row's second line: which links, then what the check does not cover.
   *
   * Named rather than merely counted — "3 menu links are broken" sends an administrator hunting through
   * three menus, and the labels are the whole difference between a number and a job. The list is capped
   * and SAYS SO, because a row that quietly stopped at three would read as three being all there were.
   */
  const namedBroken = brokenLinks.slice(0, NAMED_BROKEN_LINKS).join(", ");
  const extraBroken =
    brokenLinks.length > NAMED_BROKEN_LINKS
      ? ` and ${brokenLinks.length - NAMED_BROKEN_LINKS} more`
      : "";
  const brokenDetail = `${brokenLinks.length > 0 ? `${namedBroken}${extraBroken}. ` : ""}This check only covers links to pages you manage in the studio — links into research, projects, people, news, events and the gallery are not checked here.`;

  // Reviewing is a publishing act. An author who moved their own draft into review cannot take it out
  // again, so the queue is not their to-do list.
  const mayReview = canPublish(user);

  const attention: AttentionRow[] = [
    {
      key: "pages-review",
      applies: mayReview && canManageStructure(user),
      count: pagesInReview,
      href: "/studio/pages?status=IN_REVIEW",
      title: `${count(pagesInReview, "page is", "pages are")} waiting for review`,
      detail: "Somebody has finished a draft and asked for it to be checked before it goes live.",
      icon: Eye
    },
    {
      key: "news-review",
      applies: mayReview && canAuthor(user),
      count: postsInReview,
      href: "/studio/news?status=IN_REVIEW",
      title: `${count(postsInReview, "news article is", "news articles are")} waiting for review`,
      detail: "Read it, then publish it or send it back with a note.",
      icon: Eye
    },
    {
      key: "people-review",
      applies: mayReview && canManageContent(user),
      count: peopleInReview,
      href: "/studio/people?status=IN_REVIEW",
      title: `${count(peopleInReview, "profile is", "profiles are")} waiting for review`,
      detail: "New or updated entries for the people pages.",
      icon: Eye
    },
    {
      key: "events-review",
      applies: mayReview && canManageContent(user),
      count: eventsInReview,
      href: "/studio/events?status=IN_REVIEW",
      title: `${count(eventsInReview, "event is", "events are")} waiting for review`,
      detail: "Check the date, the venue and the registration details before publishing.",
      icon: Eye
    },
    {
      key: "gallery-review",
      applies: mayReview && canManageContent(user),
      count: albumsInReview,
      href: "/studio/gallery?status=IN_REVIEW",
      title: `${count(albumsInReview, "album is", "albums are")} waiting for review`,
      detail: "Photographs are ready but the album has not been published yet.",
      icon: Eye
    },
    {
      key: "research-review",
      applies: mayReview && canManageResearch(user),
      count: areasInReview,
      href: "/studio/research?status=IN_REVIEW",
      title: `${count(areasInReview, "research area is", "research areas are")} waiting for review`,
      detail: "Projects and publications are filed under these, so they are worth checking early.",
      icon: Eye
    },
    {
      key: "projects-review",
      applies: mayReview && canManageResearch(user),
      count: projectsInReview,
      href: "/studio/projects?status=IN_REVIEW",
      title: `${count(projectsInReview, "project is", "projects are")} waiting for review`,
      detail: "Funding figures and named members are the two things most often wrong.",
      icon: Eye
    },
    {
      key: "publications-review",
      applies: mayReview && canManageResearch(user),
      count: publicationsInReview,
      href: "/studio/publications?status=IN_REVIEW",
      title: `${count(publicationsInReview, "publication is", "publications are")} waiting for review`,
      detail: "Check the author line and the DOI — both are quoted by other people.",
      icon: Eye
    },
    {
      key: "crafts-review",
      applies: mayReview && canManageResearch(user),
      count: craftsInReview,
      href: "/studio/crafts?status=IN_REVIEW",
      title: `${count(craftsInReview, "craft record is", "craft records are")} waiting for review`,
      detail: "Local names, regions and techniques, ready to be checked.",
      icon: Eye
    },
    {
      key: "pages-soon",
      applies: canManageStructure(user),
      count: pagesPublishingSoon,
      href: "/studio/pages?status=SCHEDULED",
      title: `${count(pagesPublishingSoon, "page publishes", "pages publish")} in the next seven days`,
      detail: "They will go live on their own at the time set on each one. Nothing needs pressing.",
      icon: CalendarClock
    },
    {
      key: "news-soon",
      applies: canAuthor(user),
      count: postsPublishingSoon,
      href: "/studio/news?status=SCHEDULED",
      title: `${count(postsPublishingSoon, "news article publishes", "news articles publish")} in the next seven days`,
      detail: "A last read before it appears is usually worth the five minutes.",
      icon: CalendarClock
    },
    {
      key: "enquiries",
      applies: canManageInquiries(user),
      count: newEnquiries,
      href: "/studio/inquiries?state=NEW",
      title: `${count(newEnquiries, "new enquiry", "new enquiries")} nobody has picked up`,
      detail: "Messages sent through the contact forms. Assign one to yourself to claim it.",
      icon: Inbox
    },
    {
      key: "alt-text",
      applies: canManageMedia(user),
      count: imagesMissingAlt,
      href: "/studio/media?missingAlt=1",
      title: `${count(imagesMissingAlt, "image has", "images have")} no description`,
      detail:
        "A short sentence describing each picture is what somebody using a screen reader hears instead of it. Photographs that are purely decorative can be marked as such.",
      icon: ImageOff
    },
    {
      key: "broken-links",
      applies: canManageStructure(user),
      count: brokenLinks.length,
      href: "/studio/navigation",
      title: `${count(brokenLinks.length, "menu link points", "menu links point")} at a page that is not published`,
      detail: brokenDetail,
      icon: Link2Off
    }
  ];

  const applicable = attention.filter((row) => row.applies);
  const outstanding = applicable.filter((row) => row.count > 0);
  const quickCreate = QUICK_CREATE.filter((item) => item.can(user));
  const mayReadActivity = canViewAuditLog(user);

  /**
   * The master administrator's panel.
   *
   * Built for every reader and RENDERED for one. `isMasterAdmin` is the same predicate that hides the
   * Oversight group in the sidebar and guards the two screens these tiles link to, so a reader who can
   * see a figure can always open the screen that acts on it — an ungated tile landing on a refusal is
   * exactly what contract §1.8 forbids.
   */
  const oversight: OversightFigure[] = [
    {
      key: "access-grants",
      href: "/studio/access",
      title: `${count(accessGrants, "person is", "people are")} allowed to sign in`,
      detail:
        "The studio access list. Nothing else lets somebody in: not a password they were given, not a Google account at the right domain.",
      icon: ShieldCheck,
      concern: false
    },
    {
      key: "grants-never-used",
      href: "/studio/access?used=never",
      title: `${count(grantsNeverUsed, "address has", "addresses have")} never been used`,
      detail:
        "Nobody has ever signed in with these. An address that was added for a visitor last spring is one to take off the list.",
      icon: KeyRound,
      concern: grantsNeverUsed > 0
    },
    {
      key: "failed-sign-ins",
      href: "/studio/provenance?action=LOGIN_FAILED",
      title: `${count(failedSignIns, "sign-in did", "sign-ins did")} not succeed in the last seven days`,
      detail:
        "A forgotten password looks the same as somebody trying addresses. The provenance console shows which addresses were tried, and from where.",
      icon: Fingerprint,
      concern: failedSignIns > 0
    },
    {
      key: "no-second-factor",
      // Deliberately UNFILTERED. The figure counts administrators and master administrators together, and
      // the users screen filters by one role at a time — a link that showed only one of the two tiers would
      // list fewer people than the number beside it, which reads as a fault in whichever screen is doubted.
      href: "/studio/users",
      title: `${count(privilegedWithoutTwoFactor, "administrator has", "administrators have")} no second factor`,
      detail:
        "Counting administrators and master administrators together. A password on its own is all that protects these accounts, and only the person themselves can switch two-step verification on, from their own account screen.",
      icon: ShieldOff,
      concern: privilegedWithoutTwoFactor > 0
    }
  ];

  const oversightClear = oversight.every((figure) => !figure.concern);

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-10">
      <header>
        <h1 className="display-title text-2xl sm:text-3xl">Dashboard</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-500">
          Signed in as {user.name} — {ROLE_LABELS[user.role].toLowerCase()}.{" "}
          {ROLE_DESCRIPTIONS[user.role]}
        </p>
      </header>

      {/*
        THE FIRST-RUN CHECKLIST, and it sits ABOVE "Needs your attention" deliberately.

        On a fresh installation the attention panel is empty — there is no content yet for anything to
        be wrong with — so a dashboard without this was a heading, a blank space and no indication of
        what to do first. The component renders nothing at all once every applicable item is done, and
        nothing for a reader who cannot manage settings, so it is invisible on a running site.
      */}
      <GettingStarted user={user} />

      <section aria-labelledby="attention-heading">
        <h2 id="attention-heading" className="font-display text-lg font-semibold text-ink-900">
          Needs your attention
        </h2>

        {outstanding.length === 0 ? (
          // Said plainly, in one sentence, rather than as an empty panel with an illustration in it.
          <p className="panel mt-3 flex items-start gap-2.5 px-4 py-3.5 text-sm leading-relaxed text-ink-700">
            <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
            <span>
              {applicable.length === 0
                ? "Nothing here is yours to act on. Your account can read the studio but does not look after any of the queues that appear on this page."
                : "Nothing is waiting for you. No drafts are in review, nothing is due to publish in the next seven days, and everything else on this list is clear."}
            </span>
          </p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {outstanding.map((row) => {
              const Icon = row.icon;
              return (
                <li key={row.key}>
                  <Link
                    href={row.href}
                    className="panel group flex items-start gap-3.5 px-4 py-3.5 transition-colors hover:border-purple-300 hover:bg-purple-50"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-purple-100 text-purple-700"
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink-900">{row.title}</span>
                      <span className="mt-1 block text-sm leading-relaxed text-ink-500">
                        {row.detail}
                      </span>
                    </span>
                    <ArrowRight
                      aria-hidden="true"
                      className="mt-1.5 h-4 w-4 shrink-0 text-ink-300 transition-colors group-hover:text-purple-700"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {quickCreate.length > 0 ? (
        <section aria-labelledby="create-heading">
          <h2 id="create-heading" className="font-display text-lg font-semibold text-ink-900">
            Start something new
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-500">
            Only the things your account is allowed to create are listed here.
          </p>
          <div className="mt-3 flex flex-wrap gap-2.5">
            {quickCreate.map((item) => (
              <LinkButton key={item.href} href={item.href} variant="secondary" icon={item.icon}>
                {item.label}
              </LinkButton>
            ))}
          </div>
        </section>
      ) : null}

      {/*
        MASTER ADMINISTRATOR ONLY, and about the studio rather than about the website: who may sign in,
        which grants nobody uses, which sign-ins failed, and which of the two top tiers are behind a
        password alone. A failing check renders nothing at all (contract §1.8).
      */}
      {isMasterAdmin(user) ? (
        <section aria-labelledby="oversight-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="oversight-heading" className="font-display text-lg font-semibold text-ink-900">
              Who can get in
            </h2>
            <Link
              href="/studio/access"
              className="text-sm font-medium text-purple-700 transition hover:text-purple-800"
            >
              Open the studio access list
            </Link>
          </div>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-500">
            Only a master administrator sees this. The Users screen decides what an account may change;
            these figures are about whether somebody may be here at all.
          </p>

          <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
            {oversight.map((figure) => {
              const Icon = figure.icon;
              return (
                <li key={figure.key}>
                  <Link
                    href={figure.href}
                    className="panel group flex h-full items-start gap-3.5 px-4 py-3.5 transition-colors hover:border-purple-300 hover:bg-purple-50"
                  >
                    {/*
                      The tone is a second signal, never the only one: the title states the number and
                      the thing in words, so a reader who cannot separate amber from purple — or who is
                      looking at a printout — loses nothing (contract §11).
                    */}
                    <span
                      aria-hidden="true"
                      className={
                        figure.concern
                          ? "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-800"
                          : "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-purple-100 text-purple-700"
                      }
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink-900">{figure.title}</span>
                      <span className="mt-1 block text-sm leading-relaxed text-ink-500">
                        {figure.detail}
                      </span>
                    </span>
                    <ArrowRight
                      aria-hidden="true"
                      className="mt-1.5 h-4 w-4 shrink-0 text-ink-300 transition-colors group-hover:text-purple-700"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>

          {/*
            Said plainly when there is nothing to do, rather than left as four tiles a reader has to
            compare against zero themselves.
          */}
          {oversightClear ? (
            <p className="mt-2.5 flex items-start gap-2.5 text-sm leading-relaxed text-ink-700">
              <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
              <span>
                Nothing here needs attention. Every address on the access list has been used, no sign-in
                has failed in the last seven days, and every administrator has a second factor.
              </span>
            </p>
          ) : null}
        </section>
      ) : null}

      {/*
        The whole panel is administrator-only, because the audit log is: `canViewAuditLog` is the
        predicate the /studio/audit screen and its route handler both use, and a "recent activity" feed
        on a dashboard is the same data with a friendlier layout. A failing check renders nothing.
      */}
      {mayReadActivity ? (
        <section aria-labelledby="activity-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="activity-heading" className="font-display text-lg font-semibold text-ink-900">
              Recent activity
            </h2>
            <Link
              href="/studio/audit"
              className="text-sm font-medium text-purple-700 transition hover:text-purple-800"
            >
              Open the full audit log
            </Link>
          </div>

          {recentActivity.length === 0 ? (
            <p className="panel mt-3 px-4 py-3.5 text-sm leading-relaxed text-ink-500">
              Nothing has been recorded yet. Every change made in the studio appears here, with the name
              of whoever made it.
            </p>
          ) : (
            <>
              <ol className="panel mt-3 divide-y divide-line-200">
                {recentActivity.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
                    <ScrollText
                      aria-hidden="true"
                      className="mt-0.5 h-4 w-4 shrink-0 text-ink-300"
                    />
                    <span className="min-w-0 flex-1 text-sm leading-relaxed text-ink-700">
                      {describeActivity(entry)}
                    </span>
                    {/*
                      Relative time for reading, the exact instant in the tooltip for anybody who needs
                      it. UTC is named rather than assumed: the Centre's display timezone is a setting,
                      and a bare time with no zone beside an audit entry is a time somebody will
                      mis-read during an incident.
                    */}
                    <time
                      dateTime={entry.createdAt.toISOString()}
                      title={`${entry.createdAt.toLocaleString("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "UTC"
                      })} UTC`}
                      className="shrink-0 text-xs text-ink-500"
                    >
                      {formatDistanceToNow(entry.createdAt, { addSuffix: true })}
                    </time>
                  </li>
                ))}
              </ol>

              {/* The cap, on screen. See RECENT_ACTIVITY_LIMIT. */}
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                {recentActivity.length === RECENT_ACTIVITY_LIMIT
                  ? `Showing the ${RECENT_ACTIVITY_LIMIT} most recent entries. There may be more — the full audit log has all of them.`
                  : `Showing ${count(recentActivity.length, "entry", "entries")}, which is all there are.`}
              </p>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
