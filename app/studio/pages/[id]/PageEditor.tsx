"use client";

/**
 * PageEditor — the settings, search-engine listing and history that sit around the page builder.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PANELS ARE RENDERED HERE, AND `Tabs` IS USED AS A SELECTOR ONLY. That is deliberate and it is
 * the one unusual thing in this file.
 *
 * `Tabs` renders only the selected panel, which is right almost everywhere and wrong here: the builder
 * holds the ONLY working copy of every block on the page, and a published page is never autosaved
 * (`useAutosave`'s header explains why). Unmounting the builder to look at the SEO tab would therefore
 * throw away an editor's typing with nothing on screen to warn them. So the Content panel stays mounted
 * for the life of the screen and is hidden with the `hidden` attribute when another tab is chosen.
 *
 * The price is that the tabs cannot claim `aria-controls` — `Tabs` only wires that up for panels it
 * renders itself, and pointing at an id it did not create would be worse than not pointing (contract
 * §11). Each panel therefore names itself with `aria-label`, so a screen reader landing in one is told
 * which it is.
 *
 * ONE SAVE BAR AT A TIME. The builder brings its own, for the blocks; this file's is for the page's own
 * fields. They are never both in the layout, because the Content panel is `hidden` whenever this one is
 * shown and vice versa. Two save bars claiming different things about the same screen is the fastest way
 * to make an editor distrust both.
 *
 * THE LOCK NEVER BLOCKS EDITING. `ContentLock` is advisory by design (see prisma/schema.prisma): it
 * says "somebody else has this open", names them, says since when, and offers to take it over. A lock
 * that locked would strand content the moment somebody closed a laptop — and an editor who takes one
 * over is RECORDED rather than refused, which is the only version of this that survives a deadline.
 * If the lock cannot be checked at all, the screen says so once and gets out of the way.
 *
 * THE SEO PANEL SHOWS THE RESULT, NOT THE FIELDS. A title field with a character count tells an
 * administrator nothing about what a search result will look like, and "72/60" is a number with no
 * action attached. So the panel draws the search result and the share card as they will appear, cuts
 * the text where the real thing cuts it, and lists what is missing IN WORDS.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  CircleCheck,
  ExternalLink,
  History,
  Image as ImageIcon,
  LayoutList,
  Search,
  Settings,
  Share2,
  TriangleAlert,
  UserRoundCheck,
  X
} from "lucide-react";
import type { ContentStatus } from "@prisma/client";

import { asApiClientError, buildQuery, del, get, patch, post } from "@/lib/client/fetcher";
import type { MediaLike } from "@/lib/media/url";
import { canPublish as canPublishPredicate, type PermissionSubject } from "@/lib/permissions";
import { cn, truncateWords } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { MediaImage } from "@/components/ui/MediaImage";
import { Switch } from "@/components/ui/Switch";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { RevisionHistory, type RevisionData, type RevisionSummary } from "@/components/studio/RevisionHistory";
import { SaveBar } from "@/components/studio/SaveBar";
import { SlugField } from "@/components/studio/SlugField";
import { StatusControl, statusProblems, type StatusControlValue } from "@/components/studio/StatusControl";
import { PUBLISHED_AUTOSAVE_NOTICE, useAutosave } from "@/components/studio/useAutosave";
import { usePublishNotice } from "@/components/studio/usePublishNotice";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
import { PageBuilder } from "@/components/studio/builder/PageBuilder";
import type { BuilderSection } from "@/components/studio/builder/SectionCard";
import { MediaPicker } from "@/components/studio/media/MediaPicker";
import type { StudioMediaAsset } from "@/components/studio/media/MediaGrid";

// ─────────────────────────────────────────────────────────────────────────────
// Limits, and why each one is where it is
// ─────────────────────────────────────────────────────────────────────────────

/** Google cuts a result title at roughly 60 characters. The field allows a little more; the preview cuts. */
const SEO_TITLE_IDEAL = 60;
const SEO_TITLE_MAX = 90;

/** Descriptions are cut at roughly 155 characters, and under about 70 there is not room to say anything. */
const SEO_DESCRIPTION_MIN_USEFUL = 70;
const SEO_DESCRIPTION_IDEAL = 155;
const SEO_DESCRIPTION_MAX = 220;

const TITLE_MAX = 160;
const NAV_LABEL_MAX = 60;

/** How often the lock's expiry is pushed forward. Well inside any sane expiry window. */
const LOCK_HEARTBEAT_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/** The page's own fields, as this form holds them and as they cross the wire. */
export interface PageSettingsValue {
  title: string;
  /** The full path with no leading slash. `""` is the homepage. */
  slug: string;
  navLabel: string;
  status: ContentStatus;
  publishedAt: string | null;
  publishAt: string | null;
  unpublishAt: string | null;
  seoTitle: string;
  seoDescription: string;
  seoImageId: string | null;
  seoNoIndex: boolean;
  canonicalUrl: string;
  sortOrder: number;
}

/** What `POST /api/studio/pages` and `PATCH /api/studio/pages/{id}` answer with. */
interface PageResponse {
  page: { id: string } & Partial<PageSettingsValue>;
}

interface LockHolder {
  userId: string;
  userName: string;
  userEmail: string;
  /** ISO. When they opened it. */
  acquiredAt: string;
  expiresAt: string;
}

/**
 * `POST /api/studio/locks` never refuses — see the header. It reports who holds the lock and whether
 * that is you, and only WRITES when the lock is free, already yours, or `takeOver` was asked for.
 */
interface LockResponse {
  holder: LockHolder | null;
  mine: boolean;
}

export interface PageEditorProps {
  /** "create" has no id, no blocks and no history yet — see `mode` handling throughout. */
  mode: "create" | "edit";
  pageId: string | null;
  initial: PageSettingsValue;
  /** The share image as stored, so the preview can draw it before anything is picked. */
  initialSeoImage: MediaLike | null;
  /** Every block on the page, in order. Empty in create mode. */
  initialSections: BuilderSection[];
  /** True when `isSystem` — the page's route is referenced by the site's own code. */
  isSystem: boolean;
  /** The preview address COMPLETE with its token, built on the server. Null in create mode. */
  previewUrl: string | null;
  /** The site's own origin, no trailing slash. */
  siteOrigin: string;
  /** The site's name, for the share card's domain line and the search result. */
  siteName: string;
  /** `null` while the history has not been read; `[]` when there are no earlier versions. */
  revisions: readonly RevisionSummary[] | null;
  /** The signed-in user, so the client checks the same predicates the handlers do (contract §1.7). */
  user: PermissionSubject;
  /** False when object storage is not configured — the picker then says so instead of failing. */
  storageReady: boolean;
  /** IANA zone name, for every date this screen prints. */
  timeZone: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The plain-language SEO advice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What is missing, as sentences an administrator can act on.
 *
 * NOT A SCORE OUT OF A HUNDRED. A number tells a reader they have failed without telling them at what;
 * every entry here names the thing and says what happens if it is left alone. The list is ordered by how
 * much difference fixing it makes, so the first line is the one worth doing.
 */
function seoAdvice(value: PageSettingsValue, hasImage: boolean): string[] {
  const advice: string[] = [];

  const title = value.seoTitle.trim().length > 0 ? value.seoTitle.trim() : value.title.trim();

  if (value.seoTitle.trim().length === 0) {
    advice.push(
      "No separate search-engine title, so the page's own title is used. That is often right — write one here only if the page title is long or reads oddly out of context."
    );
  }
  if (title.length === 0) {
    advice.push("There is no title at all, so a search result would have nothing to show as its heading.");
  } else if (title.length > SEO_TITLE_IDEAL) {
    advice.push(
      `The title is ${title.length} characters, and search engines cut it at about ${SEO_TITLE_IDEAL}. The preview above shows where it stops — put the important words first.`
    );
  }

  const description = value.seoDescription.trim();
  if (description.length === 0) {
    advice.push(
      "There is no description. Search engines will piece one together from the page, and the sentence they choose is usually a poor advertisement for it."
    );
  } else if (description.length < SEO_DESCRIPTION_MIN_USEFUL) {
    advice.push(
      `The description is ${description.length} characters. Around ${SEO_DESCRIPTION_MIN_USEFUL} to ${SEO_DESCRIPTION_IDEAL} gives room to say what the page is for and why to open it.`
    );
  } else if (description.length > SEO_DESCRIPTION_IDEAL) {
    advice.push(
      `The description is ${description.length} characters and will be cut at about ${SEO_DESCRIPTION_IDEAL}. The preview above shows where.`
    );
  }

  if (!hasImage) {
    advice.push(
      "No sharing picture is set, so a link to this page posted on LinkedIn, WhatsApp or X will appear as plain text. The site's default picture is used where one exists."
    );
  }

  if (value.seoNoIndex) {
    advice.push(
      "This page is set to stay out of search engines. That is a choice, not a fault — but if you meant it to be found, turn “Keep out of search results” off."
    );
  }

  return advice;
}

// ─────────────────────────────────────────────────────────────────────────────
// The two previews
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A search result, drawn as one.
 *
 * The text is cut with `truncateWords`, which stops on a word boundary and appends an ellipsis, so the
 * cut is VISIBLE. A preview that silently showed the whole title would be the one screen in the studio
 * that lies about the thing it exists to show.
 */
function SearchPreview({
  origin,
  path,
  title,
  description
}: {
  origin: string;
  path: string;
  title: string;
  description: string;
}) {
  const shownTitle = title.length > 0 ? truncateWords(title, SEO_TITLE_IDEAL) : "Untitled page";
  const shownDescription =
    description.length > 0
      ? truncateWords(description, SEO_DESCRIPTION_IDEAL)
      : "No description has been written, so a search engine will choose a sentence from the page itself.";

  return (
    <div className="rounded-md border border-line-200 bg-card px-4 py-3.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink-500">
        <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        How it appears in a search result
      </p>

      <div className="mt-3">
        <p className="break-all font-mono text-[0.6875rem] text-ink-500">
          {origin.replace(/^https?:\/\//, "")}
          {path === "/" ? "" : path.replace(/\//g, " › ")}
        </p>
        {/* Purple-700 is the one action colour, so a link in a mock-up is drawn in it rather than in a
            borrowed search-engine blue — which would be a second accent (contract §1.1). */}
        <p className="mt-1 text-lg font-medium leading-snug text-purple-700">{shownTitle}</p>
        <p
          className={cn(
            "mt-1 text-sm leading-relaxed",
            description.length > 0 ? "text-ink-700" : "text-ink-500 italic"
          )}
        >
          {shownDescription}
        </p>
      </div>
    </div>
  );
}

/** The share card, at the shape every social network crops to (1.91:1). */
function SocialPreview({
  origin,
  siteName,
  title,
  description,
  image
}: {
  origin: string;
  siteName: string;
  title: string;
  description: string;
  image: MediaLike | null;
}) {
  return (
    <div className="rounded-md border border-line-200 bg-card px-4 py-3.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink-500">
        <Share2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        How it appears when the link is shared
      </p>

      <div className="mt-3 overflow-hidden rounded-md border border-line-200">
        {image === null ? (
          // Not `MediaImage`'s own "No image" placeholder: the REASON it is empty is what this panel is
          // for, and "most apps will show this link as plain text" is the consequence a reader can act on.
          <div className="flex aspect-[1.91/1] w-full flex-col items-center justify-center gap-2 bg-surface-100 px-4 text-center">
            <ImageIcon aria-hidden="true" className="h-6 w-6 text-ink-300" />
            <p className="text-xs leading-relaxed text-ink-500">
              No picture, so most apps will show this link as plain text.
            </p>
          </div>
        ) : (
          // `alt=""` on purpose: this is a mock-up of somebody else's card, and the title and description
          // beneath it already say what the card contains. Announcing the photograph as well would
          // describe the preview twice.
          <MediaImage
            media={image}
            alt=""
            aspect="1.91 / 1"
            rounded="none"
            targetWidth={1200}
            sizes="(min-width: 1024px) 24rem, 100vw"
          />
        )}

        <div className="bg-surface-50 px-3 py-2.5">
          <p className="truncate text-[0.6875rem] uppercase tracking-wide text-ink-500">
            {origin.replace(/^https?:\/\//, "")}
          </p>
          <p className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-ink-900">
            {title.length > 0 ? title : siteName}
          </p>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500">
            {description.length > 0 ? description : "No description has been written."}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The editor
// ─────────────────────────────────────────────────────────────────────────────

type TabId = "content" | "settings" | "seo" | "history";

export function PageEditor({
  mode,
  pageId,
  initial,
  initialSeoImage,
  initialSections,
  isSystem,
  previewUrl,
  siteOrigin,
  siteName,
  revisions,
  user,
  storageReady,
  timeZone
}: PageEditorProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [value, setValue] = useState<PageSettingsValue>(initial);
  const [seoImage, setSeoImage] = useState<MediaLike | null>(initialSeoImage);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState<TabId>(mode === "create" ? "settings" : "content");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);

  /**
   * Offer to leave a redirect behind when a published address changes.
   *
   * Defaulted ON, because the failure it prevents — every existing link, bookmark and citation to the
   * old address answering "page not found" — is silent and permanent, and the failure it risks (one
   * unnecessary row in the redirects table) is neither.
   */
  const [createRedirect, setCreateRedirect] = useState(true);

  // ── The lock ──────────────────────────────────────────────────────────────

  const [lock, setLock] = useState<LockResponse | null>(null);
  const [lockUnavailable, setLockUnavailable] = useState(false);
  const [takingOver, setTakingOver] = useState(false);

  const claimLock = useCallback(
    async (takeOver: boolean): Promise<LockResponse | null> => {
      if (pageId === null) return null;
      try {
        const answer = await post<LockResponse>("/api/studio/locks", {
          entityType: "Page",
          entityId: pageId,
          takeOver
        });
        setLock(answer);
        setLockUnavailable(false);
        return answer;
      } catch {
        // Advisory by design: a lock service that is not there must not stop anybody editing. The note
        // is shown once and the screen carries on.
        setLockUnavailable(true);
        return null;
      }
    },
    [pageId]
  );

  useEffect(() => {
    if (mode !== "edit" || pageId === null) return;

    void claimLock(false);

    // The heartbeat runs whoever holds it: if somebody else does, this is also how the screen finds out
    // that they have finished and the lock has expired.
    const timer = window.setInterval(() => {
      void claimLock(false);
    }, LOCK_HEARTBEAT_MS);

    return () => {
      window.clearInterval(timer);
      // Best effort, deliberately not awaited: the component is going and the lock has a hard expiry
      // anyway, so a failure here costs a few minutes of a stale "somebody else is editing this".
      void del<void>(
        `/api/studio/locks${buildQuery({ entityType: "Page", entityId: pageId })}`
      ).catch(() => undefined);
    };
  }, [claimLock, mode, pageId]);

  const takeOver = useCallback(async () => {
    setTakingOver(true);
    const answer = await claimLock(true);
    setTakingOver(false);
    if (answer?.mine) {
      toast({
        tone: "success",
        title: "You now have this page open",
        description:
          "The person who had it has not been signed out — their unsaved changes are still on their screen, and whoever saves last wins. This has been written to the audit log."
      });
    }
  }, [claimLock, toast]);

  // ── Saving ────────────────────────────────────────────────────────────────

  /**
   * Whether this page is in front of the public.
   *
   * SCHEDULED counts, conservatively: a scheduled page whose date has passed IS live (lib/content.ts
   * resolves publication at read time), and the safe direction for a screen deciding whether to autosave
   * is to assume it is.
   */
  const isPublic = value.status === "PUBLISHED" || value.status === "SCHEDULED";

  const savePayload = useMemo(
    () => ({
      ...value,
      // Only meaningful when the address actually changed; the handler ignores it otherwise. Sent
      // always so the handler never has to guess what the reader chose.
      createRedirect
    }),
    [value, createRedirect]
  );

  const save = useCallback(
    async (payload: PageSettingsValue & { createRedirect: boolean }): Promise<void> => {
      setFieldErrors(null);
      try {
        if (mode === "create") {
          const created = await post<PageResponse>("/api/studio/pages", payload);
          // A created page has blocks to add, so the reader lands on the builder rather than back on
          // the form they have just finished.
          router.push(`/studio/pages/${encodeURIComponent(created.page.id)}`);
          return;
        }
        if (pageId === null) return;
        await patch<PageResponse>(`/api/studio/pages/${encodeURIComponent(pageId)}`, payload);
      } catch (thrown) {
        const failure = asApiClientError(thrown);
        setFieldErrors(failure.fieldErrors ?? null);
        throw failure;
      }
    },
    [mode, pageId, router]
  );

  /**
   * The public address, handed over the moment this page crosses onto the site.
   *
   * `basePath` is "/" because a `Page`'s slug IS its whole path — "research/roadmap" is a page two
   * levels down, not a slug inside a section — which is also why `SlugField` below is given
   * `allowSlashes`. The homepage's slug is empty, and `usePublishNotice` resolves that to the origin.
   */
  const announcePublished = usePublishNotice({
    initial,
    origin: siteOrigin,
    basePath: "/",
    subject: "page"
  });

  const autosave = useAutosave<PageSettingsValue & { createRedirect: boolean }>({
    data: savePayload,
    save,
    // A new page has nothing to PATCH, so the timer stands down and Save is the only way to create it.
    enabled: mode === "edit",
    isPublished: isPublic,
    // The snapshot that was SENT, so the address in the notice is the one the server has just stored —
    // not an address the reader carried on editing while the request was in flight.
    onSaved: (sent) => announcePublished(sent)
  });

  /**
   * Pulled out so the restore callback can depend on the FUNCTION rather than on the whole hook result.
   * `markSaved` is stable for the life of the hook; the result object is a new one every render, so
   * depending on it would give `restore` a new identity on every keystroke.
   */
  const { markSaved } = autosave;

  useLeaveGuard(autosave.isDirty);

  const discard = useCallback(() => {
    setValue(initial);
    setSeoImage(initialSeoImage);
    setFieldErrors(null);
  }, [initial, initialSeoImage]);

  // ── Validation that refuses a save, and validation that only refuses publishing ──

  const titleMissing = value.title.trim().length === 0;
  /** An empty address is legal for exactly one page: the existing homepage. */
  const homepageBeingEdited = mode === "edit" && initial.slug.length === 0;
  const addressMissing = value.slug.trim().length === 0 && !homepageBeingEdited;

  const scheduleProblems = statusProblems(
    {
      status: value.status,
      publishedAt: value.publishedAt,
      publishAt: value.publishAt,
      unpublishAt: value.unpublishAt
    },
    // `Page` carries publishAt/unpublishAt, so scheduling is real here.
    true
  );

  const saveDisabledReason = titleMissing
    ? "The page has no title, and a page without one cannot be found in any list."
    : addressMissing
      ? "The page has no address. Only the site's homepage may have an empty one."
      : (scheduleProblems[0] ?? null);

  /** Reasons this page must not go public yet. SEO advice is NOT one of them — see the SEO panel. */
  const publishBlockers = titleMissing
    ? ["The page has no title."]
    : [];

  // ── SEO derivations ───────────────────────────────────────────────────────

  const effectiveTitle = value.seoTitle.trim().length > 0 ? value.seoTitle.trim() : value.title.trim();
  const advice = seoAdvice(value, seoImage !== null);
  const path = value.slug.trim().length === 0 ? "/" : `/${value.slug.trim()}`;

  // ── History ───────────────────────────────────────────────────────────────

  /**
   * Fetch one stored snapshot.
   *
   * Tolerant of two shapes on purpose: a handler that answers with the snapshot itself and one that
   * wraps it as `{ data: … }` are both reasonable readings of "give me revision 7", and guessing wrong
   * would make the whole history panel say "this version could not be found".
   */
  const loadRevision = useCallback(
    async (version: number): Promise<RevisionData | null> => {
      if (pageId === null) return null;
      const payload = await get<unknown>(
        `/api/studio/pages/${encodeURIComponent(pageId)}/revisions/${version}`
      );
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
      const record = payload as Record<string, unknown>;
      const wrapped = record.data;
      if (wrapped !== null && typeof wrapped === "object" && !Array.isArray(wrapped)) {
        return wrapped as RevisionData;
      }
      return record as RevisionData;
    },
    [pageId]
  );

  const restore = useCallback(
    async (version: number): Promise<void> => {
      if (pageId === null) return;
      await post<unknown>(
        `/api/studio/pages/${encodeURIComponent(pageId)}/revisions/${version}/restore`
      );

      // Re-read the row rather than trusting the restore's answer to carry every column. The form is
      // then showing what the database holds, and `markSaved` moves the autosave baseline with it so
      // the bar does not claim there are unsaved changes to something that has just been written.
      try {
        const fresh = await get<PageResponse>(`/api/studio/pages/${encodeURIComponent(pageId)}`);
        setValue((current) => ({ ...current, ...fresh.page }));
        markSaved();
      } catch {
        // The restore itself succeeded; only the re-read failed. Refreshing the route is the honest
        // fallback, and it is what puts the new version at the top of the history list either way.
      }
      router.refresh();
    },
    [markSaved, pageId, router]
  );

  /** The record as it stands, for the history panel to compare a version against. */
  const currentRecord = useMemo<RevisionData>(
    () => ({ ...value, seoImageId: value.seoImageId }),
    [value]
  );

  // ── Panels ────────────────────────────────────────────────────────────────

  const mayPublish = canPublishPredicate(user);

  const tabs: TabItem[] = [
    // No `content` on any item: this component renders the panels itself so the builder is never
    // unmounted. See the header.
    // No count on the Content tab: the builder adds and removes blocks without telling this component,
    // so a number here would be the count as the screen opened and would then be quietly wrong.
    ...(mode === "edit" ? [{ id: "content", label: "Content", icon: LayoutList }] : []),
    { id: "settings", label: "Settings", icon: Settings },
    { id: "seo", label: "Search and sharing", icon: Search },
    ...(mode === "edit" ? [{ id: "history", label: "History", icon: History }] : [])
  ];

  const settingsPanel = (
    <div className="space-y-5">
      <FormSection
        title="What this page is called and where it lives"
        description="The title is what appears at the top of the page, in menus and in every list in the studio. The address is what a reader sees in their browser."
      >
        <Field
          label="Title"
          required
          maxLength={TITLE_MAX}
          value={value.title}
          error={fieldErrors?.title?.[0] ?? null}
          help="Write it as you would say it — sentence case, no full stop."
        >
          <Input
            value={value.title}
            onChange={(event) => setValue((current) => ({ ...current, title: event.target.value }))}
            placeholder="About the Centre"
          />
        </Field>

        <SlugField
          value={value.slug}
          onChange={(next) => setValue((current) => ({ ...current, slug: next }))}
          source={value.title}
          basePath="/"
          siteUrl={siteOrigin}
          originalValue={mode === "edit" ? initial.slug : undefined}
          isPublished={isPublic}
          // Only offered when there is an old address to redirect FROM.
          redirect={
            mode === "edit" && initial.slug.length > 0
              ? { enabled: createRedirect, onEnabledChange: setCreateRedirect }
              : undefined
          }
          allowSlashes
          // The homepage is the page whose address is empty. A new page may not claim it by accident,
          // but the existing homepage must be able to keep it.
          allowEmpty={homepageBeingEdited}
          required={!homepageBeingEdited}
          error={fieldErrors?.slug?.[0] ?? null}
        />

        <Field
          label="Menu label"
          maxLength={NAV_LABEL_MAX}
          value={value.navLabel}
          help="A shorter name for menus and breadcrumbs, where the full title will not fit. Leave it empty to use the title."
        >
          <Input
            value={value.navLabel}
            onChange={(event) => setValue((current) => ({ ...current, navLabel: event.target.value }))}
            placeholder={value.title.length > 0 ? value.title : "About"}
          />
        </Field>

        {isSystem ? (
          <HelpText tone="warn">
            This page is built in: the site&rsquo;s own code and menus point at{" "}
            <span className="font-semibold">{`/${initial.slug}`}</span>. It can be edited and its
            address can be changed, but it cannot be deleted, and changing the address without leaving a
            redirect behind will break links the site renders itself.
          </HelpText>
        ) : null}
      </FormSection>

      {/*
        The publish control is rendered ONLY for somebody who may use it, and `StatusControl` makes the
        finer decision inside — a reader without publishing rights sees Draft and In review, and nothing
        at all once the page is already public (contract §1.8).
      */}
      <FormSection
        title="Publishing"
        description="Whether readers outside the studio can reach this page, and when."
      >
        <StatusControl
          value={{
            status: value.status,
            publishedAt: value.publishedAt,
            publishAt: value.publishAt,
            unpublishAt: value.unpublishAt
          }}
          onChange={(next: StatusControlValue) =>
            setValue((current) => ({
              ...current,
              status: next.status,
              publishAt: next.publishAt ?? null,
              unpublishAt: next.unpublishAt ?? null
            }))
          }
          canPublish={mayPublish}
          scheduling
          publishBlockers={publishBlockers}
        />

        {previewUrl !== null ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-line-200 bg-surface-50 px-4 py-3">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-500">
              A preview link shows this page as it stands, published or not. Anyone with the link can see
              it, so treat it as you would the page itself.
            </p>
            {/*
              `data-allow-unsaved` opts this link out of the unsaved-changes guard: it opens in a new
              tab, so it does not take the reader — or their typing — off this screen.
            */}
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              data-allow-unsaved=""
              className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-line-200 bg-card px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:border-purple-300 hover:text-purple-700"
            >
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              Open the preview
            </a>
          </div>
        ) : null}
      </FormSection>

      <FormSection
        title="Order in lists"
        description="Where this page sits when several are listed together, such as in a menu built from pages. Lower numbers come first."
      >
        <Field label="Sort order" htmlFor="page-sort-order">
          <Input
            id="page-sort-order"
            type="number"
            inputMode="numeric"
            value={String(value.sortOrder)}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              setValue((current) => ({
                ...current,
                // An empty box is 0, not NaN: NaN would be sent as null and the row's order would
                // silently change to whatever the column default is.
                sortOrder: Number.isFinite(next) ? next : 0
              }));
            }}
            className="max-w-[8rem]"
          />
        </Field>
      </FormSection>
    </div>
  );

  const seoPanel = (
    <div className="space-y-5">
      <FormSection
        title="How this page appears elsewhere"
        description="Two things read these fields: a search engine listing the page, and an app drawing a card when somebody shares the link. Both are shown as you type."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <SearchPreview
            origin={siteOrigin}
            path={path}
            title={effectiveTitle}
            description={value.seoDescription.trim()}
          />
          <SocialPreview
            origin={siteOrigin}
            siteName={siteName}
            title={effectiveTitle}
            description={value.seoDescription.trim()}
            image={seoImage}
          />
        </div>

        {/*
          The advice list. `role="status"` is deliberately NOT used: it changes on every keystroke, and a
          region re-announced on each character talks over the typing it is describing. A reader moving
          through the form reaches it in order.
        */}
        <div
          className={cn(
            "rounded-md px-4 py-3.5",
            // The width and the colour travel together in each branch. A lone `border` is preflight's
            // literal gray-200, which does not invert (contract §3).
            advice.length === 0
              ? "border border-success-600/25 bg-success-100"
              : "border border-line-200 bg-surface-50"
          )}
        >
          {advice.length === 0 ? (
            <p className="flex items-start gap-2 text-sm leading-relaxed text-success-600">
              <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Nothing is missing. The title fits, the description fits, and there is a picture for
                shared links.
              </span>
            </p>
          ) : (
            <>
              <p className="flex items-start gap-2 text-sm font-medium leading-relaxed text-ink-900">
                <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
                <span>
                  {advice.length === 1
                    ? "One thing would improve how this page is found and shared:"
                    : `${advice.length} things would improve how this page is found and shared:`}
                </span>
              </p>
              <ul className="ml-6 mt-2 list-disc space-y-1.5 text-sm leading-relaxed text-ink-700">
                {advice.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
        </div>

        <Field
          label="Search-engine title"
          maxLength={SEO_TITLE_MAX}
          value={value.seoTitle}
          help={`Leave it empty to use the page's own title. About ${SEO_TITLE_IDEAL} characters is as much as a search result shows.`}
        >
          <Input
            value={value.seoTitle}
            onChange={(event) => setValue((current) => ({ ...current, seoTitle: event.target.value }))}
            placeholder={value.title.length > 0 ? value.title : "About the Centre"}
          />
        </Field>

        <Field
          label="Search-engine description"
          maxLength={SEO_DESCRIPTION_MAX}
          value={value.seoDescription}
          help={`One or two sentences saying what is on the page and why to open it. About ${SEO_DESCRIPTION_IDEAL} characters is shown.`}
        >
          <Textarea
            value={value.seoDescription}
            rows={3}
            onChange={(event) =>
              setValue((current) => ({ ...current, seoDescription: event.target.value }))
            }
          />
        </Field>

        <FieldBlock
          label="Picture for shared links"
          help="Used when the link is posted somewhere that draws a card. A wide photograph works best — anything roughly twice as wide as it is tall."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" icon={ImageIcon} onClick={() => setPickerOpen(true)}>
              {seoImage === null ? "Choose a picture" : "Change the picture"}
            </Button>
            {seoImage !== null ? (
              <Button
                variant="ghost"
                size="sm"
                icon={X}
                onClick={() => {
                  setSeoImage(null);
                  setValue((current) => ({ ...current, seoImageId: null }));
                }}
              >
                Take it off
              </Button>
            ) : null}
          </div>
        </FieldBlock>

        <Switch
          checked={value.seoNoIndex}
          onCheckedChange={(checked) =>
            setValue((current) => ({ ...current, seoNoIndex: checked }))
          }
          label="Keep this page out of search results"
          description="Search engines are asked not to list it. The page stays reachable to anybody with the address — this is not a way of keeping it private."
        />

        <Field
          label="Canonical address"
          help="Only for a page whose content genuinely lives at another address. Leave it empty and the page's own address is used, which is what nearly every page wants."
        >
          <Input
            value={value.canonicalUrl}
            onChange={(event) =>
              setValue((current) => ({ ...current, canonicalUrl: event.target.value }))
            }
            placeholder="https://example.ac.in/the-original-page"
            inputMode="url"
            className="font-mono text-xs"
          />
        </Field>
      </FormSection>
    </div>
  );

  const historyPanel = (
    <FormSection
      title="Every saved version of this page"
      description="Each save keeps a copy. Open one to see what restoring it would change, and restore it if that is what you want — what is on screen now is kept as a version too."
    >
      <HelpText>
        This history covers the page&rsquo;s own details: its title, address, menu label and
        search-engine settings. The blocks on the page keep their own history, one per block.
      </HelpText>

      <RevisionHistory
        revisions={revisions}
        loadRevision={loadRevision}
        current={currentRecord}
        onRestore={restore}
        // Restoring is stricter than editing (lib/permissions.ts), and this is the same predicate the
        // restore handler enforces.
        canRestore={mayPublish}
        subject="this page"
        timeZone={timeZone}
        headingLevel={3}
        fieldLabels={{
          slug: "Address",
          navLabel: "Menu label",
          seoTitle: "Search-engine title",
          seoDescription: "Search-engine description",
          seoImageId: "Picture for shared links",
          seoNoIndex: "Kept out of search results",
          canonicalUrl: "Canonical address",
          sortOrder: "Order in lists",
          publishAt: "Goes public on",
          unpublishAt: "Comes off the site on"
        }}
      />
    </FormSection>
  );

  return (
    <div>
      {/* ── The lock notice ─────────────────────────────────────────────── */}
      {lock !== null && !lock.mine && lock.holder !== null ? (
        <LockNotice
          holder={lock.holder}
          timeZone={timeZone}
          busy={takingOver}
          onTakeOver={() => void takeOver()}
        />
      ) : null}

      {lockUnavailable ? (
        <HelpText className="mb-4">
          The studio could not check whether anybody else has this page open. You can carry on editing —
          if two people save, the later save wins.
        </HelpText>
      ) : null}

      <Tabs
        items={tabs}
        value={tab}
        onChange={(id) => setTab(id as TabId)}
        label="Parts of this page"
      />

      {/* ── The panels ──────────────────────────────────────────────────── */}

      {mode === "edit" && pageId !== null && previewUrl !== null ? (
        // Always mounted, hidden when another tab is chosen. `hidden` takes it out of the layout AND
        // out of the accessibility tree, so nothing here is reachable while it is not the chosen tab.
        <section
          aria-label="Blocks on this page"
          hidden={tab !== "content"}
          className="pt-5"
        >
          <PageBuilder
            pageId={pageId}
            pageTitle={value.title}
            isPublished={isPublic}
            initialSections={initialSections}
            previewUrl={previewUrl}
            user={user}
          />
        </section>
      ) : null}

      {tab === "settings" ? (
        <section aria-label="Page settings" className="pt-5">
          {settingsPanel}
        </section>
      ) : null}

      {tab === "seo" ? (
        <section aria-label="Search and sharing" className="pt-5">
          {seoPanel}
        </section>
      ) : null}

      {tab === "history" ? (
        <section aria-label="Version history" className="pt-5">
          {historyPanel}
        </section>
      ) : null}

      {/*
        One save bar, and only on the tabs it belongs to. The builder brings its own for the blocks; the
        Content panel is hidden whenever this one is on screen, so the two are never both in the layout.
      */}
      {tab === "settings" || tab === "seo" ? (
        <SaveBar
          status={autosave.status}
          lastSavedAt={autosave.lastSavedAt}
          onSave={() => void autosave.saveNow()}
          onDiscard={discard}
          error={autosave.error?.message ?? null}
          saveDisabledReason={saveDisabledReason}
          saveLabel={mode === "create" ? "Create this page" : "Save"}
          subject="this page"
          note={
            mode === "create"
              ? "Nothing is saved until you choose Create. The blocks that go on the page are added afterwards."
              : autosave.retriesExhausted
                ? /*
                    AUTOMATIC SAVING HAS GIVEN UP, and it must say so in the error tone rather than the
                    note's usual grey. `useAutosave` stops retrying after three consecutive failures (its
                    rule 4) and exposes `retriesExhausted` for exactly this sentence. Without the branch
                    the bar goes on claiming these details are "saved on their own a few seconds after you
                    stop typing", which is now false — so an editor keeps typing into a form nothing is
                    storing and then closes the tab. The failure itself is printed above this line,
                    verbatim from the server; this line is the consequence and what to do about it.
                  */
                  <span className="font-medium text-error-600">
                    Not saving. Your last change was not stored. Press Save to try again.
                  </span>
                : isPublic
                  ? PUBLISHED_AUTOSAVE_NOTICE
                  : "This page is not published yet, so these details are saved on their own a few seconds after you stop typing."
          }
        />
      ) : null}

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(assets: StudioMediaAsset[]) => {
          const chosen = assets[0];
          if (!chosen) return;
          setSeoImage(chosen);
          setValue((current) => ({ ...current, seoImageId: chosen.id }));
          setPickerOpen(false);
        }}
        kind="IMAGE"
        storageReady={storageReady}
        title="Choose a picture for shared links"
      />
    </div>
  );
}

/**
 * "Somebody else has this open."
 *
 * NAMES THEM AND SAYS SINCE WHEN, because "this record is locked" is a dead end: the reader cannot tell
 * whether to wait five minutes or five days, and cannot go and ask a person whose name they were not
 * given. The date is formatted in the named zone, and the zone is printed — a bare "09:14" between two
 * colleagues in different cities is a time they will disagree about.
 *
 * It is `role="status"`, not `role="alert"`: nothing has gone wrong and nothing has been refused, so
 * interrupting the reader would be out of proportion to the news.
 */
function LockNotice({
  holder,
  timeZone,
  busy,
  onTakeOver
}: {
  holder: LockHolder;
  timeZone: string;
  busy: boolean;
  onTakeOver: () => void;
}): ReactNode {
  const opened = new Date(holder.acquiredAt);
  const when = Number.isNaN(opened.getTime())
    ? "an unknown time"
    : opened.toLocaleString("en-GB", {
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone
      });

  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 rounded-md border border-amber-800/25 bg-amber-100 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-start gap-2 text-sm font-medium leading-relaxed text-amber-800">
          <UserRoundCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {holder.userName} has had this page open since {when} ({timeZone}).
          </span>
        </p>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          You can still edit it. If you both save, the later save wins and the earlier one is kept in the
          history. Ask {holder.userName} first where you can — {holder.userEmail}.
        </p>
      </div>

      {/* Taking over is RECORDED by the handler rather than refused, and the toast afterwards says so. */}
      <Button variant="secondary" size="sm" isLoading={busy} loadingLabel="taking over" onClick={onTakeOver}>
        Take over anyway
      </Button>
    </div>
  );
}
