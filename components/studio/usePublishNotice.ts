"use client";

/**
 * usePublishNotice — the moment a record crosses onto the public site, and the link that goes with it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT FIRES ON THE CROSSING, NOT ON THE STATUS.
 *
 * Every editor in the studio saves through `useAutosave`, and a published record is saved repeatedly —
 * an editor fixing three typos on a live page presses Save three times. Announcing "this is public"
 * on every save of a public record is three identical notices about news that broke on the first one,
 * and it trains the reader to dismiss the toast without reading it. So this hook keeps the previous
 * answer in a ref, seeded from the row the SCREEN OPENED WITH, and speaks only on false → true.
 *
 * ⚠ THE QUESTION IT ASKS IS `isLive()`, NEVER `status === "PUBLISHED"`. Publication is resolved at read
 * time (lib/content.ts): a SCHEDULED row whose date has passed is already live, a PUBLISHED row whose
 * `unpublishAt` has gone by is not, and both of those are exactly the cases a hand-written status
 * comparison gets wrong. Getting it wrong in the optimistic direction is the bad one — a toast handing
 * an editor the address of something that is not up yet sends them, and whoever they forward it to, to
 * a "page not found", and the editor concludes the publish failed.
 *
 * WHICH IS ALSO WHY SCHEDULING IS SILENT HERE. Setting a record to go live next Tuesday produces no
 * notice: there is no link to give out yet. `StatusControl` already prints the whole truth about when
 * it will go — "Scheduled to go public on 4 June" — beside the picker the reader has just used.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE ADDRESS IS ASSEMBLED THE SAME WAY `SlugField` PREVIEWS IT — origin, base path, slug — so the box
 * in the form and the link in the toast cannot disagree about where the thing has just gone. Pass the
 * same `basePath` you pass to `SlugField` on that screen, with both slashes.
 */

import { useCallback, useRef } from "react";
import type { ContentStatus } from "@prisma/client";

import { isLive } from "@/lib/content";
import { useToast } from "@/components/ui/ToastProvider";

/**
 * A record's publication state as an EDITOR holds it: a status, an address fragment, and ISO instants
 * for the two models that have the columns.
 *
 * `publishAt`/`unpublishAt` are optional because most models do not carry them — `Person`, `Project`,
 * `Publication`, `Craft`, `Album` and the rest have only `status` (see `StatusControl`'s header). An
 * absent one is read as "no such date", which is what `isLive()` wants for those models anyway.
 */
export interface PublishSnapshot {
  status: ContentStatus;
  /** The address fragment, with no slashes around it. Empty is legal only for the CMS homepage. */
  slug: string;
  publishAt?: string | null;
  unpublishAt?: string | null;
}

export interface PublishNoticeOptions {
  /**
   * The record as the screen OPENED it. This is the baseline the crossing is measured from, and
   * getting it from anywhere else is what would make an already-live page announce itself on the first
   * save of a typo fix.
   */
  initial: PublishSnapshot;
  /** The site's own address with no trailing slash — `siteUrl().replace(/\/+$/, "")`. */
  origin: string;
  /** What comes before the fragment, with BOTH slashes: "/news/". Just "/" for a CMS page. */
  basePath: string;
  /**
   * The noun for the sentence, lower case and singular: "page", "article", "craft record". It is read
   * aloud as part of the announcement, so it has to be a word an administrator uses, not a model name.
   */
  subject: string;
}

/** ISO in, `Date` or null out. An unparseable instant is treated as absent — see `isLive()`. */
function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The address a visitor will actually type.
 *
 * The slug is stripped of stray slashes at both ends rather than trusted: a `Page`'s address may
 * legitimately contain them in the middle ("research/roadmap"), so they cannot simply be removed, and
 * a leading one would produce "https://example.org//research" — which some servers redirect, some
 * serve, and some 404.
 */
function publicUrl(origin: string, basePath: string, slug: string): string {
  const root = origin.replace(/\/+$/, "");
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  const fragment = slug.trim().replace(/^\/+|\/+$/g, "");
  // An empty fragment is the CMS homepage, whose whole address is the origin and the base path.
  return fragment.length === 0 ? `${root}${base}` : `${root}${base}${fragment}`;
}

function liveNow(snapshot: PublishSnapshot): boolean {
  return isLive({
    status: snapshot.status,
    publishAt: parseDate(snapshot.publishAt),
    unpublishAt: parseDate(snapshot.unpublishAt),
    // A deleted record cannot reach this hook: the editor for it has been navigated away from. Stated
    // rather than left out, because `isLive()` reads every field and a silent `undefined` here would
    // be a guess about the one that governs everything else.
    deletedAt: null
  });
}

/**
 * Returns the function to call after a successful save, with the snapshot that was SENT.
 *
 * Call it from `useAutosave`'s `onSaved`. It is safe to call on every save — deciding whether there is
 * anything to say is the whole job.
 */
export function usePublishNotice({
  initial,
  origin,
  basePath,
  subject
}: PublishNoticeOptions): (saved: PublishSnapshot) => void {
  const { toast } = useToast();

  /**
   * Whether the record was public the last time this hook looked. A ref rather than state: nothing
   * renders differently because of it, and a `setState` here would re-render every editor in the
   * studio on every save for a value nobody draws.
   */
  const wasLive = useRef(liveNow(initial));

  return useCallback(
    (saved: PublishSnapshot) => {
      const nowLive = liveNow(saved);
      const crossed = nowLive && !wasLive.current;
      // Written whichever way it went. Taking something down and putting it back up is a second
      // crossing and deserves the link again — the address may well have changed in between.
      wasLive.current = nowLive;
      if (!crossed) return;

      toast({
        tone: "success",
        title: `The ${subject} is on the public site`,
        description: "Anyone with the address can read it now.",
        link: {
          url: publicUrl(origin, basePath, saved.slug),
          label: `Public address of this ${subject}`,
          // Safe to follow: it is a public page, and opening it is the check an editor wants to make
          // first. (Contrast the one-off password link in user management, which is spent on use.)
          openable: true
        }
      });
    },
    [basePath, origin, subject, toast]
  );
}
