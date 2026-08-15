"use client";

/**
 * PageBuilder — the screen an administrator builds a page on. The most important screen in the studio.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ARCHITECTURE, IN FOUR SENTENCES
 *
 * 1. This component holds the WORKING COPY of every block on the page, and it is the only thing that
 *    does. The list, the editor panel and the preview are all given what to draw and hand back what the
 *    reader did. Two components that both believe they know the current settings will eventually
 *    disagree, and the one that is wrong is always the one on screen.
 *
 * 2. A CONTENT CHANGE — the words in a block, its name, whether it is switched on — goes through
 *    `useAutosave`, which sends only the blocks that actually differ from what the server has.
 *
 * 3. A STRUCTURAL CHANGE — adding, copying, deleting — is its own immediate request, because a reader
 *    who has just pressed Delete expects it gone, not gone in four seconds.
 *
 * 4. A REORDER is ONE request carrying the WHOLE new order.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY A REORDER IS ONE REQUEST AND NOT N. `PageSection` has `@@unique([pageId, position])` and a dense
 * 0-based ordering. Moving one block in a list of seven changes the position of everything between the
 * old and the new place, so N independent updates means N requests that can interleave — and the moment
 * two of them are in flight, two blocks claim one position and the constraint refuses one of them,
 * AFTER some of the others have landed. The page is then half-reordered with no record of what happened.
 * So the client sends the complete order and the server rewrites the range in a transaction.
 *
 * AND THE OPTIMISTIC REORDER ROLLS BACK TO WHAT THE SERVER LAST CONFIRMED, not to the order that was on
 * screen a moment ago. If two reorders were made quickly and the second failed, "a moment ago" is the
 * first one — which the server may or may not have. The last confirmed order is the only order anybody
 * knows to be true, so that is the one the screen goes back to. The failure then SAYS what happened; a
 * list that silently jumps back is a list an administrator will fight for ten minutes.
 *
 * REQUESTS ARE NEVER TWO AT ONCE. The order endpoint gets the same treatment as the autosave loop in
 * `components/studio/useAutosave.ts` and the token refresh in `lib/client/fetcher.ts`: one in flight, a
 * single pending slot holding the LATEST order, and a follow-up pass when the first returns. Because
 * every request carries the complete order, only the most recent one matters.
 *
 * A PUBLISHED PAGE IS NOT AUTOSAVED, AND THE WORDING HERE IS DELIBERATELY NOT
 * `PUBLISHED_AUTOSAVE_NOTICE`. The two now say the same true thing — nothing saves on its own, and
 * Save goes straight to the live site — but that constant says "this record" so it can sit on every
 * kind of editor, and this screen can do better: it names the page, and its unpublished branch
 * explains the autosave that IS running. A page's blocks have only one copy, so a block added to a
 * live page is created HIDDEN by the server (see the sections route) rather than sent out with its
 * placeholder wording; the palette and the add toast both say so, and the row's eye toggle is how the
 * editor turns it on once the words are real.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * LIVE PREVIEW — A FIFTH KIND OF REQUEST, AND THE ONLY ONE THAT WRITES NOTHING DOWN.
 *
 * While a preview is on screen — the Preview tab or Side by side — and live preview is on, the
 * working copy is PUT to
 * `/api/studio/pages/[id]/preview-draft` a short pause after every change. The route validates it and
 * puts it in a ten-minute in-process store keyed by page AND editor; the preview route renders it in
 * place of the saved rows, so the frame shows the real page — same route, same renderers, fully
 * interactive — including words that have not been saved. Nothing is written to the database and
 * nothing is audited, because nothing has changed: a preview is a read.
 *
 * THE PAUSE IS 400ms, AND THE NUMBER IS THE WHOLE DESIGN. Ordinary prose is typed at roughly 150–250ms
 * between keystrokes, so anything at or below 250 would fire mid-word and a sentence would become
 * thirty requests and thirty reloads. Above about 500ms a person has stopped attributing what appears
 * on screen to what they just typed, and the preview stops feeling live at all. 400 sits in the gap: a
 * sentence typed straight through is ONE request, and the frame catches up while the editor is still
 * looking at the same paragraph. The FIRST draft of a session skips the wait entirely — there is
 * nothing on screen yet to disturb, and waiting would mean showing the saved page for a beat and then
 * replacing it.
 *
 * ONE REQUEST IN FLIGHT, WITH THE LATEST WORKING COPY IN A REF — the same shape as the reorder loop
 * below and `useAutosave`'s. Every PUT carries the COMPLETE set of blocks, so an older one is not
 * merely redundant, it is wrong; the loop re-reads the ref after each round trip and stops when what
 * has been sent matches what is on screen.
 *
 * A REFUSED DRAFT PAUSES THE LIVE PREVIEW RATHER THAN RETRYING. A block whose settings do not validate
 * is refused whole by the route (a preview missing one block is a preview of a page that does not
 * exist), and hammering it every 400ms while somebody types a URL would be pointless. The state goes
 * to `paused`, the frame shows the server's own sentence and keeps displaying the last draft that got
 * through, and the next change re-arms the loop.
 *
 * WITH LIVE PREVIEW ON, SAVES AND STRUCTURAL CHANGES NO LONGER RELOAD THE FRAME. They do not need to —
 * every one of them changes the working copy, which triggers a draft, which reloads the frame once. A
 * second bump would reload it twice for one action. `bumpPreview()` is the gate; the draft loop bumps
 * directly.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NOTHING ANIMATES ON ARRIVAL. The studio is calm and dense (contract §0). The only motion is the row
 * outline that says "this is the block that was just saved" — and that outline is static under reduced
 * motion, so it is not motion-only information (contract §1.4).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Columns2, ExternalLink, LayoutList, Monitor, Plus } from "lucide-react";
import type { SectionType } from "@prisma/client";

import { ApiClientError, apiFetch, asApiClientError, del, patch, post } from "@/lib/client/fetcher";
import { canManageStructure, type PermissionSubject } from "@/lib/permissions";
import { clamp } from "@/lib/utils";
import { defaultSectionData, parseSectionData } from "@/lib/sections/schema";
import { mergeSectionData } from "@/components/studio/sections";
import { Button, LinkButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { SaveBar } from "@/components/studio/SaveBar";
import { useAutosave } from "@/components/studio/useAutosave";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
import { AddSectionPalette } from "@/components/studio/builder/AddSectionPalette";
import {
  DEFAULT_PREVIEW_DISPLAY,
  PreviewFrame,
  previewHref,
  type PreviewDisplay,
  type PreviewLiveState
} from "@/components/studio/builder/PreviewFrame";
import {
  safeSectionMeta,
  sectionDisplayName,
  type BuilderSection
} from "@/components/studio/builder/SectionCard";
import {
  SectionEditorPanel,
  SECTION_LABEL_MAX_LENGTH,
  type SectionFormMap
} from "@/components/studio/builder/SectionEditorPanel";
import { SectionList } from "@/components/studio/builder/SectionList";

// ─────────────────────────────────────────────────────────────────────────────
// The wire shapes
// ─────────────────────────────────────────────────────────────────────────────

/** The part of a block that autosave is responsible for. Position is not in here — see `snapshot`. */
interface SectionContent {
  label: string | null;
  data: unknown;
  isVisible: boolean;
}

/**
 * One entry in the autosave snapshot.
 *
 * `type` rides along because the save loop validates each block before sending it and needs to know
 * which rules to validate against. It is deliberately NOT part of the signature below: a block's kind
 * never changes, so including it could only ever produce a false "this has been edited".
 */
interface SnapshotEntry extends SectionContent {
  id: string;
  type: SectionType;
}

/** What the create endpoint answers with. See the manifest note on the API this screen expects. */
interface CreatedSectionResponse {
  section: BuilderSection;
}

/**
 * One block as the live preview draft carries it.
 *
 * Deliberately NOT `SnapshotEntry`: that one is sorted by id and carries no `position`, because a
 * reorder must not look like an edit to the autosave. The preview needs the opposite — the ORDER is
 * most of what a preview is for — so this shape carries `position` and is sent in screen order.
 */
interface PreviewDraftEntry {
  id: string;
  type: SectionType;
  position: number;
  label: string | null;
  data: unknown;
  isVisible: boolean;
}

/**
 * How long after the last change the working copy is sent for the live preview.
 *
 * 400ms. See the header for why this number and not a rounder one: it is above the 150–250ms between
 * keystrokes in ordinary prose, so a sentence is one request rather than thirty, and below the ~500ms
 * at which a person stops connecting what appears on screen with what they just typed.
 */
const PREVIEW_DRAFT_DEBOUNCE_MS = 400;

/**
 * After this long, the client stops believing the server still holds the draft it last sent.
 *
 * The store gives a draft ten minutes from its last write (`PREVIEW_DRAFT_TTL_MS`). An editor who
 * sends a draft, works in the Build tab for a quarter of an hour and comes back to Preview would
 * otherwise be shown the last SAVED page under a banner claiming to be live, because nothing had
 * changed and so nothing was re-sent. Eight minutes leaves two minutes of margin against a slow
 * request and a clock that is not quite the server's.
 */
const PREVIEW_DRAFT_REFRESH_MS = 8 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentOf(section: SectionContent): SectionContent {
  return { label: section.label, data: section.data, isVisible: section.isVisible };
}

/**
 * The comparison that decides whether a block needs saving.
 *
 * A SERIALISED SNAPSHOT, not an identity check, for the same reason `useAutosave` does it: the form is
 * controlled React state, so every object in it is a new identity on every keystroke and an identity
 * comparison would call every render a change. The useful half is the other direction — typing a
 * character and deleting it again leaves the block CLEAN, so it is never resaved.
 */
function signatureOf(content: SectionContent): string {
  return JSON.stringify(contentOf(content));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Make an unparseable payload editable again.
 *
 * The recovery path, and it only runs when validation has FAILED. Because every field in
 * `lib/sections/schema.ts` has a default, a failure means some value is actively wrong rather than
 * missing — so the raw value is kept (it is what the reader has to see in order to correct it) and only
 * the keys that are absent altogether are filled in from the block's own starting settings. A form
 * given `undefined` for a field it renders as a controlled input would switch that input to
 * uncontrolled and warn, which is a broken box on top of a broken value.
 *
 * The merge is deliberately SHALLOW. A nested value that is present but half-filled — a button with a
 * label and no address — stays exactly as it is, which is right: that is the thing being repaired.
 */
function repairSectionData(type: SectionType, raw: unknown): unknown {
  const defaults = defaultSectionData(type);
  if (!isPlainObject(defaults)) return raw;
  if (!isPlainObject(raw)) return defaults;
  return { ...defaults, ...raw };
}

/**
 * A block as the builder holds it: settings validated once, at the door.
 *
 * NORMALISED HERE AND NOWHERE ELSE. Parsing on every keystroke and feeding the result back into the
 * form would fight the reader's typing, because the text schemas `.trim()` — the space just typed
 * between two words would vanish and the cursor would jump. So the settings are parsed once, when the
 * screen opens, gaining any defaults added since the block was last saved; after that the working copy
 * is exactly what has been typed, and validation runs alongside rather than through it.
 */
function normaliseSection(section: BuilderSection): BuilderSection {
  const parsed = parseSectionData(section.type, section.data);
  const payload = parsed.ok ? parsed.data : repairSectionData(section.type, section.data);
  /*
    ⚠ `mergeSectionData` IS NOT OPTIONAL, HERE OR ANYWHERE A PAYLOAD IS WRITTEN BACK.

    A block's named anchor lives on `data.anchor` and is deliberately not part of any of the
    schemas — it is addressing rather than content. `z.object()` strips unknown keys, so the parsed payload
    has already lost it. Writing that payload back unmerged would delete the anchor the moment the screen
    opened, and every menu entry pointing at `/about#history` would quietly stop working.
  */
  return { ...section, data: mergeSectionData(section.data, payload) };
}

/**
 * Re-order the working copy to match a list of ids, and renumber.
 *
 * Anything the id list does not mention keeps its relative place at the end rather than being dropped.
 * That matters on a rollback: the confirmed order is from before the last add, so a block added since
 * would otherwise disappear from the screen while sitting perfectly happily in the database.
 */
function applyOrder(current: readonly BuilderSection[], ids: readonly string[]): BuilderSection[] {
  const remaining = new Map(current.map((section) => [section.id, section]));
  const ordered: BuilderSection[] = [];

  for (const id of ids) {
    const section = remaining.get(id);
    if (!section) continue;
    ordered.push(section);
    remaining.delete(id);
  }
  for (const section of current) {
    if (remaining.has(section.id)) ordered.push(section);
  }

  return ordered.map((section, index) =>
    section.position === index ? section : { ...section, position: index }
  );
}

/** "Autumn campaign" → "Autumn campaign (copy)", clipped to the length the name field allows. */
function copyLabel(label: string | null): string | null {
  const base = label?.trim() ?? "";
  if (base === "") return null;
  return `${base} (copy)`.slice(0, SECTION_LABEL_MAX_LENGTH);
}

// ─────────────────────────────────────────────────────────────────────────────
// The gate
// ─────────────────────────────────────────────────────────────────────────────

export interface PageBuilderProps {
  pageId: string;
  /** The page's own title. Used in the wording and in the preview frame's name. */
  pageTitle: string;
  /** True when the page is live on the public site. ⚠ Changes how saving works — see the header. */
  isPublished: boolean;
  /** Every block on the page, in order, read straight from the database by the Server Component. */
  initialSections: BuilderSection[];
  /** The preview address COMPLETE WITH its `?preview=…` token, built on the server. */
  previewUrl: string;
  /** The signed-in user, so the client checks the same predicate the route handler does (contract §1.7). */
  user: PermissionSubject;
  /**
   * The per-type editing forms. Defaults to every one of them (`SECTION_FORMS`); pass a narrower map only
   * for a screen that may edit some kinds of block and not others.
   */
  forms?: SectionFormMap;
}

/**
 * The permission gate, separated from the surface so that the check happens BEFORE any hook runs.
 *
 * An early `return null` sitting above a list of hooks would change the number of hooks between renders,
 * which React forbids. The same split as `Dialog`/`DialogSurface`.
 *
 * ⚠ THIS IS THE SECOND COPY OF THE PREDICATE, NOT THE BOUNDARY. The studio route must call
 * `requireCapability` and every route handler must check `canManageStructure` for itself; a client guard
 * that only hides a control is not a guard (contract §1.7). Rendering NOTHING rather than a read-only
 * shell is contract §1.8: a reader who may not build pages is not shown a page builder to look at.
 */
export function PageBuilder(props: PageBuilderProps) {
  if (!canManageStructure(props.user)) return null;
  return <PageBuilderSurface {...props} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// The surface
// ─────────────────────────────────────────────────────────────────────────────

function PageBuilderSurface({
  pageId,
  pageTitle,
  isPublished,
  initialSections,
  previewUrl,
  forms
}: PageBuilderProps) {
  const { toast } = useToast();
  const confirm = useConfirm();

  /**
   * The working copy, seeded once.
   *
   * A later render from the server — a `router.refresh()` after a publish, say — deliberately does NOT
   * replace it. Adopting a fresh list would throw away whatever had been typed since, which is a worse
   * failure than a stale `position` number that the next reorder rewrites anyway.
   */
  const normalisedInitial = useMemo(
    () => initialSections.map(normaliseSection),
    [initialSections]
  );
  const [sections, setSections] = useState<BuilderSection[]>(normalisedInitial);

  const [selectedId, setSelectedId] = useState<string | null>(() => normalisedInitial[0]?.id ?? null);
  /**
   * Which of the three ways of working on this page is on screen.
   *
   *   `build`   — the block list and the settings panel, the preview not mounted at all.
   *   `split`   — both, side by side. The editor types on the left and watches on the right.
   *   `preview` — the frame alone, at the full width of the screen.
   *
   * ⚠ `split` COUNTS AS THE PREVIEW BEING OPEN wherever that question is asked — the live-draft loop
   * below is the one that matters, and it must send drafts here or the right-hand frame shows the last
   * save while somebody edits beside it. Search for `mode === "build"` rather than `mode !== "preview"`
   * for the places that had to change when this stopped being a two-way switch.
   */
  const [mode, setMode] = useState<"build" | "split" | "preview">("build");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [insertAt, setInsertAt] = useState(0);
  const [structuralBusy, setStructuralBusy] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  /** Bumped when the preview frame should reload. It reloads on this and on nothing else. */
  const [previewToken, setPreviewToken] = useState(0);

  /**
   * Live preview, ON by default.
   *
   * On is the useful default — a preview that shows the last save while you type is the thing this
   * whole mechanism exists to fix — and turning it off is one click in the frame's own toolbar, which
   * is where somebody who is writing a long paragraph and does not want it refreshing will look.
   */
  const [livePreview, setLivePreview] = useState(true);
  /**
   * Which device, orientation and theme the preview shows — held HERE, not in `PreviewFrame`, because
   * each tab mounts its own frame and state inside one dies with its tab. Choose the phone in Side by
   * side, glance at Build, come back: still the phone. See `PreviewDisplay` in PreviewFrame.tsx.
   */
  const [previewDisplay, setPreviewDisplay] = useState<PreviewDisplay>(DEFAULT_PREVIEW_DISPLAY);
  const [liveState, setLiveState] = useState<PreviewLiveState>("waiting");
  /** The server's own sentence when a draft is refused. Rendered verbatim; never re-worded here. */
  const [liveProblem, setLiveProblem] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);

  /**
   * Reload the preview because something was SAVED.
   *
   * ⚠ It does nothing while live preview is on, and that is not an optimisation. Every save and every
   * structural change also changes the working copy, which sends a draft, which reloads the frame; a
   * bump here as well would reload it twice for one action — and each reload costs the reader their
   * place in the page for the moment it takes to restore it. The draft loop bumps `previewToken`
   * directly, so the two paths never both fire.
   *
   * A ref rather than the state value, because this is called from inside `useAutosave`'s options and
   * from awaited handlers, and neither should be re-created every time the toggle moves.
   */
  const liveOn = useRef(livePreview);
  useEffect(() => {
    liveOn.current = livePreview;
  }, [livePreview]);

  const bumpPreview = useCallback(() => {
    if (liveOn.current) return;
    setPreviewToken((token) => token + 1);
  }, []);

  // ── What the server is known to hold ─────────────────────────────────────
  //
  // Seeded from the memo rather than written during render: a ref assigned in the render body would be
  // assigned on a render React is free to discard, and the value it recorded would then describe a
  // state that never committed.

  const initialSaved = useMemo(() => {
    const map = new Map<string, SectionContent>();
    for (const section of normalisedInitial) map.set(section.id, contentOf(section));
    return map;
  }, [normalisedInitial]);
  const savedRef = useRef(initialSaved);

  const initialIds = useMemo(() => normalisedInitial.map((section) => section.id), [normalisedInitial]);
  /** The last order the server confirmed. The one order anybody knows to be true — see the header. */
  const confirmedOrder = useRef<readonly string[]>(initialIds);

  // ── The "just saved" outline ──────────────────────────────────────────────

  const flashTimer = useRef<number | null>(null);
  const flash = useCallback((id: string) => {
    setFlashId(id);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    // Long enough to notice, short enough not to become part of the design. The `.flash-row` recipe's
    // own animation is 700ms; the outline lingers a moment past it.
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setFlashId(null);
    }, 1200);
  }, []);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    []
  );

  // ── Validation ───────────────────────────────────────────────────────────
  //
  // Every block, re-checked whenever the working copy changes. Cheap: the payloads are small, flat and
  // JSON-serialisable by design, and the memo means it runs on an edit rather than on a render.

  const validations = useMemo(() => {
    const map = new Map<string, { problem: string | null; fieldErrors: Record<string, string[]> | null }>();
    for (const section of sections) {
      const result = parseSectionData(section.type, section.data);
      map.set(
        section.id,
        result.ok
          ? { problem: null, fieldErrors: null }
          : { problem: result.message, fieldErrors: result.fieldErrors }
      );
    }
    return map;
  }, [sections]);

  const problems = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, validation] of validations) {
      if (validation.problem !== null) map.set(id, validation.problem);
    }
    return map;
  }, [validations]);

  // ── Autosave ─────────────────────────────────────────────────────────────

  /**
   * The snapshot, SORTED BY ID.
   *
   * Sorting is what keeps a reorder out of the autosave's idea of "dirty": moving a block changes the
   * array order but not this list, and position is not one of the fields. Reordering is saved by its own
   * endpoint, so counting it as an edit here would send a second, pointless write of unchanged content
   * and put a second identical revision in the history.
   */
  const snapshot = useMemo<SnapshotEntry[]>(
    () =>
      sections
        .map((section) => ({
          id: section.id,
          type: section.type,
          label: section.label,
          data: section.data,
          isVisible: section.isVisible
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [sections]
  );

  /**
   * Did the last save pass actually send anything?
   *
   * Adding or deleting a block changes the snapshot, so `useAutosave` correctly calls the page dirty and
   * runs a pass — which then finds nothing to send, because the structural request already saved it. Left
   * ungated, that empty pass would reload the preview a second time a few seconds after every add, for
   * no change at all, throwing away wherever the reader had scrolled to in it.
   */
  const sentSomething = useRef(false);

  /**
   * Save every block that differs from what the server holds — and nothing else.
   *
   * Sequential rather than parallel, on purpose. Each request writes a row, a revision and an audit
   * entry through `mutateWithHistory()`; firing seven at once at one page is seven transactions
   * competing for the same rows for no benefit, since the reader is waiting for all of them anyway.
   *
   * ⚠ A BLOCK WHOSE SETTINGS DO NOT VALIDATE IS SKIPPED, AND THEN THIS THROWS. Sending it would earn a
   * 422 per attempt for as long as the fault existed; skipping it silently would let the bar say "All
   * changes saved" about a block that has not been. So the valid blocks are saved — partial progress is
   * real progress, and it is recorded, so it is not sent twice — and the failure names the block that
   * was held back. `useAutosave` then backs off, gives up after three tries and says so, which is the
   * right end state for a fault only a person can clear.
   */
  const saveSections = useCallback(
    async (entries: SnapshotEntry[]): Promise<void> => {
      const saved = savedRef.current;
      const refused: { name: string; problem: string }[] = [];
      let lastSavedId: string | null = null;
      sentSomething.current = false;

      for (const entry of entries) {
        const next = contentOf(entry);
        const previous = saved.get(entry.id);
        if (previous && signatureOf(previous) === signatureOf(next)) continue;

        const result = parseSectionData(entry.type, entry.data);
        if (!result.ok) {
          refused.push({
            name: sectionDisplayName({ type: entry.type, label: entry.label }),
            problem: result.message
          });
          continue;
        }

        await patch(`/api/studio/pages/${pageId}/sections/${entry.id}`, next);
        saved.set(entry.id, next);
        sentSomething.current = true;
        lastSavedId = entry.id;
      }

      // Forget blocks that are no longer on the page, so this map cannot grow for the life of the tab.
      const live = new Set(entries.map((entry) => entry.id));
      for (const id of Array.from(saved.keys())) {
        if (!live.has(id)) saved.delete(id);
      }

      if (lastSavedId !== null) flash(lastSavedId);

      const first = refused[0];
      if (first) {
        const others = refused.length - 1;
        const tail =
          others > 0
            ? ` ${others === 1 ? "One other block" : `${others} other blocks`} could not be saved either.`
            : "";
        // An `ApiClientError`, not a bare `Error`: `asApiClientError` replaces an unrecognised error's
        // message with a generic one, so a plain throw here would reach the reader as "Something went
        // wrong on this page" — the opposite of what they need to know.
        throw new ApiClientError(
          422,
          `“${first.name}” was not saved: ${first.problem}${tail} Every other block you changed has been saved.`,
          { code: "section_invalid" }
        );
      }
    },
    [pageId, flash]
  );

  const autosave = useAutosave<SnapshotEntry[]>({
    data: snapshot,
    save: saveSections,
    isPublished,
    // With live preview off the preview shows the page as SAVED, so it refreshes here — and only when
    // the pass genuinely wrote something. With it on, `bumpPreview` is a no-op and the draft loop owns
    // the reload; see its note.
    onSaved: () => {
      if (sentSomething.current) bumpPreview();
    }
  });

  useLeaveGuard(autosave.isDirty);

  const discard = useCallback(() => {
    setSections((current) =>
      current.map((section) => {
        const saved = savedRef.current.get(section.id);
        // A block added since the last save is already on the server — it was created by its own
        // request — so its saved content is on record and this puts it back to that, not to nothing.
        return saved ? { ...section, ...saved } : section;
      })
    );
  }, []);

  // ── Live preview ─────────────────────────────────────────────────────────
  //
  // See the header for the shape of this: one request in flight, the latest working copy in a ref, a
  // 400ms pause, and a refusal that pauses rather than retries.

  /**
   * The whole page, in SCREEN ORDER, as the preview needs it.
   *
   * `position` is the array index rather than `section.position`, so a drag that has not yet been
   * confirmed by the order endpoint previews in the order the reader can see. The server renumbers
   * densely on read in any case.
   */
  const livePayload = useMemo<PreviewDraftEntry[]>(
    () =>
      sections.map((section, index) => ({
        id: section.id,
        type: section.type,
        position: index,
        label: section.label,
        data: section.data,
        isVisible: section.isVisible
      })),
    [sections]
  );

  /**
   * The comparison that decides whether the preview is behind — a serialised snapshot, for the same
   * reason `signatureOf` is one: every object in a controlled form is a new identity on every
   * keystroke, so an identity check would call every render a change and reload the frame forever.
   */
  const liveSignature = useMemo(() => JSON.stringify(livePayload), [livePayload]);

  const latestDraft = useRef<{ payload: PreviewDraftEntry[]; signature: string }>({
    payload: livePayload,
    signature: liveSignature
  });
  /**
   * What the server is believed to hold, and when it was told.
   *
   * Null means "nothing has been sent, or what was sent has probably expired" — the second half is
   * what `PREVIEW_DRAFT_REFRESH_MS` is for, and it is the reason this is a timestamped pair rather
   * than a bare signature.
   */
  const sentDraft = useRef<{ signature: string; at: number } | null>(null);
  const draftBusy = useRef(false);

  const flushDraft = useCallback(async (): Promise<void> => {
    // One in flight. A caller that arrives while the loop is running does not need to queue anything:
    // the loop re-reads `latestDraft` and will pick up whatever has been typed since.
    if (draftBusy.current) return;

    draftBusy.current = true;
    let stored = false;
    let discarded = false;

    try {
      /*
        ⚠ `liveOn.current` IS RE-READ EVERY ROUND, NOT TESTED ONCE.

        The editor can turn live preview off while a request is on the wire, and `changeLivePreview`
        clears `sentDraft` — so without this test the loop's own condition would read true again and it
        would PUT the working copy a SECOND time, putting back the unsaved words the DELETE beside it
        had just removed and leaving them in a server's memory for the full ten minutes. It would then
        reload a frame that is deliberately showing the saved page, costing the reader their place for
        an action they took to stop exactly that.

        The one request already in flight when the toggle moves cannot be recalled; if it lands after
        the DELETE the draft survives to its TTL, which is the residual race the store's own header
        already covers.
      */
      while (liveOn.current && latestDraft.current.signature !== sentDraft.current?.signature) {
        const attempt = latestDraft.current;
        try {
          // `apiFetch` with an explicit method rather than a `put()` helper, because there is no `put`
          // in lib/client/fetcher.ts and adding one belongs in that file rather than in this feature.
          // PUT rather than POST: the draft for this page and this editor is one thing, replaced whole.
          await apiFetch<unknown>(`/api/studio/pages/${pageId}/preview-draft`, {
            method: "PUT",
            body: { sections: attempt.payload }
          });
          sentDraft.current = { signature: attempt.signature, at: Date.now() };
          stored = true;
        } catch (thrown) {
          const failure = asApiClientError(thrown);
          // Nothing to report about a draft the editor has just stopped asking for — and reporting it
          // would leave a stale problem behind for the next time they switch live preview back on.
          if (!liveOn.current) return;
          setLiveState("paused");
          // The route's sentence, verbatim — it names the block that is holding things up, or quotes
          // the size cap, and lib/api.ts guarantees it is ready to render.
          setLiveProblem(failure.message);
          /*
            ⚠ A 413 IS THE ONE REFUSAL THAT ALSO THREW THE STORED DRAFT AWAY. `putPreviewDraft` deletes
            the previous draft along with the over-size one, on the reasoning that a preview showing
            older words while the builder believes it is live is the single outcome this mechanism
            exists to prevent — and the route's sentence accordingly tells the editor the preview is
            showing the page as it was last saved. That sentence is only TRUE once the frame has been
            reloaded, so it is reloaded. Left un-bumped, the notice describes one thing and the frame
            underneath it goes on showing another.

            A 422 needs no reload: the store still holds the last good draft, which is exactly what the
            frame is already showing and exactly what that sentence says.
          */
          if (failure.status === 413) discarded = true;
          // Deliberately NOT retried here. The usual cause is a block whose settings do not validate
          // yet, which will not fix itself, and re-sending every 400ms while somebody types a URL is
          // noise on the server and a stuck spinner on the screen. The next change re-arms the effect
          // below, which is exactly when there is something new to try.
          return;
        }
      }

      // The toggle went off mid-flight: the frame is on its way back to the saved page and calling it
      // live would be the one thing this state is never allowed to say.
      if (!liveOn.current) return;
      setLiveState("live");
      setLiveProblem(null);
    } finally {
      draftBusy.current = false;
      // ONE reload for the whole loop, however many rounds it took — the last draft stored is the only
      // one the frame would ever have shown, and each reload costs the reader their place for a beat.
      if ((stored || discarded) && liveOn.current) setPreviewToken((token) => token + 1);
    }
  }, [pageId]);

  useEffect(() => {
    // Written on every render so the loop above always sees the current working copy, including while
    // a request it started is still in flight.
    latestDraft.current = { payload: livePayload, signature: liveSignature };

    // Nothing is sent while no preview is on screen. The draft would be stale by the time anybody
    // looked at it, and an editor who never opens the preview should not be posting their page
    // anywhere. Opening it re-runs this effect, which is when the first draft goes.
    //
    // ⚠ `=== "build"`, NOT `!== "preview"`. Side by side has the frame open too, and reading this the
    // old way would leave that frame showing the last save while somebody edits beside it — the exact
    // failure the split view exists to fix, and a silent one.
    if (!livePreview || mode === "build") return;

    // A draft the server has probably forgotten is not a draft. Coming back to the Preview tab after
    // a long spell in Build is exactly when this fires, and it is the only moment it matters — see
    // PREVIEW_DRAFT_REFRESH_MS.
    const sent = sentDraft.current;
    if (sent !== null && Date.now() - sent.at >= PREVIEW_DRAFT_REFRESH_MS) sentDraft.current = null;

    if (sentDraft.current?.signature === liveSignature) return;

    setLiveState("waiting");

    // The first draft of a session goes immediately: there is nothing on screen yet to disturb, and
    // waiting would mean showing the saved page for a beat and then replacing it.
    const delay = sentDraft.current === null ? 0 : PREVIEW_DRAFT_DEBOUNCE_MS;
    const timer = window.setTimeout(() => void flushDraft(), delay);
    return () => window.clearTimeout(timer);
  }, [livePreview, mode, livePayload, liveSignature, flushDraft]);

  const changeLivePreview = useCallback(
    (next: boolean) => {
      setLivePreview(next);
      // Written here as well as by the effect above, and that is not belt-and-braces: `flushDraft` may
      // be awaiting a request RIGHT NOW, and it decides whether to carry on from this ref. The effect
      // does not run until React has re-rendered, which is a beat too late for a loop that is already
      // in the air.
      liveOn.current = next;
      // Neither direction bumps the reload token: the frame's ADDRESS changes when the live flag goes
      // on or comes off, so the browser navigates by itself and a bump would navigate twice.
      sentDraft.current = null;
      setLiveProblem(null);
      setLiveState("waiting");

      if (next) return;

      // Turning it off throws the draft away rather than leaving it to time out. It is the editor's
      // unsaved words sitting in a server's memory and they have just said they do not want them
      // shown. A failure needs no toast — the store's ten-minute life clears it either way, and
      // nothing on screen depends on the answer.
      void del<void>(`/api/studio/pages/${pageId}/preview-draft`).catch(() => undefined);
    },
    [pageId]
  );

  // ── Reordering ───────────────────────────────────────────────────────────

  const orderBusy = useRef(false);
  const orderPending = useRef<readonly string[] | null>(null);

  const pushOrder = useCallback(
    async (ids: readonly string[]): Promise<void> => {
      // One in flight, one pending slot holding the LATEST order. Because every request carries the
      // complete order, an older one is not merely redundant — it is wrong, and joining the running
      // request is how it is prevented from being sent.
      if (orderBusy.current) {
        orderPending.current = ids;
        return;
      }

      orderBusy.current = true;
      try {
        let queued: readonly string[] | null = ids;
        while (queued) {
          const attempt = queued;
          orderPending.current = null;

          try {
            await patch(`/api/studio/pages/${pageId}/sections/order`, { ids: [...attempt] });
            confirmedOrder.current = attempt;
            setReorderError(null);
            bumpPreview();
          } catch (thrown) {
            const failure = asApiClientError(thrown);
            setReorderError(failure.message);
            setSections((current) => applyOrder(current, confirmedOrder.current));
            toast({
              tone: "error",
              title: "The new order was not saved",
              description: failure.message
            });
            break;
          }

          queued = orderPending.current;
        }
      } finally {
        orderBusy.current = false;
        orderPending.current = null;
      }
    },
    [pageId, toast, bumpPreview]
  );

  const handleReorder = useCallback(
    (ids: string[]) => {
      // Optimistic: the list moves now and the request catches up. A builder dragging four blocks into
      // place cannot wait for a round trip between each one.
      setSections((current) => applyOrder(current, ids));
      void pushOrder(ids);
    },
    [pushOrder]
  );

  // ── Selecting ────────────────────────────────────────────────────────────

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    // `block: "nearest"` does nothing when the panel is already in view, which it always is on a wide
    // screen where the two columns sit side by side. On a narrow one, where the panel is below the list,
    // it is what stops a click appearing to do nothing at all. Instant, not smooth: the studio is calm.
    panelRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  // ── Adding, copying, deleting ────────────────────────────────────────────

  const openPalette = useCallback((position: number) => {
    setInsertAt(position);
    setPaletteOpen(true);
  }, []);

  /**
   * Puts a created block into the working copy at `position` and records it as saved.
   *
   * ⚠ THE LIST IS READ FROM THE UPDATER, NOT FROM THE CLOSURE. This runs after an awaited request, and
   * during that await a failed reorder can have rolled the list back — so the closure's `sections` is not
   * necessarily the current one. `confirmedOrder` is therefore written from inside the updater too, which
   * is safe because the computation is pure: React re-invoking the updater writes the identical value, and
   * queued updaters are applied in order, so the last write matches the state that commits.
   *
   * No refetch: the server inserted at the same position and shifted the rest, so the two agree by
   * arithmetic. The next reorder rewrites the whole range in any case.
   */
  const adopt = useCallback(
    (created: BuilderSection, position: number) => {
      const normalised = normaliseSection(created);
      savedRef.current.set(normalised.id, contentOf(normalised));

      setSections((current) => {
        const next = [...current];
        next.splice(clamp(position, 0, next.length), 0, normalised);
        const renumbered = next.map((section, index) =>
          section.position === index ? section : { ...section, position: index }
        );
        confirmedOrder.current = renumbered.map((section) => section.id);
        return renumbered;
      });

      setSelectedId(normalised.id);
      flash(normalised.id);
      bumpPreview();
      // A block added from the Preview tab would otherwise arrive somewhere the reader cannot see and
      // has no settings open. Adding is a building action, so it puts them back in the builder.
      //
      // ⚠ FROM THE PREVIEW TAB ONLY. Side by side already shows the list and the settings panel, so
      // yanking the layout out from under somebody who can see their new block perfectly well would be
      // a jump for no reason. The functional update is what keeps this out of the dependency array.
      setMode((current) => (current === "preview" ? "build" : current));
    },
    [flash, bumpPreview]
  );

  const addSection = useCallback(
    async (type: SectionType) => {
      setStructuralBusy(true);
      try {
        const created = await post<CreatedSectionResponse>(
          `/api/studio/pages/${pageId}/sections`,
          { type, position: insertAt, data: defaultSectionData(type) }
        );
        adopt(created.section, insertAt);
        setPaletteOpen(false);
        toast({
          tone: "success",
          title: `${safeSectionMeta(type).label} added`,
          // On a live page the server creates the block hidden (see the sections route), so the toast
          // has to explain the "Hidden" chip the editor is now looking at.
          description: isPublished
            ? "Its settings are open on the right. It arrived hidden because the page is live — switch it on when its wording is ready."
            : "Its settings are open on the right. It starts with wording you can replace."
        });
      } catch (thrown) {
        const failure = asApiClientError(thrown);
        toast({
          tone: "error",
          title: "The block was not added",
          description: failure.message
        });
      } finally {
        setStructuralBusy(false);
      }
    },
    [pageId, insertAt, adopt, toast, isPublished]
  );

  const duplicateSection = useCallback(
    async (id: string) => {
      const index = sections.findIndex((section) => section.id === id);
      const source = sections[index];
      if (!source) return;

      /*
        ⚠ A BLOCK THE REGISTRY MARKS `allowMultiple: false` CANNOT BE COPIED, AND THIS IS THE OTHER
        HALF OF A RULE THE PALETTE ALREADY ENFORCES.

        `AddSectionPalette` stops OFFERING such a type once the page has one (contract §7.5) — but
        "Make a copy" reached the create endpoint by a different door and produced exactly what the
        rule exists to prevent: two HEROes on one page, which is two openings competing for the one
        `<h1>` the accessibility contract allows (contract §11), and a second full-height opening
        halfway down that reads as the start of a different page.

        It SAYS SO rather than doing nothing. A menu entry that is offered, pressed, and then silently
        has no effect is indistinguishable from a broken screen — and unlike the palette, which can
        withhold an entry from a list, this control lives in a per-row menu where the only honest place
        to put the reason is after the press.

        Checked FIRST, before the validation gate below: it is the cheaper answer and the more
        fundamental one — a block that may not be copied at all does not need its settings examined.
      */
      const meta = safeSectionMeta(source.type);
      if (!meta.allowMultiple) {
        toast({
          tone: "warn",
          title: `A page can only have one ${meta.label.toLowerCase()}`,
          description:
            "This sort of block may not be repeated, so it cannot be copied. Change the one already on the page, or delete it and add a new one where you want it."
        });
        return;
      }

      // Copying settings that will not validate would produce a second broken block and a 422 the reader
      // has to interpret. Saying so first is both shorter and kinder.
      const problem = problems.get(id);
      if (problem) {
        toast({
          tone: "error",
          title: "This block cannot be copied yet",
          description: `Put right the problem with it first: ${problem}`
        });
        return;
      }

      setStructuralBusy(true);
      try {
        const created = await post<CreatedSectionResponse>(
          `/api/studio/pages/${pageId}/sections`,
          {
            type: source.type,
            position: index + 1,
            label: copyLabel(source.label),
            // The WORKING copy, not the saved one: a builder who has just changed a block and pressed
            // "Make a copy" means a copy of what they are looking at.
            data: source.data,
            isVisible: source.isVisible
          }
        );
        adopt(created.section, index + 1);
        toast({
          tone: "success",
          title: "Copy added below",
          // A copy made on a live page arrives hidden however the original is set — same server rule
          // as adding — and a toast claiming "everything is the same" would then be wrong about the
          // one thing the reader can see.
          description: isPublished
            ? "Everything written in it is the same, but it arrived hidden because the page is live — switch it on when it is ready. Rename it so the two are easy to tell apart."
            : "Everything in it is the same. Rename it so the two are easy to tell apart."
        });
      } catch (thrown) {
        const failure = asApiClientError(thrown);
        toast({ tone: "error", title: "The copy was not made", description: failure.message });
      } finally {
        setStructuralBusy(false);
      }
    },
    [sections, problems, pageId, adopt, toast, isPublished]
  );

  const deleteSection = useCallback(
    async (id: string) => {
      const index = sections.findIndex((section) => section.id === id);
      const target = sections[index];
      if (!target) return;

      const name = sectionDisplayName(target);
      // Worked out before the question is asked, while the list is certainly the one the reader is
      // looking at. The block above is where they land afterwards, so they keep their place in the page.
      const neighbourId = (sections[index - 1] ?? sections[index + 1])?.id ?? null;

      /*
        Danger tone, which `useConfirm` gives by default: `role="alertdialog"`, focus on Cancel and no
        backdrop dismiss, so no reflex click or Enter can remove a block.

        No `requireTyping`. That ceremony is for an action with no undo at all — emptying the recycle bin,
        purging bytes. This is close: `PageSection` has no `deletedAt`, so a deleted block does NOT go to
        the recycle bin. But it is one block on one page and rebuilding it is minutes, not years, so the
        question says plainly that it will not come back and leaves it there.
      */
      const agreed = await confirm({
        title: `Delete ${name}?`,
        body: (
          <>
            <p>
              The block and everything written in it are removed from this page. Blocks do not go to the
              recycle bin, so this cannot be undone from the studio.
            </p>
            <p className="mt-2">
              To take it off the site without losing the work, close this and turn off &ldquo;Show this
              block on the page&rdquo; instead.
            </p>
          </>
        ),
        confirmLabel: "Delete this block",
        cancelLabel: "Keep it"
      });
      if (!agreed) return;

      setStructuralBusy(true);
      try {
        await del<void>(`/api/studio/pages/${pageId}/sections/${id}`);

        savedRef.current.delete(id);

        // From the updater, not the closure — the confirmation was awaited. See `adopt`.
        setSections((current) => {
          const remaining = current
            .filter((section) => section.id !== id)
            .map((section, position) =>
              section.position === position ? section : { ...section, position }
            );
          confirmedOrder.current = remaining.map((section) => section.id);
          return remaining;
        });

        setSelectedId((current) => (current === id ? neighbourId : current));

        bumpPreview();
        toast({ tone: "success", title: `${name} was deleted` });
      } catch (thrown) {
        const failure = asApiClientError(thrown);
        toast({ tone: "error", title: "The block was not deleted", description: failure.message });
      } finally {
        setStructuralBusy(false);
      }
    },
    [sections, pageId, confirm, toast, bumpPreview]
  );

  // ── Editing the selected block ───────────────────────────────────────────

  const updateSelected = useCallback(
    (change: Partial<SectionContent>) => {
      setSections((current) =>
        current.map((section) => (section.id === selectedId ? { ...section, ...change } : section))
      );
    },
    [selectedId]
  );

  /**
   * A form reported new settings.
   *
   * Separate from `updateSelected` because it must fold the new payload into the STORED one through
   * `mergeSectionData` rather than replacing it — see the note on `normaliseSection`. Read from the
   * updater so the raw value being merged into is the current one.
   */
  const changeSelectedData = useCallback(
    (next: unknown) => {
      setSections((current) =>
        current.map((section) =>
          section.id === selectedId
            ? { ...section, data: mergeSectionData(section.data, next) }
            : section
        )
      );
    },
    [selectedId]
  );

  const toggleVisible = useCallback((id: string) => {
    setSections((current) =>
      current.map((section) =>
        section.id === id ? { ...section, isVisible: !section.isVisible } : section
      )
    );
  }, []);

  // ── Derived values for the render ────────────────────────────────────────

  const selectedIndex = sections.findIndex((section) => section.id === selectedId);
  const selected = selectedIndex === -1 ? null : (sections[selectedIndex] ?? null);
  const selectedValidation = selected ? validations.get(selected.id) : undefined;

  const usedTypes = useMemo(() => sections.map((section) => section.type), [sections]);

  /** Where the palette's "Add a block" would put it: after the selected block, else at the end. */
  const defaultInsertAt = selectedIndex === -1 ? sections.length : selectedIndex + 1;
  const insertAfter = insertAt <= 0 ? null : (sections[insertAt - 1] ?? null);

  /**
   * What to call the selected block on the Add button.
   *
   * The editor's own name when there is one, because "below Autumn campaign" identifies a block on a page
   * with four hero-shaped things on it and "below hero banner" does not.
   */
  const selectedShortName = selected
    ? selected.label?.trim() || safeSectionMeta(selected.type).label.toLowerCase()
    : null;

  const savingNote = isPublished
    ? // Deliberately NOT PUBLISHED_AUTOSAVE_NOTICE — the same truth, but this wording names the page
      // rather than "this record". See the header.
      "This page is live on the site, so nothing here is saved on its own — a half-written sentence would go straight out to readers. Choose Save when you are ready, and the changes appear on the site immediately."
    : "This page is not published yet, so changes are saved on their own a few seconds after you stop typing.";

  const retryNote = autosave.retriesExhausted
    ? " Saving has stopped trying on its own after several failures. Choose Save to try again."
    : "";

  /**
   * One sentence saying what is on screen and whether it includes unsaved work.
   *
   * ⚠ THE SPLIT LINE IS THE ONE PLACE "AS YOU TYPE" MAY BE SAID, and it still is not said. This note
   * used to carry a comment insisting the copy must never promise it, because Build and Preview were
   * two panels of one `Tabs` and nobody could be doing both. Side by side makes it possible for the
   * first time — but the frame refreshes a moment after a change lands, not per keystroke, so the
   * honest phrasing is unchanged. What the split line adds is the ADVICE, because the disappointment
   * it heads off is real: a 1440px desktop shrunk into half a screen is a thumbnail, and somebody
   * who meets that first concludes the split view is useless rather than that the device button is.
   */
  const modeNote = (() => {
    if (mode === "build") {
      return "Blocks are shown in the order a reader meets them, from the top of the page down.";
    }

    if (mode === "split") {
      return livePreview
        ? "The blocks are on the left and the real page is on the right, including changes you have not saved yet. It refreshes a moment after a change and keeps its place. Choose a narrower screen width in the preview's toolbar — a phone or a tablet fits beside the editor at full size, where a desktop has to shrink a long way."
        : "The blocks are on the left and the page as it was last saved is on the right. Turn on Live preview in the preview's toolbar to see changes there before saving them.";
    }

    return livePreview
      ? "The preview is the real page at four screen widths, including changes you have not saved yet. It refreshes a moment after a change, and keeps its place on the page when it does."
      : "The preview shows this page as it was last saved, at four screen widths. It refreshes itself whenever a change is saved.";
  })();

  /**
   * The two halves of the builder, defined once and placed by each layout.
   *
   * They are elements rather than components on purpose: a component declared inside this function
   * would be a NEW type on every render, so React would unmount and remount the settings form — losing
   * focus, selection and any half-typed word in it — every time anything on this screen changed.
   *
   * Only one layout is mounted at a time (`Tabs` renders the selected panel only), so `panelRef` below
   * appearing in two of them is one ref on one node, never two competing for it.
   */
  const blockListPanel = (
    <FormSection
      title="Blocks on this page"
      description="A page is a stack of blocks. Choose one to change what is in it, and drag the handle — or use Move up and Move down in its menu — to change where it sits."
    >
      <SectionList
        sections={sections}
        selectedId={selectedId}
        problems={problems}
        flashId={flashId}
        busy={structuralBusy}
        reorderError={reorderError}
        onReorder={handleReorder}
        onSelect={handleSelect}
        onDuplicate={(id) => void duplicateSection(id)}
        onToggleVisible={toggleVisible}
        onDelete={(id) => void deleteSection(id)}
        onAdd={openPalette}
      />
    </FormSection>
  );

  const blockSettingsPanel = (
    <SectionEditorPanel
      section={selected}
      value={selected?.data ?? null}
      problem={selectedValidation?.problem ?? null}
      fieldErrors={selectedValidation?.fieldErrors ?? null}
      forms={forms}
      index={selectedIndex}
      total={sections.length}
      disabled={structuralBusy}
      onLabelChange={(label) => updateSelected({ label: label === "" ? null : label })}
      onDataChange={changeSelectedData}
      onVisibleChange={(isVisible) => updateSelected({ isVisible })}
    />
  );

  const previewPanel = (dense: boolean) => (
    <PreviewFrame
      src={previewUrl}
      pageTitle={pageTitle}
      reloadToken={previewToken}
      hasUnsavedChanges={autosave.isDirty}
      livePreview={livePreview}
      onLivePreviewChange={changeLivePreview}
      liveState={liveState}
      liveProblem={liveProblem}
      dense={dense}
      display={previewDisplay}
      onDisplayChange={setPreviewDisplay}
    />
  );

  const tabs: TabItem[] = [
    {
      id: "build",
      label: "Build",
      icon: LayoutList,
      count: sections.length,
      content: (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
          {blockListPanel}

          {/*
            Sticky on a wide screen so the settings stay beside the list however far down it the reader
            has scrolled. Without it, choosing the eighteenth block opens a form eight screens above
            where they are looking.
          */}
          <div
            ref={panelRef}
            className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:overscroll-contain"
          >
            {blockSettingsPanel}
          </div>
        </div>
      )
    },
    {
      /*
       * ── Side by side ──────────────────────────────────────────────────────────────────────────
       *
       * The layout the frame's own header used to describe as something that might exist "one day":
       * the editor types on the left and the real page answers on the right, with no tab switch in
       * between. Everything that makes it work was already here — the draft loop, the reload token and
       * the scroll restore — and all this adds is the arrangement plus the one-word change to the
       * draft gate that stops the right-hand frame showing yesterday's save.
       *
       * ⚠ IT SITS IN THE MIDDLE OF THE THREE, NOT AT THE END. Tabs move under the arrow keys in the
       * order they are declared, and the reading order that matches what the screen does is
       * build → both → preview. Putting it last would make the arrow keys jump from "just the blocks"
       * to "just the page" and back to "both".
       *
       * THE SPLIT ENGAGES AT `lg`, and below that the same three panels simply stack. A 1024px screen
       * gives each column about 490px, which is the width at which a phone preview lands at 100% and
       * stops being a thumbnail. Forcing two columns onto a narrower screen would give a preview too
       * small to judge anything by and a settings form too narrow to fill in — two useless panels
       * instead of one good one.
       */
      id: "split",
      label: "Side by side",
      icon: Columns2,
      /*
       * ⚠ `grid-cols-1` BELOW IS LOAD-BEARING AND IS NOT THE DEFAULT. A `grid` with no declared
       * columns gets ONE `auto` column, and an `auto` track is sized to its widest content rather than
       * to its container. The preview column's stage holds an iframe laid out at the device's REAL
       * width — 1440px — so before the `ResizeObserver` inside `PreviewFrame` has measured anything,
       * that number sizes the whole track and the studio scrolls sideways. It never recovers either:
       * the observer then measures the widened column and agrees with it.
       *
       * `grid-cols-1` is `minmax(0, 1fr)`, which pins the track to the container and lets the
       * measurement start from the truth. `lg:grid-cols-2` is already `minmax(0, 1fr)` twice over,
       * which is why this only ever went wrong below `lg`.
       */
      content: (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start">
          <div className="min-w-0 space-y-5">
            {blockListPanel}
            <div ref={panelRef}>{blockSettingsPanel}</div>
          </div>

          {/*
            The frame is the sticky one here, which is the opposite of the Build layout and right for the
            same reason: the thing you are looking AT should stay put while the thing you are working IN
            scrolls. `overscroll-contain` keeps a scroll gesture that reaches the bottom of the preview
            column from carrying on into the page behind it.
          */}
          <div className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:overscroll-contain">
            {previewPanel(true)}
          </div>
        </div>
      )
    },
    {
      id: "preview",
      label: "Preview",
      icon: Monitor,
      content: previewPanel(false)
    }
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="prose-measure text-sm leading-relaxed text-ink-500">{modeNote}</p>

        <div className="flex flex-wrap items-center gap-2">
          {/*
            ⚠ OUTSIDE THE FRAME, because the frame is not mounted in the Build tab and this is most
            useful from exactly there: an editor with two screens puts the page on the second one and
            never opens the Preview tab at all. The frame's toolbar keeps its own copy of this button —
            somebody already looking at the preview should not have to go hunting up here for it.

            `previewHref` is shared with the frame so the two cannot disagree about which page they
            open. Building the URL by hand here is how "the tab shows the saved page and the panel shows
            the draft" happens, and it would be a confusing thing to debug.

            ⚠ THE NEW TAB IS A SNAPSHOT, NOT A SECOND LIVE PANEL, and the label says "as it is now" so
            nobody waits in front of a window that is never going to change by itself. It shows the
            draft as it stood when it was opened; reloading it picks up everything since.
          */}
          <LinkButton
            variant="secondary"
            icon={ExternalLink}
            href={previewHref(previewUrl, livePreview)}
            newTab
          >
            Open the preview as it is now
          </LinkButton>

          <Button icon={Plus} onClick={() => openPalette(defaultInsertAt)}>
            {selectedShortName === null ? "Add a block" : `Add a block below ${selectedShortName}`}
          </Button>
        </div>
      </div>

      <Tabs
        items={tabs}
        value={mode}
        // Narrowed against the tab list rather than trusted: `Tabs` hands back whatever id it was given,
        // and a typo in a tab id would otherwise put `mode` into a state no layout renders — a blank
        // panel with no error. Anything unrecognised falls back to the builder.
        onChange={(id) => setMode(id === "preview" ? "preview" : id === "split" ? "split" : "build")}
        label="Ways of working on this page"
        className="mt-4"
      />

      <SaveBar
        status={autosave.status}
        lastSavedAt={autosave.lastSavedAt}
        onSave={() => void autosave.saveNow()}
        onDiscard={discard}
        error={autosave.error?.message ?? null}
        note={`${savingNote}${retryNote}`}
        subject="this page"
      />

      <AddSectionPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        insertAt={insertAt}
        total={sections.length}
        insertAfterName={insertAfter ? sectionDisplayName(insertAfter) : null}
        usedTypes={usedTypes}
        isAdding={structuralBusy}
        pageIsLive={isPublished}
        onAdd={(type) => void addSection(type)}
      />
    </div>
  );
}
