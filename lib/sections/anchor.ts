import { slugify } from "@/lib/utils";

/**
 * Named anchors for page sections.
 *
 * WHY THIS IS A SEPARATE CONCERN. A section needs to be linkable — `/about#history` is exactly how a
 * navigation menu points at a passage rather than a page, and the shipped default menu in
 * `lib/navigation.ts` does precisely that. But an anchor is not part of any section's CONTENT: it is
 * addressing, and it applies identically to EVERY block type. Adding an `anchor` field to each of the
 * thirty Zod schemas would be thirty chances to forget one, and the failure mode of
 * forgetting is a menu entry that scrolls nowhere.
 *
 * So the anchor lives OUTSIDE the validated payload, in `PageSection.label`'s sibling position — read
 * off the raw `data` object by `sectionAnchor()` below, before validation strips it. Two consequences,
 * both deliberate:
 *
 *   • A schema that does not know about `anchor` cannot reject it. `z.object()` strips unknown keys
 *     rather than failing, so an anchor on any block type is always safe to store.
 *   • The renderer reads it from the RAW row, not from the parsed payload, so a block whose content
 *     fails validation is still reachable by its anchor. A link that works and a block that shows an
 *     editor an error is strictly better than a link that 404s inside the page.
 *
 * ⚠ An anchor is NOT a slug and must not be built with `slugify` alone at read time — an anchor an
 * editor typed must survive verbatim, because it is already quoted in a menu entry and possibly in an
 * email. `normaliseAnchor` only cleans what cannot be an id at all.
 *
 * ⚠ THE PRICE OF LIVING OUTSIDE THE SCHEMA is that every writer has to put the anchor back. Stripping
 * is silent by design, so a save that writes the parsed payload straight into the row DELETES the
 * anchor and nothing complains. `mergeSectionData()` below is the one implementation of "put it back",
 * and it belongs here rather than in the studio because the studio is not the only writer: the block
 * save handlers behind it write the same parsed payload to the same column.
 *
 * ⚠ NO STUDIO SURFACE CREATES AN ANCHOR YET. `suggestAnchor` has no caller, and the block settings
 * panel has no field for an address on the page, so today's anchors come from `prisma/seed.ts` and
 * from imports — including the three the shipped default menu in `lib/navigation.ts` points at. That
 * is precisely why the preservation below matters more than it looks: an anchor that is lost cannot be
 * typed back in.
 */

/**
 * Clean a user-typed anchor into something usable as an HTML `id` and a URL fragment.
 *
 * An `id` may not contain whitespace, and a fragment containing `#` or `%` needs encoding that would
 * make the link unreadable. Beyond that the value is left alone: mixed case and underscores are
 * legitimate and an editor who typed them chose them.
 *
 * Returns null for anything that cannot be an anchor at all, so a caller never has to guard.
 */
export function normaliseAnchor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^#/, "");
  if (!trimmed) return null;

  const cleaned = trimmed.replace(/[\s#?%/\\"'<>&]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!cleaned) return null;

  // An id starting with a digit is legal in HTML5 but breaks a bare CSS `#1history` selector, which
  // is the form anybody debugging this will reach for first. Prefixing is cheaper than the surprise.
  const safe = /^[0-9]/.test(cleaned) ? `s-${cleaned}` : cleaned;
  return safe.slice(0, 64);
}

/**
 * The anchor for a section row, read from its raw `data` object.
 *
 * Takes the row's `data` as `unknown` because that is genuinely what a `Json` column is, and because
 * this must work on a payload that has NOT been validated — see the note above about a broken block
 * staying reachable.
 */
export function sectionAnchor(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  return normaliseAnchor((data as { anchor?: unknown }).anchor);
}

/**
 * Fold a validated payload back into the `data` that still carries the block's anchor.
 *
 * ⚠ CALL THIS INSTEAD OF WRITING A PARSED PAYLOAD STRAIGHT BACK — in the studio's autosave and in the
 * handlers that persist it. `parseSectionData()` runs the payload through a `z.object()`, which strips
 * the anchor along with every other key no schema knows about, so a save that stores the parsed result
 * unmerged deletes the anchor the first time anybody edits any field on the block, and every menu
 * entry pointing at `/about#history` quietly stops working.
 *
 * The stripping itself is right: junk left by an older editor is meant to be cleaned on every save.
 * The anchor is the single exception, so it is the single thing carried over.
 *
 * `raw` is whichever object still holds the anchor — the incoming payload when the caller sent one,
 * the stored row when it did not. The value is carried VERBATIM rather than through
 * `normaliseAnchor`: cleaning it here would rewrite an anchor an editor chose, on a save that never
 * mentioned it, and every link already quoting the old spelling would break. Cleaning happens at read
 * time in `sectionAnchor()`, where it costs nothing.
 */
export function mergeSectionData(raw: unknown, next: unknown): Record<string, unknown> {
  const merged: Record<string, unknown> =
    typeof next === "object" && next !== null && !Array.isArray(next)
      ? { ...(next as Record<string, unknown>) }
      : {};

  const anchor =
    typeof raw === "object" && raw !== null ? (raw as { anchor?: unknown }).anchor : undefined;
  if (typeof anchor === "string" && anchor.trim().length > 0) merged.anchor = anchor;

  return merged;
}

/**
 * A suggested anchor for a section that has none, derived from its heading.
 *
 * Meant for a studio field that offers a default — it is a SUGGESTION the editor confirms, never
 * applied silently. An anchor that changed itself whenever a heading was reworded would break every
 * link to it, which is the whole hazard this module exists to avoid.
 *
 * ⚠ NOTHING CALLS THIS YET. The block settings panel has no "address on the page" field, so this is
 * the confirmable default waiting for the control that will offer it. Kept rather than deleted because
 * the control is the missing half of the feature the default menu already depends on — see the header.
 */
export function suggestAnchor(heading: unknown): string | null {
  if (typeof heading !== "string" || !heading.trim()) return null;
  const slug = slugify(heading);
  return slug ? slug.slice(0, 64) : null;
}
