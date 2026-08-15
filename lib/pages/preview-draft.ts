import "server-only";

import type { PageSection, Prisma, SectionType } from "@prisma/client";

/**
 * The LIVE PREVIEW DRAFT — one editor's unsaved blocks, held server-side just long enough for the
 * preview frame to render them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY A SERVER-SIDE STORE AND NOT A POSTED PAYLOAD
 *
 * The whole value of the studio's preview is that it is THE REAL PAGE: the same route, the same
 * renderers, the same client components, the same media resolution, fully interactive. A preview that
 * re-implemented the page from a payload in the browser would be a second renderer, and a second
 * renderer disagrees with the first eventually — usually about the thing the editor was checking.
 *
 * So the blocks travel the only way that keeps one renderer: the builder PUTs them here, and the
 * preview route reads them in place of the saved rows. Everything downstream of that swap is
 * unchanged.
 *
 * ⚠ **READ THIS BEFORE YOU RELY ON IT. THE STORE IS PER PROCESS.** It is a `Map` on `globalThis`, so
 * every serverless instance, every container replica and every region gets its OWN copy. On a
 * horizontally scaled deployment the builder's PUT and the preview's GET can land on different
 * instances, and the preview then finds nothing and renders THE LAST SAVED PAGE. That is an
 * acceptable degradation — the saved page is a true page, not a broken one — but it is a degradation,
 * and it must never be silent: the preview route renders `PREVIEW_DRAFT_FALLBACK_NOTICE` whenever
 * `readPreviewDraft` answers null while the live flag was asked for. A preview that quietly shows
 * yesterday's words while claiming to be live is worse than one that admits it is behind.
 *
 * The real answer is a shared store with a TTL — a Redis `SETEX` under the same key, or the
 * platform's own KV — where every instance sees one draft. That needs a service this deployment does
 * not require, so the in-process map is the honest stand-in until one is added. Nothing here pretends
 * otherwise. (`lib/ratelimit.ts` states the identical limit about the identical mechanism; if a
 * shared store is ever provisioned, both should move to it in the same change.)
 *
 * ══ THE KEY IS THE PAGE **AND** THE EDITOR, AND THAT IS A SECURITY PROPERTY ══
 *
 * A draft keyed by page id alone would let one editor's half-written sentence appear in another
 * editor's preview of the same page — unsaved words, shown to somebody the writer never showed them
 * to, on a URL that looks like the published site. So the key is `pageId + editorId`, `readPreviewDraft`
 * demands both, and there is deliberately no "read any draft for this page" function to reach for.
 *
 * The preview route must therefore satisfy BOTH halves before it swaps anything in:
 *
 *   1. a valid `pagePreviewToken` for the slug (lib/pages.ts) — proves the link is genuine; and
 *   2. a signed-in user, whose own id is the `editorId` passed here — proves the draft is theirs.
 *
 * Neither alone is enough. The token is stable and shareable by design, so a forwarded link must not
 * carry somebody's unsaved work with it; and a session alone is not authority to read a preview.
 *
 * ══ WHAT IS AND IS NOT VALIDATED HERE ══
 *
 * Nothing in this file validates a payload, and that is deliberate rather than an omission. The ONE
 * caller that writes — `app/api/studio/pages/[id]/preview-draft/route.ts` — runs every block through
 * `parseSectionData()` first, exactly as the save routes do, and refuses the whole draft if any block
 * fails. Repeating the check here would mean importing the schemas into a module whose job is storage,
 * and two places that could disagree about what "valid" means. **Do not add a second writer.**
 *
 * ══ THE CAPS, AND WHAT HAPPENS AT THEM ══
 *
 *   • `PREVIEW_DRAFT_MAX_BYTES` — a draft larger than this is **REFUSED WHOLE, NEVER TRUNCATED**, and
 *     any draft already held under that key is discarded with it. A truncated draft would preview a
 *     page that is not the page: blocks silently missing from the bottom, which is precisely the
 *     failure an editor would trust the preview to rule out (contract §1.6). Refusing sends the
 *     preview back to the last saved page — a state that honestly exists — and the route answers 413
 *     with a sentence the builder puts on screen.
 *   • `PREVIEW_DRAFT_MAX_SECTIONS` — the same number a page may hold at all, so this can only ever
 *     fire on a malformed request, never on a real page.
 *   • `PREVIEW_DRAFT_MAX_ENTRIES` — the ceiling on concurrent drafts in one process. Past it the
 *     drafts closest to expiring are dropped, which sends those editors' previews back to the saved
 *     page until their next keystroke re-sends. A warning is logged, because a deployment that hits
 *     this ceiling routinely has outgrown the in-process map.
 *   • `PREVIEW_DRAFT_TTL_MS` — ten minutes. Long enough to survive a long paragraph and a coffee,
 *     short enough that a browser closed without a DELETE cannot leave unsaved words in memory for
 *     the life of the process. A DELETE cannot be sent from an unload handler (`sendBeacon` is POST
 *     only), so the TTL — not the client — is what guarantees a draft goes away.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * How long a stored draft stays readable.
 *
 * Refreshed on every write, so an editor who keeps typing keeps their draft; ten minutes is measured
 * from the LAST keystroke, not from the first.
 */
export const PREVIEW_DRAFT_TTL_MS = 10 * 60 * 1000;

/**
 * The largest draft that will be stored, as UTF-8 bytes of its JSON.
 *
 * 256 kB is several times the size of the largest realistic page — sixty blocks of rich text — and is
 * a guard against a runaway payload rather than an editorial limit. It is quoted in the route's
 * refusal so the number is never a mystery.
 */
export const PREVIEW_DRAFT_MAX_BYTES = 256 * 1024;

/** The same ceiling the create route enforces (`MAX_SECTIONS_PER_PAGE`), so the two cannot disagree. */
export const PREVIEW_DRAFT_MAX_SECTIONS = 60;

/**
 * Concurrent drafts in one process. At the worst case above that is roughly 8 MB, which is a price
 * worth paying for a live preview and not a price worth paying twice.
 */
export const PREVIEW_DRAFT_MAX_ENTRIES = 32;

/**
 * The query parameter that asks the preview route for the live draft rather than the saved rows.
 *
 * ⚠ **THIS NAME IS DECLARED IN TWO PLACES** and they must agree: here, for the route that reads it,
 * and in `components/studio/builder/PreviewFrame.tsx`, which builds the address in the browser. It
 * cannot simply be imported there, because this module is `server-only` — deliberately, since it
 * holds other people's unsaved words and must never be bundled for a browser. The frame's declaration
 * carries the same warning pointing back here.
 */
export const PAGE_PREVIEW_LIVE_QUERY_KEY = "live";

/** The only value the flag is honoured for. Anything else is read as "show me the saved page". */
export const PAGE_PREVIEW_LIVE_QUERY_VALUE = "1";

/**
 * What the preview route must put on screen when the live flag was asked for and no draft was found.
 *
 * A ready sentence rather than a rule to re-word, so the honest answer is the easy one to render. The
 * three reasons are all real and an editor can act on the first two: the draft expired, the tab that
 * wrote it has gone, or the request landed on an instance that never saw the PUT (see the header).
 */
export const PREVIEW_DRAFT_FALLBACK_NOTICE =
  "This is the page as it was last saved. Your unsaved changes could not be found for this preview — they may have expired, or the page builder may have been closed. Go back to the builder and type something to send them again, or save the page.";

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One block as the builder holds it, on the wire.
 *
 * `data` is `unknown` for the same reason `BuilderSection.data` is: it is a JSON payload validated by
 * `parseSectionData()` at the door and never assumed to have a shape after that.
 */
export interface PreviewDraftSection {
  id: string;
  type: SectionType;
  /** The builder's dense 0-based order. Re-derived on read, so a gap here is harmless. */
  position: number;
  label: string | null;
  data: unknown;
  isVisible: boolean;
}

export interface PreviewDraft {
  pageId: string;
  editorId: string;
  sections: PreviewDraftSection[];
  storedAt: number;
  expiresAt: number;
  /** UTF-8 bytes of the stored JSON. Reported back to the builder so a near-miss on the cap is visible. */
  bytes: number;
}

/**
 * A refusal is data, not a throw: the route turns it into a 413 with a sentence, and a store that
 * threw would make every caller wrap a write in a try/catch to find out a number it already knew.
 */
export type PreviewDraftWriteResult =
  | { ok: true; draft: PreviewDraft }
  | { ok: false; reason: "too_large"; bytes: number; limit: number };

// ─────────────────────────────────────────────────────────────────────────────
// The map
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewDraftState {
  drafts: Map<string, PreviewDraft>;
  lastSweepAt: number;
}

/**
 * The state lives on `globalThis`, for the same reason the Prisma client and the rate limiter's
 * buckets do: the dev server re-evaluates modules on every hot reload, and a module-scoped `Map` would
 * throw away the draft an editor is looking at every time a file was saved — which is the one moment
 * they are most likely to be testing it.
 */
const globalForPreviewDrafts = globalThis as unknown as { __cxaPreviewDrafts?: PreviewDraftState };

const state: PreviewDraftState =
  globalForPreviewDrafts.__cxaPreviewDrafts ?? { drafts: new Map(), lastSweepAt: 0 };
globalForPreviewDrafts.__cxaPreviewDrafts = state;

/** A full sweep runs at most this often, so a write stays O(1) in the ordinary case. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * The key. Both halves are required — see the header on why a page-only key leaks unsaved words.
 *
 * The separator is a colon, which cannot appear in a cuid, so two ids cannot run together into a
 * third editor's key.
 */
function draftKey(pageId: string, editorId: string): string {
  return `${pageId}:${editorId}`;
}

function sweep(now: number): void {
  for (const [key, draft] of state.drafts) {
    if (draft.expiresAt <= now) state.drafts.delete(key);
  }
  state.lastSweepAt = now;

  if (state.drafts.size <= PREVIEW_DRAFT_MAX_ENTRIES) return;

  // Still over the ceiling: shed the drafts closest to expiring, because they are the ones whose
  // owner has been idle longest and therefore the ones whose removal surprises somebody least. Their
  // previews fall back to the last saved page and say so, and their next keystroke re-sends.
  const excess = state.drafts.size - PREVIEW_DRAFT_MAX_ENTRIES;
  const oldest = [...state.drafts.entries()]
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, excess);
  for (const [key] of oldest) state.drafts.delete(key);

  console.warn(
    `[preview-draft] the draft map hit its ${PREVIEW_DRAFT_MAX_ENTRIES}-entry ceiling and ${excess} ` +
      "draft(s) were dropped, so those previews fall back to the last saved page until their editor " +
      "types again. If this recurs, the deployment has outgrown the in-process map — see the header " +
      "of lib/pages/preview-draft.ts."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing, reading, clearing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store one editor's working copy of one page.
 *
 * ⚠ THE SECTIONS MUST ALREADY HAVE BEEN VALIDATED with `parseSectionData()`. This function measures
 * and stores; it does not judge. See the header for why there is exactly one writer.
 *
 * An over-size draft is refused AND the previous draft under the key is deleted. Keeping the old one
 * would leave the preview showing an older set of words while the builder believed it was live —
 * silently stale is the one outcome this whole mechanism exists to avoid. Falling back to the saved
 * page is at least a state the editor can name.
 */
export function putPreviewDraft(input: {
  pageId: string;
  editorId: string;
  sections: PreviewDraftSection[];
}): PreviewDraftWriteResult {
  const now = Date.now();
  if (now - state.lastSweepAt > SWEEP_INTERVAL_MS || state.drafts.size > PREVIEW_DRAFT_MAX_ENTRIES) {
    sweep(now);
  }

  const key = draftKey(input.pageId, input.editorId);

  // Measured as UTF-8 bytes rather than string length: a page of Devanagari or a run of em dashes is
  // two to three times its character count on the wire, and a cap that counted characters would be a
  // different cap for different languages.
  const bytes = Buffer.byteLength(JSON.stringify(input.sections), "utf8");
  if (bytes > PREVIEW_DRAFT_MAX_BYTES) {
    state.drafts.delete(key);
    return { ok: false, reason: "too_large", bytes, limit: PREVIEW_DRAFT_MAX_BYTES };
  }

  const draft: PreviewDraft = {
    pageId: input.pageId,
    editorId: input.editorId,
    sections: input.sections,
    storedAt: now,
    // Measured from THIS write, so an editor who keeps typing keeps their draft indefinitely and one
    // who stops loses it ten minutes later.
    expiresAt: now + PREVIEW_DRAFT_TTL_MS,
    bytes
  };

  state.drafts.set(key, draft);
  return { ok: true, draft };
}

/**
 * The draft for one editor's preview of one page, or null.
 *
 * Null means "render the saved page and say so" — never "render nothing". Expiry is checked on READ
 * as well as swept on write, because a sweep is periodic and a draft one second past its TTL must not
 * be honoured merely because nobody has written since.
 */
export function readPreviewDraft(pageId: string, editorId: string): PreviewDraft | null {
  if (!pageId || !editorId) return null;

  const key = draftKey(pageId, editorId);
  const draft = state.drafts.get(key);
  if (!draft) return null;

  if (draft.expiresAt <= Date.now()) {
    state.drafts.delete(key);
    return null;
  }

  return draft;
}

/**
 * Forget one editor's draft. Answers whether there was one, so a caller can log honestly.
 *
 * Called when the editor turns live preview off. It is NOT called when they close the tab: a DELETE
 * cannot be sent from an unload handler — `navigator.sendBeacon` only issues POSTs, and a `fetch` in
 * `beforeunload` is not guaranteed to be flushed — so the TTL, not the client, is what makes a draft
 * go away in the ordinary case.
 */
export function clearPreviewDraft(pageId: string, editorId: string): boolean {
  return state.drafts.delete(draftKey(pageId, editorId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering a draft as if it were the page
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewDraftSectionsResult {
  /** In draft order, renumbered densely from 0 — exactly the shape `SectionRenderer` expects. */
  sections: PageSection[];
  /**
   * Draft blocks that could not be turned into a row at all. Zero in every ordinary case; a non-zero
   * value MUST be stated on screen (contract §1.6) rather than shown as a shorter page.
   */
  unmatched: number;
}

/**
 * Turn a stored draft into the `PageSection[]` a page render consumes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A MERGE RATHER THAN A CONSTRUCTION. `PageSection` carries columns the draft has no
 * business inventing — `pageId`, `createdAt`, `updatedAt`. Every block in a draft already exists in
 * the database, because the builder creates a block with its own immediate request and only then
 * starts editing it, so the saved row is almost always there to merge onto and the four fields an
 * editor can change (`label`, `data`, `isVisible`, and the order) are the four this overwrites.
 *
 * The remaining case is a block created in the fraction of a second between the create request
 * landing and the preview reading. It is given the FIRST saved row as a template, so its `pageId` is
 * right and its timestamps are somebody else's. No renderer reads a section's timestamps — they are
 * not part of any block's output — and the alternative is to drop the block, which would preview a
 * page that is not the page. If there is no saved row at all to borrow from, the block is counted in
 * `unmatched` and the caller says so.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function previewDraftSections(
  saved: readonly PageSection[],
  draft: PreviewDraft
): PreviewDraftSectionsResult {
  const savedById = new Map(saved.map((row) => [row.id, row]));
  // `noUncheckedIndexedAccess` is on, so this is `PageSection | undefined` and is checked below.
  const template = saved[0];

  const ordered = [...draft.sections].sort((a, b) => a.position - b.position);

  const sections: PageSection[] = [];
  let unmatched = 0;

  for (const entry of ordered) {
    const base = savedById.get(entry.id) ?? template;
    if (!base) {
      unmatched += 1;
      continue;
    }

    sections.push({
      ...base,
      id: entry.id,
      type: entry.type,
      // Renumbered from the draft's own order rather than copied, so the preview is dense and 0-based
      // even while a reorder is still in flight to the database.
      position: sections.length,
      label: entry.label,
      // The one cast in this module. `data` is `unknown` on the wire because it is a JSON column and
      // nothing may assume its shape; the route has already parsed it against the schema for its type,
      // which is the only guarantee `Prisma.JsonValue` was ever going to carry.
      data: entry.data as Prisma.JsonValue,
      isVisible: entry.isVisible
    });
  }

  return { sections, unmatched };
}

/**
 * What the studio's diagnostics panel can print about this store, in the same shape and the same
 * plain words `rateLimitStoreInfo()` uses — an administrator reads it, so "in-memory (per instance)"
 * rather than a class name.
 */
export function previewDraftStoreInfo(): { name: string; shared: boolean; drafts: number } {
  return { name: "in-memory (per instance)", shared: false, drafts: state.drafts.size };
}
