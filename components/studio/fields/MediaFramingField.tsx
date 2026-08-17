"use client";

/**
 * MediaFramingField — choose a picture, then optionally frame it per screen size.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE TWO CONTROLS ARE ONE COMPONENT. Ten blocks let an editor choose a picture, and every one of
 * them can now be framed per screen size. Wiring that as two separate controls at each site meant ten
 * copies of the same ten lines — the picker, the panel, the two `update()` calls, and the rule that
 * changing the PICTURE has to clear the framing. Ten copies of a rule is nine chances to forget it.
 *
 * ⚠ AND THAT RULE IS THE WHOLE REASON THIS IS NOT JUST TIDINESS. A framing is a set of rectangles
 * expressed as fractions of ONE photograph, plus possibly alternates chosen to go with it. Swap the
 * photograph underneath and every one of those rectangles now frames whatever happens to sit at those
 * coordinates — a doorway instead of a face — and the editor gets a hero that looks deliberately wrong
 * with no clue why. So a change of picture clears the framing here, once, for every caller.
 *
 * The panel is only offered once a picture exists, because framing nothing is a control with nothing to
 * act on, and it collapses to a sentence saying so rather than to an empty box.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { EntityPicker } from "@/components/studio/fields/EntityPicker";
import { ScreenFramingPanel } from "@/components/studio/fields/ScreenFramingPanel";
import type { ScreenFraming } from "@/lib/media/screens";

export interface MediaFramingFieldProps {
  /** The picker's own label, e.g. "Picture". */
  label: string;
  /** The picker's help sentence — read off the schema by the caller, never retyped. */
  help?: string;
  /** The framing panel's label. Defaults to the wording used on the hero. */
  framingLabel?: string;
  framingHelp?: string;
  mediaId: string;
  framing: ScreenFraming | null;
  /**
   * Both values, always together.
   *
   * ONE callback rather than two, so a caller cannot patch the picture without patching the framing —
   * which is the mistake this component exists to make impossible. Callers spread it into one `update()`.
   */
  onChange: (next: { mediaId: string; framing: ScreenFraming | null }) => void;
  /**
   * Set false where the block will not draw the picture as an image — a video background, an
   * arrangement that parks the picture. Framing something the block is not drawing is a control with no
   * visible effect, which is how an editor comes to believe it is broken.
   */
  offerFraming?: boolean;
}

export function MediaFramingField({
  label,
  help,
  framingLabel = "Framing per screen size",
  framingHelp,
  mediaId,
  framing,
  onChange,
  offerFraming = true
}: MediaFramingFieldProps) {
  return (
    <div className="space-y-3">
      <EntityPicker
        kind="media"
        max={1}
        label={label}
        help={help}
        ids={mediaId.length > 0 ? [mediaId] : []}
        onChange={(next) => {
          const chosen = next[0] ?? "";
          // A different photograph invalidates every rectangle drawn on the old one — see the header.
          onChange({ mediaId: chosen, framing: chosen === mediaId ? framing : null });
        }}
      />

      {offerFraming && mediaId.length > 0 ? (
        <ScreenFramingPanel
          label={framingLabel}
          help={framingHelp}
          mediaId={mediaId}
          value={framing}
          onChange={(next) => onChange({ mediaId, framing: next })}
        />
      ) : null}
    </div>
  );
}
