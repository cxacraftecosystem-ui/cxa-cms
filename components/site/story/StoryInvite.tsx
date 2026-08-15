"use client";

/**
 * StoryInvite — the gold invitation in the hero that opens the cinematic story.
 *
 * THE STORY'S CODE IS NOT IN THE PAGE UNTIL SOMEBODY REACHES FOR IT. `CinematicStory` and both
 * scene files are behind a dynamic `import()` — the same rule the GSAP runtime follows — so a
 * reader who never presses this pays nothing for fifteen scenes of choreography. Hover or focus
 * warms the chunk (ChartMate's `onPrefetchStory` move, which its hero documents as the difference
 * between a press that opens and a press that buys seconds of nothing); the press itself awaits
 * the same memoised promise, so the warm-up and the open can never race each other.
 *
 * A PLAY GLYPH AND A SPOKEN DURATION. The circled triangle says "this is a watching thing, not a
 * navigation" before a word is read, and the spoken duration is the honest contract for the
 * reader's time — an unlabelled cinematic is the kind of surprise people close on reflex.
 * ⚠ "A minute and a half" is COUPLED to the SCENES table in CinematicStory.tsx (~97s timed + a
 * held ending); the review caught the first draft promising 90 seconds over a 100-second table.
 * Retime the scenes and this label moves with them.
 *
 * FOCUS COMES BACK HERE. `CinematicStory` records `document.activeElement` on mount and restores
 * it when the lights come up; because the press leaves focus on this button, the reader lands
 * exactly where they left. Nothing here needs to manage that half.
 *
 * `useReducedMotionPreference` is deliberately NOT consulted for whether to render the invitation:
 * the story plays under reduced motion (as timed fades — see CinematicStory's header), so hiding
 * its door would be withholding content, not honouring a preference.
 */

import { useCallback, useRef, useState, type ComponentType } from "react";
import { Play } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CinematicStoryProps } from "@/components/site/story/CinematicStory";

type StoryModule = { default: ComponentType<CinematicStoryProps> };

export function StoryInvite({ className }: { className?: string }) {
  const [Story, setStory] = useState<ComponentType<CinematicStoryProps> | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * One promise for the chunk, whoever asks first. A second hover or a fast double-press joins the
   * same request instead of starting another.
   *
   * ⚠ A REJECTION IS EVICTED, NOT MEMOISED. `??=` caches whatever lands in the slot, and a rejected
   * promise is not nullish — so without the `.catch` below, one failed fetch (the classic case: a
   * reader whose tab predates a redeploy, which is exactly a first-time visitor pressing this)
   * would deaden the button for the life of the page, every later press re-awaiting the same old
   * rejection. Clearing the slot lets the next hover or press try the network again.
   */
  const chunkRef = useRef<Promise<StoryModule> | null>(null);
  const warm = useCallback(() => {
    if (!chunkRef.current) {
      chunkRef.current = import("@/components/site/story/CinematicStory");
      chunkRef.current.catch(() => {
        chunkRef.current = null;
      });
    }
    return chunkRef.current;
  }, []);

  const openStory = useCallback(async () => {
    try {
      const loaded = await warm();
      // Set both in one commit: mounting the component and raising the curtain are one action, and
      // a state where `open` is true with no component would render nothing and read as a dead
      // button.
      setStory(() => loaded.default);
      setOpen(true);
      setFailed(false);
    } catch {
      // Say so on screen — a press that silently does nothing reads as a broken site, and the
      // whole point of evicting the rejection above is that trying again can genuinely work.
      setFailed(true);
    }
  }, [warm]);

  return (
    <div className={className}>
      <button
        type="button"
        onMouseEnter={() => void warm()}
        onFocus={() => void warm()}
        onClick={() => void openStory()}
        className="group inline-flex min-h-11 items-center gap-2.5 font-display text-base font-bold tracking-tight text-gold-300 transition-opacity hover:opacity-100 focus-visible:!outline-logo-cream"
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-full border border-gold-300/40 bg-gold-300/10",
            "transition group-hover:border-gold-300/70 group-hover:bg-gold-300/20"
          )}
        >
          <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />
        </span>
        Watch the story of the Centre
        <span className="text-sm font-medium text-white/50">a minute and a half</span>
      </button>

      {failed ? (
        <p className="mt-2 text-sm text-white/60" role="status">
          The story could not load just now — check the connection and press it again.
        </p>
      ) : null}

      {open && Story ? <Story onComplete={() => setOpen(false)} /> : null}
    </div>
  );
}
