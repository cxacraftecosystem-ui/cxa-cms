"use client";

/**
 * ArticleEditor — writing a news article.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * 1. `body` AND `mdx` ARE MUTUALLY EXCLUSIVE, AND THIS SCREEN NEVER RESOLVES THAT SILENTLY.
 *
 * `Post.body` is a Tiptap document and `Post.mdx` is source text for a long-form piece that needs
 * components. The schema says one per article; nothing in the database enforces it. So:
 *
 *   • the editor works out which mode the article is in and SAYS SO in words above the writing area;
 *   • switching mode asks first, and the question names exactly what will be cleared — not "are you
 *     sure", which asks a reader to weigh something without telling them what is on the scales;
 *   • an article that somehow has BOTH is not quietly fixed. The screen refuses to save, says both are
 *     stored, and makes the author choose which one is the article. Guessing here would publish one
 *     version and destroy the other with nothing on screen to say which.
 *
 * 2. THE READING TIME IS WORKED OUT FROM WHAT IS ACTUALLY WRITTEN, AND SHOWN.
 *
 * `Post.readingMinutes` is stored, but it is stored as a CONSEQUENCE of this number rather than as an
 * independent fact — the figure on screen is recomputed from the body on every keystroke and the same
 * figure is what the save sends. An author who has written a fourteen-minute piece should find that out
 * here, not from a reader.
 *
 * 3. WHO MAY CHANGE THE AUTHOR IS A PERMISSION, SO IT IS EITHER A CONTROL OR A SENTENCE.
 *
 * `canEditOthersContent` (EDITOR) is what reassigning an article needs. Without it the author is printed
 * as text — never a disabled dropdown, which invites every tier to press it (contract §1.8).
 *
 * 4. A PUBLISHED ARTICLE IS NOT AUTOSAVED. `useAutosave` explains why at length: autosaving live content
 * puts a half-written sentence on the public site four seconds after somebody starts it. The bar carries
 * `PUBLISHED_AUTOSAVE_NOTICE` so the behaviour is stated rather than discovered.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  CircleCheck,
  Clock,
  FileCode2,
  Image as ImageIcon,
  Plus,
  Sparkles,
  TriangleAlert,
  Type,
  X,
  type LucideIcon
} from "lucide-react";
import type { ContentStatus } from "@prisma/client";

import { asApiClientError, patch, post } from "@/lib/client/fetcher";
import type { MediaLike } from "@/lib/media/url";
import { canEditOthersContent, canPublish as canPublishPredicate, type PermissionSubject } from "@/lib/permissions";
import {
  isEmptyRichText,
  parseRichText,
  richTextExcerpt,
  richTextToPlainText,
  type RichTextDoc
} from "@/lib/richtext";
import { cn, readingMinutes as computeReadingMinutes, truncateWords } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { Field, FieldBlock } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { MediaImage } from "@/components/ui/MediaImage";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { SaveBar } from "@/components/studio/SaveBar";
import { SlugField } from "@/components/studio/SlugField";
import { StatusControl, statusProblems, type StatusControlValue } from "@/components/studio/StatusControl";
import { PUBLISHED_AUTOSAVE_NOTICE, useAutosave } from "@/components/studio/useAutosave";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
import { EntityPicker } from "@/components/studio/fields/EntityPicker";
import { RichTextEditor } from "@/components/studio/editor/RichTextEditor";
import type { EditorMediaSelection } from "@/components/studio/editor/extensions";
import { MediaPicker } from "@/components/studio/media/MediaPicker";
import type { StudioMediaAsset } from "@/components/studio/media/MediaGrid";

// ─────────────────────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────────────────────

const TITLE_MAX = 200;
const SUBTITLE_MAX = 240;
const EXCERPT_MAX = 320;
/** What an excerpt is trimmed to when it is taken from the body. Comfortably inside `EXCERPT_MAX`. */
const EXCERPT_SUGGESTION_CHARS = 240;

const SEO_TITLE_IDEAL = 60;
const SEO_TITLE_MAX = 90;
const SEO_DESCRIPTION_MIN_USEFUL = 70;
const SEO_DESCRIPTION_IDEAL = 155;
const SEO_DESCRIPTION_MAX = 220;

/** Explicit editorial "read next" picks. More than this and the strip under an article stops being a pick. */
const RELATED_MAX = 6;

/** A tag list longer than this is a filing system nobody maintains. Stated on screen. */
const TAG_MAX = 12;

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export type WritingMode = "formatted" | "mdx";

/** The article as the form holds it, and as it crosses the wire on a save. */
export interface ArticleValue {
  title: string;
  slug: string;
  subtitle: string;
  excerpt: string;
  /** A Tiptap document, or null when the article is written in MDX. */
  body: unknown;
  /** MDX source, or `""` when the article uses the formatted editor. */
  mdx: string;
  coverId: string | null;
  authorId: string | null;
  categoryId: string | null;
  /** Tag NAMES, not ids — see the note on the tag field. */
  tags: string[];
  relatedIds: string[];
  isFeatured: boolean;
  status: ContentStatus;
  publishedAt: string | null;
  publishAt: string | null;
  unpublishAt: string | null;
  seoTitle: string;
  seoDescription: string;
  seoNoIndex: boolean;
  /** Recomputed on every edit and sent with the save. Never typed by hand. */
  readingMinutes: number;
}

interface ArticleResponse {
  post: { id: string };
}

export interface ArticleEditorProps {
  mode: "create" | "edit";
  postId: string | null;
  initial: ArticleValue;
  initialCover: MediaLike | null;
  /** Every category, for the filing dropdown. */
  categories: readonly { id: string; name: string }[];
  /** Existing tag names, offered as suggestions while typing. Capped; the cap is stated. */
  tagSuggestions: readonly string[];
  tagSuggestionsTruncated: boolean;
  /** Everybody who could be named as the author. Only rendered as a control for an editor. */
  authors: readonly { id: string; name: string }[];
  /** The author's own name, for the read-only case. */
  authorName: string | null;
  user: PermissionSubject;
  storageReady: boolean;
  siteOrigin: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading time and the SEO advice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The article's prose, whichever mode it is in.
 *
 * MDX is stripped rather than parsed: fenced code, JSX tags and import lines are not prose, and counting
 * them makes a short article with a long code sample read as a twenty-minute one. It is an approximation
 * and it is honest about being one — the alternative is an MDX compiler in the browser.
 */
function articleText(mode: WritingMode, body: unknown, mdx: string): string {
  if (mode === "mdx") {
    return mdx
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^import .*$/gm, " ")
      .replace(/^export .*$/gm, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/[#>*_`|-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return richTextToPlainText(parseRichText(body));
}

function wordCount(text: string): number {
  if (text.trim().length === 0) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** What is missing, in words an author can act on. See the page editor for why this is not a score. */
function seoAdvice(value: ArticleValue, hasCover: boolean): string[] {
  const advice: string[] = [];
  const title = value.seoTitle.trim().length > 0 ? value.seoTitle.trim() : value.title.trim();

  if (title.length === 0) {
    advice.push("There is no headline, so a search result would have nothing to show as its heading.");
  } else if (title.length > SEO_TITLE_IDEAL) {
    advice.push(
      `The headline shown in search results is ${title.length} characters, and about ${SEO_TITLE_IDEAL} is all that appears. Write a shorter one in “Search-engine headline” if the important words come late.`
    );
  }

  const description =
    value.seoDescription.trim().length > 0 ? value.seoDescription.trim() : value.excerpt.trim();
  if (description.length === 0) {
    advice.push(
      "There is no standfirst and no search-engine description, so search engines and social apps will piece a sentence together from the article — usually a poor one."
    );
  } else if (description.length < SEO_DESCRIPTION_MIN_USEFUL) {
    advice.push(
      `The description is ${description.length} characters. Around ${SEO_DESCRIPTION_MIN_USEFUL} to ${SEO_DESCRIPTION_IDEAL} gives room to say what the article is about.`
    );
  } else if (description.length > SEO_DESCRIPTION_IDEAL) {
    advice.push(
      `The description is ${description.length} characters and will be cut at about ${SEO_DESCRIPTION_IDEAL}.`
    );
  }

  if (!hasCover) {
    advice.push(
      "There is no cover photograph, so this article will appear without a picture in the newsroom, on the homepage and wherever the link is shared."
    );
  }

  if (value.seoNoIndex) {
    advice.push(
      "This article is set to stay out of search results. That is a choice, not a fault — but nobody will find it by searching."
    );
  }

  return advice;
}

// ─────────────────────────────────────────────────────────────────────────────
// The editor
// ─────────────────────────────────────────────────────────────────────────────

export function ArticleEditor({
  mode,
  postId,
  initial,
  initialCover,
  categories,
  tagSuggestions,
  tagSuggestionsTruncated,
  authors,
  authorName,
  user,
  storageReady,
  siteOrigin
}: ArticleEditorProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [value, setValue] = useState<ArticleValue>(initial);
  const [cover, setCover] = useState<MediaLike | null>(initialCover);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);
  const [tagDraft, setTagDraft] = useState("");

  /**
   * Which mode the article is in, seeded from the data.
   *
   * `mdx` wins the seed when both are somehow present, because the "both are stored" banner is shown
   * either way and MDX is the harder one to reconstruct if the wrong one were cleared.
   *
   * Memoised on `initial` alone: parsing the stored document walks every node in it, and doing that in
   * the render body would re-walk a long article on every keystroke of the headline.
   */
  const bothStored = useMemo(
    () => initial.mdx.trim().length > 0 && !isEmptyRichText(parseRichText(initial.body)),
    [initial]
  );
  const [writingMode, setWritingMode] = useState<WritingMode>(
    initial.mdx.trim().length > 0 ? "mdx" : "formatted"
  );
  /** Cleared once the author has chosen which of the two stored bodies is the article. */
  const [conflict, setConflict] = useState(bothStored);

  // ── The media picker, as a promise ────────────────────────────────────────
  //
  // `RichTextEditor` asks for a picture through a callback rather than owning the picker, so that the two
  // files do not depend on each other. Bridging the dialog to that promise needs a resolver held across
  // renders — a ref, because resolving is not a render.

  const [pickerTarget, setPickerTarget] = useState<"cover" | "body" | null>(null);
  const mediaResolver = useRef<((chosen: EditorMediaSelection | null) => void) | null>(null);

  const requestBodyMedia = useCallback(
    () =>
      new Promise<EditorMediaSelection | null>((resolve) => {
        mediaResolver.current = resolve;
        setPickerTarget("body");
      }),
    []
  );

  const closePicker = useCallback(() => {
    // Resolving with null is "the author changed their mind", which is not a failure and gets no message.
    // Leaving the promise unsettled would freeze the insert handler for the life of the page.
    mediaResolver.current?.(null);
    mediaResolver.current = null;
    setPickerTarget(null);
  }, []);

  // ── Reading time ─────────────────────────────────────────────────────────

  const plainText = useMemo(
    () => articleText(writingMode, value.body, value.mdx),
    [writingMode, value.body, value.mdx]
  );
  const words = wordCount(plainText);
  // `readingMinutes` floors at 1, so an empty article would claim "1 minute". Zero words is stated as
  // nothing written rather than as a one-minute read.
  const minutes = words === 0 ? 0 : computeReadingMinutes(plainText);

  /**
   * The figure the save sends, kept in step with the figure on screen.
   *
   * Derived rather than stored in `value`: two pieces of state that both claim to know the reading time
   * will eventually disagree, and the one that is wrong is always the one in the database.
   */
  const payload = useMemo(
    () => ({
      ...value,
      readingMinutes: minutes,
      // The mode decides which field is sent as content and which is sent as empty. Both are always
      // present in the body, so the handler never has to infer intent from an absent key.
      body: writingMode === "formatted" ? value.body : null,
      mdx: writingMode === "mdx" ? value.mdx : ""
    }),
    [value, minutes, writingMode]
  );

  // ── Saving ───────────────────────────────────────────────────────────────

  const isPublic = value.status === "PUBLISHED" || value.status === "SCHEDULED";

  const save = useCallback(
    async (data: ArticleValue): Promise<void> => {
      setFieldErrors(null);
      try {
        if (mode === "create") {
          const created = await post<ArticleResponse>("/api/studio/news", data);
          router.push(`/studio/news/${encodeURIComponent(created.post.id)}`);
          return;
        }
        if (postId === null) return;
        await patch<ArticleResponse>(`/api/studio/news/${encodeURIComponent(postId)}`, data);
      } catch (thrown) {
        const failure = asApiClientError(thrown);
        setFieldErrors(failure.fieldErrors ?? null);
        throw failure;
      }
    },
    [mode, postId, router]
  );

  const autosave = useAutosave<ArticleValue>({
    data: payload,
    save,
    enabled: mode === "edit",
    isPublished: isPublic
  });

  useLeaveGuard(autosave.isDirty);

  const discard = useCallback(() => {
    setValue(initial);
    setCover(initialCover);
    setWritingMode(initial.mdx.trim().length > 0 ? "mdx" : "formatted");
    setConflict(bothStored);
    setFieldErrors(null);
  }, [bothStored, initial, initialCover]);

  // ── Switching writing mode ───────────────────────────────────────────────

  const switchMode = useCallback(
    async (next: WritingMode) => {
      if (next === writingMode) return;

      const losingFormatted = next === "mdx" && !isEmptyRichText(parseRichText(value.body));
      const losingMdx = next === "formatted" && value.mdx.trim().length > 0;

      if (losingFormatted || losingMdx) {
        const agreed = await confirm({
          title: next === "mdx" ? "Write this article in MDX instead?" : "Use the formatted editor instead?",
          body: (
            <>
              <p>
                An article can have one body or the other, never both. Switching{" "}
                {losingFormatted
                  ? "clears everything written in the formatted editor"
                  : "clears the MDX source"}
                , and that happens the moment you agree — not when you next save.
              </p>
              <p className="mt-2">
                Every earlier save is kept in this article&rsquo;s history, so the version you have now can
                be got back from there. If you want to keep the wording, copy it out before agreeing.
              </p>
            </>
          ),
          confirmLabel: next === "mdx" ? "Switch to MDX and clear the body" : "Switch and clear the MDX",
          cancelLabel: "Keep editing",
          tone: "danger"
        });
        if (!agreed) return;
      }

      // Cleared immediately, so what is on screen is what would be saved. Deferring it to the save would
      // leave the form claiming to hold something the save is about to throw away.
      setValue((current) =>
        next === "mdx" ? { ...current, body: null } : { ...current, mdx: "" }
      );
      setWritingMode(next);
      setConflict(false);
    },
    [confirm, value.body, value.mdx, writingMode]
  );

  /** Resolving the "both are stored" case: keep one, clear the other, say which. */
  const resolveConflict = useCallback(
    (keep: WritingMode) => {
      setValue((current) =>
        keep === "mdx" ? { ...current, body: null } : { ...current, mdx: "" }
      );
      setWritingMode(keep);
      setConflict(false);
      toast({
        tone: "success",
        title: keep === "mdx" ? "The MDX source is now the article" : "The formatted body is now the article",
        description:
          "The other one is cleared on screen and will be cleared in the database on the next save. The version history still holds it."
      });
    },
    [toast]
  );

  // ── Tags ─────────────────────────────────────────────────────────────────
  //
  // Tag NAMES cross the wire rather than ids, so an author can file an article under a tag that does not
  // exist yet without leaving this screen. The handler matches on the slug and creates what is missing;
  // the Taxonomy screen is where tags are renamed, merged and removed.

  const addTag = useCallback(
    (raw: string) => {
      const name = raw.trim().replace(/\s+/g, " ");
      if (name.length === 0) return;
      setTagDraft("");
      setValue((current) => {
        if (current.tags.length >= TAG_MAX) return current;
        // Case-insensitive, because "Textiles" and "textiles" are one tag and two rows in a filter.
        const exists = current.tags.some((tag) => tag.toLowerCase() === name.toLowerCase());
        if (exists) return current;
        return { ...current, tags: [...current.tags, name] };
      });
    },
    []
  );

  const removeTag = useCallback((name: string) => {
    setValue((current) => ({ ...current, tags: current.tags.filter((tag) => tag !== name) }));
  }, []);

  // ── Validation ───────────────────────────────────────────────────────────

  const titleMissing = value.title.trim().length === 0;
  const addressMissing = value.slug.trim().length === 0;
  const scheduleProblems = statusProblems(
    {
      status: value.status,
      publishedAt: value.publishedAt,
      publishAt: value.publishAt,
      unpublishAt: value.unpublishAt
    },
    true
  );

  const saveDisabledReason = conflict
    ? "This article has both a formatted body and MDX source stored. Choose which one is the article before saving."
    : titleMissing
      ? "The article has no headline."
      : addressMissing
        ? "The article has no web address. It is usually the headline with hyphens instead of spaces."
        : (scheduleProblems[0] ?? null);

  /** Reasons it must not go public yet. Deliberately short: an editor's judgement is not a validation rule. */
  const publishBlockers: string[] = [];
  if (titleMissing) publishBlockers.push("The article has no headline.");
  if (words === 0) {
    publishBlockers.push("Nothing has been written in the body yet, so the page would be empty.");
  }
  if (conflict) {
    publishBlockers.push("Two different bodies are stored for this article and only one can be published.");
  }

  // ── Derived bits for the render ──────────────────────────────────────────

  const mayPublish = canPublishPredicate(user);
  const mayReassign = canEditOthersContent(user);
  const advice = seoAdvice(value, cover !== null);

  const suggestedExcerpt = useMemo(() => {
    if (writingMode === "mdx") return truncateWords(plainText, EXCERPT_SUGGESTION_CHARS);
    return richTextExcerpt(parseRichText(value.body), EXCERPT_SUGGESTION_CHARS);
  }, [plainText, value.body, writingMode]);

  const atTagLimit = value.tags.length >= TAG_MAX;

  return (
    <div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,23rem)] lg:items-start">
        {/* ── The article itself ─────────────────────────────────────────── */}
        <div className="min-w-0 space-y-5">
          <FormSection
            title="Headline and standfirst"
            description="The headline is what appears at the top of the article and in every list. The standfirst is the line underneath it."
          >
            <Field
              label="Headline"
              required
              maxLength={TITLE_MAX}
              value={value.title}
              error={fieldErrors?.title?.[0] ?? null}
              help="Say what happened. Sentence case, no full stop."
            >
              <Input
                value={value.title}
                onChange={(event) => setValue((current) => ({ ...current, title: event.target.value }))}
                placeholder="Centre opens its craft archive to the public"
              />
            </Field>

            <SlugField
              value={value.slug}
              onChange={(next) => setValue((current) => ({ ...current, slug: next }))}
              source={value.title}
              basePath="/news/"
              siteUrl={siteOrigin}
              originalValue={mode === "edit" ? initial.slug : undefined}
              isPublished={isPublic}
              required
              error={fieldErrors?.slug?.[0] ?? null}
            />

            <Field
              label="Standfirst"
              maxLength={SUBTITLE_MAX}
              value={value.subtitle}
              help="One sentence under the headline, on the page itself. Leave it empty if the headline says enough."
            >
              <Input
                value={value.subtitle}
                onChange={(event) => setValue((current) => ({ ...current, subtitle: event.target.value }))}
              />
            </Field>

            <Field
              label="Summary for lists"
              maxLength={EXCERPT_MAX}
              value={value.excerpt}
              help="Used in the newsroom list, on the homepage, and as the description when the link is shared. Two sentences at most."
            >
              <Textarea
                value={value.excerpt}
                rows={3}
                onChange={(event) => setValue((current) => ({ ...current, excerpt: event.target.value }))}
              />
            </Field>

            {value.excerpt.trim().length === 0 && suggestedExcerpt.length > 0 ? (
              <div className="rounded-md border border-line-200 bg-surface-50 px-3 py-2.5">
                <p className="text-xs leading-relaxed text-ink-500">
                  With no summary, lists will use the opening of the article:
                </p>
                <p className="mt-1 text-sm leading-relaxed text-ink-700">{suggestedExcerpt}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Sparkles}
                  className="mt-2.5"
                  onClick={() => setValue((current) => ({ ...current, excerpt: suggestedExcerpt }))}
                >
                  Use this as the summary
                </Button>
              </div>
            ) : null}
          </FormSection>

          {/* ── The body ─────────────────────────────────────────────────── */}
          <FormSection
            title="The article"
            description={
              writingMode === "mdx"
                ? "This article is written in MDX. That is source text, not a formatted editor — it can hold components, and mistakes in it are only visible when the page is built."
                : "Write it here. The same formatting appears on the published page, drawn by the same code, so nothing changes when you publish."
            }
            actions={
              <div className="flex items-center gap-1 rounded-md border border-line-200 bg-surface-50 p-1">
                {/*
                  Two real buttons rather than a dropdown: this is a two-way choice with a consequence, and
                  `aria-pressed` states which one is in force. A `<select>` would need a change event and a
                  confirmation fired from inside it, which reads as the control refusing to work.
                */}
                <ModeButton
                  active={writingMode === "formatted"}
                  icon={Type}
                  label="Formatted editor"
                  onClick={() => void switchMode("formatted")}
                />
                <ModeButton
                  active={writingMode === "mdx"}
                  icon={FileCode2}
                  label="MDX source"
                  onClick={() => void switchMode("mdx")}
                />
              </div>
            }
          >
            {conflict ? (
              // `role="alert"`: the reader is about to write into one of two bodies, one of which is going
              // to be destroyed. That is worth interrupting them for.
              <div
                role="alert"
                className="rounded-md border border-error-200 bg-error-100 px-4 py-3.5 text-sm leading-relaxed text-error-600"
              >
                <p className="flex items-start gap-2 font-semibold">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>This article has two bodies stored, and only one can be published.</span>
                </p>
                <p className="mt-1.5">
                  Something has written both a formatted body and MDX source. Choose which one is the
                  article. The other is cleared on screen straight away and in the database on the next
                  save — the version history keeps it either way. Nothing can be saved until you choose.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" icon={Type} onClick={() => resolveConflict("formatted")}>
                    Keep the formatted body
                  </Button>
                  <Button variant="secondary" size="sm" icon={FileCode2} onClick={() => resolveConflict("mdx")}>
                    Keep the MDX source
                  </Button>
                </div>
              </div>
            ) : null}

            {writingMode === "formatted" ? (
              <RichTextEditor
                value={value.body}
                onChange={(doc: RichTextDoc) => setValue((current) => ({ ...current, body: doc }))}
                label="Article body"
                placeholder="Start writing, or press / for a list of blocks you can insert."
                minHeight={420}
                onRequestMedia={storageReady ? requestBodyMedia : undefined}
              />
            ) : (
              <Field
                label="MDX source"
                hideLabel
                help="Markdown with components. It is compiled when the site is built, so a mistake here shows up as a build failure rather than as a broken paragraph."
              >
                <Textarea
                  value={value.mdx}
                  rows={22}
                  spellCheck={false}
                  onChange={(event) => setValue((current) => ({ ...current, mdx: event.target.value }))}
                  className="font-mono text-xs leading-relaxed"
                  placeholder={"# A heading\n\nAn opening paragraph.\n"}
                />
              </Field>
            )}

            {/*
              THE READING TIME, ON SCREEN. Not a live region: it changes on every keystroke, and a region
              re-announced on each character would talk over the typing it describes.
            */}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-700">
              <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" />
              {words === 0 ? (
                <span className="text-ink-500">Nothing written yet.</span>
              ) : (
                <>
                  <span className="font-medium">
                    About {minutes} {minutes === 1 ? "minute" : "minutes"} to read
                  </span>
                  <span className="text-ink-500">
                    · {words.toLocaleString("en-GB")} words
                    {writingMode === "mdx" ? " (an estimate: code and components are not counted)" : ""}
                  </span>
                </>
              )}
            </p>
          </FormSection>
        </div>

        {/* ── The side column ───────────────────────────────────────────── */}
        <div className="min-w-0 space-y-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain lg:pb-2">
          <FormSection
            title="Publishing"
            description="Whether readers outside the studio can see this article, and when."
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

            {/*
              Featuring is a publishing decision — it puts the article on the homepage — so the control is
              absent, not disabled, for somebody who cannot publish (contract §1.8).
            */}
            {mayPublish ? (
              <Switch
                checked={value.isFeatured}
                onCheckedChange={(checked) =>
                  setValue((current) => ({ ...current, isFeatured: checked }))
                }
                label="Feature this article"
                description="Featured articles appear first in the newsroom and can be shown on the homepage. Publishing it is still a separate step."
              />
            ) : null}
          </FormSection>

          <FormSection
            title="Filing"
            description="Where this article sits in the newsroom, and whose name is on it."
          >
            <Field
              label="Category"
              help="One category per article. It decides which category page the article appears on."
            >
              <Select
                value={value.categoryId ?? ""}
                placeholder="Not filed in any category"
                options={categories.map((category) => ({ value: category.id, label: category.name }))}
                onChange={(event) =>
                  setValue((current) => ({
                    ...current,
                    // The placeholder's value is the empty string; the column is nullable, and sending
                    // `""` would create a category id nothing matches.
                    categoryId: event.target.value.length > 0 ? event.target.value : null
                  }))
                }
              />
            </Field>

            {/* `FieldBlock`, not `Field`: there is a button in here, and a `<label>` wrapped round a
                button forwards stray clicks into it and folds its text into the input's name. */}
            <FieldBlock
              label="Tags"
              help={`Free-form labels for cross-cutting subjects. Type a name and press Enter — a tag that does not exist yet is created when you save. Up to ${TAG_MAX}.`}
              htmlFor="article-tag-input"
            >
              {value.tags.length > 0 ? (
                <ul className="mb-2 flex flex-wrap gap-1.5">
                  {value.tags.map((tag) => (
                    <li key={tag}>
                      {/* The whole chip removes the tag. A 12px × inside a chip is a target nobody hits. */}
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-700 transition hover:border-purple-300 hover:bg-purple-100"
                      >
                        {tag}
                        <X aria-hidden="true" className="h-3 w-3" />
                        <span className="sr-only"> — remove this tag</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="flex flex-wrap items-start gap-2">
                <Input
                  id="article-tag-input"
                  list="article-tag-suggestions"
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    // Otherwise Enter submits whatever form this happens to sit inside, and the tag is
                    // lost along with everything else on the screen.
                    event.preventDefault();
                    addTag(tagDraft);
                  }}
                  placeholder={atTagLimit ? "That is the most this article holds" : "textiles"}
                  disabled={atTagLimit}
                  className="min-w-0 flex-1"
                />
                <datalist id="article-tag-suggestions">
                  {tagSuggestions.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Plus}
                  disabled={atTagLimit || tagDraft.trim().length === 0}
                  onClick={() => addTag(tagDraft)}
                >
                  Add
                </Button>
              </div>

              <p
                className={cn(
                  "mt-1.5 text-xs tabular-nums",
                  atTagLimit ? "text-amber-800" : "text-ink-500"
                )}
              >
                You can add up to {TAG_MAX}; {value.tags.length} added.
                {tagSuggestionsTruncated
                  ? " The suggestions list shows only the most used tags — typing a name that is not offered still works."
                  : ""}
              </p>
            </FieldBlock>

            {mayReassign ? (
              <Field
                label="Author"
                help="Whose name appears on the article. Only an editor can change this."
              >
                <Select
                  value={value.authorId ?? ""}
                  placeholder="No author"
                  options={authors.map((author) => ({ value: author.id, label: author.name }))}
                  onChange={(event) =>
                    setValue((current) => ({
                      ...current,
                      authorId: event.target.value.length > 0 ? event.target.value : null
                    }))
                  }
                />
              </Field>
            ) : (
              // A sentence, never a disabled dropdown (contract §1.8).
              <div>
                <p className="field-label">Author</p>
                <p className="mt-1.5 text-sm text-ink-700">{authorName ?? "No author recorded"}</p>
                <HelpText className="mt-1">
                  Only an editor can put somebody else&rsquo;s name on an article.
                </HelpText>
              </div>
            )}
          </FormSection>

          <FormSection
            title="Cover photograph"
            description="Shown at the top of the article, in the newsroom list, and when the link is shared."
          >
            {cover !== null ? (
              <MediaImage
                media={cover}
                // The picture's own description comes from the media library; here it is decorative
                // because the panel around it says what it is.
                alt=""
                aspect="16 / 9"
                rounded="md"
                targetWidth={640}
                sizes="(min-width: 1024px) 21rem, 100vw"
              />
            ) : (
              <p className="rounded-md border border-dashed border-line-200 bg-surface-50 px-3 py-4 text-sm text-ink-500">
                No cover photograph. The article will appear without a picture everywhere it is listed.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={ImageIcon}
                onClick={() => setPickerTarget("cover")}
              >
                {cover === null ? "Choose a photograph" : "Change the photograph"}
              </Button>
              {cover !== null ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={X}
                  onClick={() => {
                    setCover(null);
                    setValue((current) => ({ ...current, coverId: null }));
                  }}
                >
                  Take it off
                </Button>
              ) : null}
            </div>

            <HelpText>
              Descriptions for screen readers are written once, in the media library, and follow the
              picture everywhere it is used.
            </HelpText>
          </FormSection>

          <FormSection
            title="Read next"
            description="Articles offered at the foot of this one. Chosen by hand, so the suggestions are editorial rather than guessed from tags."
          >
            <EntityPicker
              kind="news"
              label="Related articles"
              help={`Up to ${RELATED_MAX}. The order here is the order they appear in.`}
              ids={value.relatedIds}
              onChange={(next) =>
                setValue((current) => ({
                  ...current,
                  // An article cannot be related to itself: the strip at the foot would offer the reader
                  // the page they are already on.
                  relatedIds: next.filter((id) => id !== postId)
                }))
              }
              max={RELATED_MAX}
              footnote="An article that is not published yet is listed here but will not appear on the site."
            />
          </FormSection>

          <FormSection
            title="Search and sharing"
            description="How this article appears in a search result and when somebody posts the link."
          >
            <Field
              label="Search-engine headline"
              maxLength={SEO_TITLE_MAX}
              value={value.seoTitle}
              help={`Leave it empty to use the article's own headline. About ${SEO_TITLE_IDEAL} characters is all that shows.`}
            >
              <Input
                value={value.seoTitle}
                onChange={(event) => setValue((current) => ({ ...current, seoTitle: event.target.value }))}
                placeholder={value.title.length > 0 ? value.title : undefined}
              />
            </Field>

            <Field
              label="Search-engine description"
              maxLength={SEO_DESCRIPTION_MAX}
              value={value.seoDescription}
              help={`Leave it empty to use the summary above. About ${SEO_DESCRIPTION_IDEAL} characters is shown.`}
            >
              <Textarea
                value={value.seoDescription}
                rows={3}
                onChange={(event) =>
                  setValue((current) => ({ ...current, seoDescription: event.target.value }))
                }
              />
            </Field>

            <Switch
              checked={value.seoNoIndex}
              onCheckedChange={(checked) => setValue((current) => ({ ...current, seoNoIndex: checked }))}
              label="Keep this article out of search results"
              description="Search engines are asked not to list it. It stays readable to anybody with the address — this is not a way of keeping it private."
            />

            <div
              className={cn(
                "rounded-md px-3.5 py-3",
                // Width and colour together in each branch: a lone `border` is preflight's literal
                // gray-200, which does not invert (contract §3).
                advice.length === 0
                  ? "border border-success-600/25 bg-success-100"
                  : "border border-line-200 bg-surface-50"
              )}
            >
              {advice.length === 0 ? (
                <p className="flex items-start gap-2 text-sm leading-relaxed text-success-600">
                  <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Nothing is missing here.</span>
                </p>
              ) : (
                <>
                  <p className="flex items-start gap-2 text-sm font-medium leading-relaxed text-ink-900">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
                    <span>
                      {advice.length === 1
                        ? "One thing would improve how this article is found and shared:"
                        : `${advice.length} things would improve how this article is found and shared:`}
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
          </FormSection>
        </div>
      </div>

      <SaveBar
        status={autosave.status}
        lastSavedAt={autosave.lastSavedAt}
        onSave={() => void autosave.saveNow()}
        onDiscard={discard}
        error={autosave.error?.message ?? null}
        saveDisabledReason={saveDisabledReason}
        saveLabel={mode === "create" ? "Create this article" : "Save"}
        subject="this article"
        note={
          mode === "create"
            ? "Nothing is saved until you choose Create. It starts as a draft."
            : autosave.retriesExhausted
              ? /*
                  AUTOMATIC SAVING HAS GIVEN UP, and it must say so in the error tone rather than the
                  note's usual grey. `useAutosave` stops retrying after three consecutive failures (its
                  rule 4) and exposes `retriesExhausted` for exactly this sentence. Without the branch
                  the bar goes on claiming the article is "saved on its own a few seconds after you stop
                  typing", which is now false — so an editor keeps typing into a form nothing is storing
                  and then closes the tab. The failure itself is printed above this line, verbatim from
                  the server; this line is the consequence and what to do about it.
                */
                <span className="font-medium text-error-600">
                  Not saving. Your last change was not stored. Press Save to try again.
                </span>
              : isPublic
                ? PUBLISHED_AUTOSAVE_NOTICE
                : "This article is not published, so it is saved on its own a few seconds after you stop typing."
        }
      >
        {/* An extra readout beside the buttons: the one number an author checks before publishing. */}
        {words > 0 ? (
          <Badge tone="neutral" size="sm" icon={Clock}>
            {minutes} min read
          </Badge>
        ) : null}
      </SaveBar>

      <MediaPicker
        open={pickerTarget !== null}
        onClose={closePicker}
        onSelect={(assets: StudioMediaAsset[]) => {
          const chosen = assets[0];
          if (!chosen) return;

          if (pickerTarget === "cover") {
            setCover(chosen);
            setValue((current) => ({ ...current, coverId: chosen.id }));
          } else {
            // `StudioMediaAsset` already has every field `EditorMediaSelection` asks for, so it goes
            // straight through — no URL is ever handed to the document (see the picture node).
            mediaResolver.current?.(chosen);
            mediaResolver.current = null;
          }
          setPickerTarget(null);
        }}
        kind="IMAGE"
        storageReady={storageReady}
        title={pickerTarget === "cover" ? "Choose a cover photograph" : "Choose a picture to insert"}
      />
    </div>
  );
}

/** One of the two writing modes. `aria-pressed` is what states which is in force. */
function ModeButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition",
        active ? "bg-purple-700 text-white" : "text-ink-700 hover:bg-surface-100 hover:text-ink-900"
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
