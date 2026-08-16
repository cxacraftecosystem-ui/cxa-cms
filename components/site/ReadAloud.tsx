"use client";

/**
 * ReadAloud — the article, spoken, for a reader who would rather listen to it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS AND WHY IT IS THE HALF OF THE WEB SPEECH API THAT WAS MISSING.
 *
 * `components/sections/story/AiOrb.tsx` already uses the RECOGNITION half — it listens, and mirrors
 * the reader's words back under the shader orb. Nothing on this site had ever used the SYNTHESIS
 * half, so an archive whose whole point is long-form writing about craft — a kani shawl described
 * over two thousand words — offered no way to hear any of it. That is the gap this component fills,
 * and it is deliberately fitted to the long-form wrapper (`ProseArticle`) rather than to a page: news,
 * people, projects, research, events and craft records all set their prose through that one
 * component, so wiring it there gives every long piece on the site a voice in one edit.
 *
 * ⚠ THE SOURCE TEXT IS READ OUT OF THE RENDERED DOM, NOT PASSED IN AS A PROP, AND THAT IS THE ONE
 * STRUCTURAL DECISION HERE. `ProseArticle` has two sources — a Tiptap document and MDX (see its
 * header) — and neither is plain text: the Tiptap value is a JSON tree and the MDX is markdown, whose
 * syntax a synthesiser would happily pronounce ("hash hash Method", "star star talim star star").
 * Extracting text server-side would therefore mean a second, source-specific extractor per branch,
 * both free to disagree with what the reader can actually see. The DOM is the one place where the two
 * branches have already become the same thing, and it is also exactly what is on screen — which is
 * the definition of "read this page aloud".
 *
 * The element is found through two data attributes rather than an id: `data-read-aloud-scope` on the
 * article's column and `data-read-aloud-source` on its document box. An id would have to be unique,
 * which means generated, which a Server Component cannot do stably across a prerender; `closest()`
 * from this component's own host walks up to the column it was rendered into, so two articles on one
 * page could never read each other's text.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IT RENDERS NOTHING UNTIL IT KNOWS IT WORKS — NEVER A DEAD BUTTON.
 *
 * `window.speechSynthesis` is absent in some browsers and in most in-app webviews, and the server
 * cannot know which one is on the other end. So the first paint (server and first client render alike)
 * is an empty host element, and the controls appear only after a mount effect has confirmed BOTH that
 * the API exists and that there is enough prose to be worth listening to. A prerendered page must not
 * branch its first paint on anything the server cannot know (contract §8), and a control that does
 * nothing when pressed is worse than an absent one.
 *
 * ⚠ CANCEL ON UNMOUNT AND ON NAVIGATION. THIS IS THE MOST IMPORTANT LINE IN THE FILE.
 *
 * `speechSynthesis` is a GLOBAL SINGLETON owned by the browser, not by this component and not by this
 * document. Leave it speaking and it keeps speaking: a reader who starts an article on kani weaving,
 * navigates to another, and finds the new page narrated by the old one has been handed a bug that
 * looks like a haunting. Two paths cover the two ways a page can go away — the effect cleanup (a
 * client-side route change unmounts this component) and a `pagehide` listener (a full document unload
 * or a move into the back/forward cache, neither of which runs a React cleanup). Both call `cancel()`.
 *
 * ⚠ REDUCED MOTION IS NOT REDUCED SOUND. `useReducedMotionPreference()` gates the pulsing dot below
 * and NOTHING ELSE. Someone who has asked the interface to stop moving has said nothing whatsoever
 * about whether they want an article read to them — and for a reader using reduction because motion
 * makes reading painful, being read to is arguably the point. Gating the feature itself on it would
 * take the accessibility affordance away from the readers most likely to want it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Headphones, Pause, Play, Square } from "lucide-react";

import { DURATION, EASE_OUT } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/ToastProvider";
import { cn } from "@/lib/utils";

export interface ReadAloudProps {
  /** Names the group of controls, for anything reading the tree — "Listen to this article". */
  label?: string;
  /**
   * Below this many characters of extracted prose, nothing renders at all.
   *
   * A "read this page aloud" control above three sentences is furniture: pressing it costs more
   * attention than reading the words. 600 characters is roughly a hundred words, or about forty
   * seconds of speech, which is the point at which listening starts to be a real alternative.
   */
  minChars?: number;
  className?: string;
}

/** The article's column and its document box, marked by `ProseArticle`. See the header. */
const SCOPE_ATTRIBUTE = "data-read-aloud-scope";
const SOURCE_ATTRIBUTE = "data-read-aloud-source";

const DEFAULT_MIN_CHARS = 600;

/**
 * The longest string handed to a single utterance.
 *
 * ⚠ THIS IS NOT A TIDINESS LIMIT. Chromium has cut long utterances off mid-sentence at roughly
 * fifteen seconds since 2016 (crbug.com/679437) — the voice simply stops and `onend` never arrives,
 * so an article queued as one utterance is read for a paragraph and then abandoned in silence, with
 * the control still claiming to be reading. Short utterances are what every workaround converges on,
 * and 180 characters is comfortably under the cut at any speaking rate.
 *
 * It buys two other things. `cancel()` is the only granularity the API offers, so short utterances
 * are also what makes Stop feel immediate rather than "at the end of the article"; and a block
 * boundary can be made into an utterance boundary, which is how a heading is stopped from running
 * into the paragraph beneath it.
 */
const MAX_UTTERANCE_CHARS = 180;

/**
 * A sentence, near enough for prosody: everything up to a terminator, plus the terminator and any
 * closing quote or bracket riding on it.
 *
 * ⚠ NO LOOKBEHIND. The obvious spelling of this is `split(/(?<=[.!?…])\s+/)`, and a lookbehind is a
 * SyntaxError at regex-construction time in Safari before 16.4 — thrown at module scope, which takes
 * the whole chunk down rather than degrading. A global match with the terminator inside the match
 * does the same job with no version floor.
 *
 * It splits "Dr. Smith" in two. That costs a listener a breath in the wrong place and costs an
 * abbreviation dictionary to fix, which is not a trade worth making for a reading aid.
 */
const SENTENCE_PATTERN = /[^.!?…]+[.!?…]*["'”’)\]]*\s*/g;

/**
 * What is stripped before the words are spoken, and why each one is not content.
 *
 *  • `[aria-hidden="true"]` — decoration, declared by its own author as having nothing to say.
 *  • `.sr-only` — a duplicate channel, not a second voice. `LinkButton` and `MdxLink` write
 *    "(opens in a new tab)" into it; spoken by the article's own narrator that is a sentence the
 *    writer never wrote, and the person it was written for is not using this button.
 *  • `script`, `style` — `textContent` includes both, and a stylesheet read aloud is exactly as bad
 *    as it sounds.
 *
 * Nothing else is removed. A code block or a table cell is read as it stands, because prose the
 * reader can see and the narrator skips is content that has gone missing with nothing said about it
 * (contract §1.6).
 */
const UNSPOKEN_SELECTOR = '[aria-hidden="true"], .sr-only, script, style';

/** The block elements whose end is a pause. Anything not listed simply flows into its neighbour. */
const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, tr, div, pre";

type Mode = "idle" | "playing" | "paused";

/** The document box this control was rendered beside, or null if the caller did not mark one. */
function findSource(host: HTMLElement | null): HTMLElement | null {
  const scope = host?.closest(`[${SCOPE_ATTRIBUTE}]`) ?? null;
  const source = scope?.querySelector(`[${SOURCE_ATTRIBUTE}]`) ?? null;
  return source instanceof HTMLElement ? source : null;
}

/**
 * The prose as a synthesiser should receive it.
 *
 * ⚠ IT WORKS ON A CLONE, and the clone is not an optimisation — `UNSPOKEN_SELECTOR` removes nodes,
 * and removing them from the live document would delete the reader's article in front of them.
 *
 * ⚠ AND IT APPENDS A NEWLINE TO EVERY BLOCK. `textContent` has no concept of a box: without this,
 * a heading and the paragraph under it arrive as "…the loom followsTalim is", which is one
 * unpronounceable word. `innerText` would insert the breaks on its own, but only for an element that
 * is being laid out — it also drags `.sr-only` back in, because clipped text is still rendered text.
 */
function readableText(source: HTMLElement): string {
  const clone = source.cloneNode(true) as HTMLElement;

  for (const node of Array.from(clone.querySelectorAll(UNSPOKEN_SELECTOR))) {
    node.remove();
  }
  for (const block of Array.from(clone.querySelectorAll(BLOCK_SELECTOR))) {
    block.appendChild(clone.ownerDocument.createTextNode("\n"));
  }

  return (clone.textContent ?? "")
    // Horizontal whitespace collapses; newlines survive, because they are the block boundaries just
    // written and the chunker reads them as pauses.
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** A sentence longer than one utterance, cut at the last space that fits. */
function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_UTTERANCE_CHARS) return [sentence];

  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > MAX_UTTERANCE_CHARS) {
    const head = rest.slice(0, MAX_UTTERANCE_CHARS);
    const space = head.lastIndexOf(" ");
    // `space > 0` rather than `!== -1`: a leading space would cut nothing off and loop forever.
    const cut = space > 0 ? space : MAX_UTTERANCE_CHARS;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * The article, cut into utterances — sentences packed up to the limit, never across a block boundary.
 *
 * The block boundary is why the accumulator is flushed at the end of every line rather than only when
 * it is full: a heading packed into the same utterance as the paragraph below it is read with no pause
 * between them, and a listener loses the structure of the piece entirely.
 */
function toUtterableChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    const block = line.trim();
    if (block.length === 0) continue;

    // `match` is null when the line is nothing but terminators ("…"), which is still a line to read.
    for (const sentence of block.match(SENTENCE_PATTERN) ?? [block]) {
      for (const piece of splitLongSentence(sentence.trim())) {
        if (piece.length === 0) continue;
        if (current.length === 0) current = piece;
        else if (current.length + 1 + piece.length <= MAX_UTTERANCE_CHARS) current = `${current} ${piece}`;
        else {
          chunks.push(current);
          current = piece;
        }
      }
    }

    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function ReadAloud({
  label = "Listen to this article",
  minChars = DEFAULT_MIN_CHARS,
  className
}: ReadAloudProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotionPreference();
  const { toast } = useToast();

  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");

  /**
   * The utterances currently queued.
   *
   * ⚠ IT EXISTS TO KEEP THEM ALIVE, NOT TO INSPECT THEM. Chromium collects a `SpeechSynthesisUtterance`
   * that nothing in JavaScript still references while it is still in the engine's queue, and the
   * symptom is that `onend` never fires — so the control sits on "Pause reading" forever after the
   * article has finished. Holding the array is the fix.
   *
   * It doubles as the identity token every handler checks: `cancel()` fires `onerror` on every
   * utterance it discards, so a play that replaces a queue would otherwise be dragged back to "idle"
   * by the errors belonging to the queue it just replaced.
   */
  const queueRef = useRef<SpeechSynthesisUtterance[] | null>(null);

  /**
   * The engine's voices, kept fresh.
   *
   * ⚠ `getVoices()` IS EMPTY ON ITS FIRST CALL IN CHROMIUM — the list loads asynchronously and the
   * engine announces it with `voiceschanged`. An implementation that reads the list once and then
   * REQUIRES a match from it is silent on a page's first load and works on every reload after, which
   * is the single most common way this API is got wrong.
   *
   * Two things follow, and the second matters more than the first. The list is re-read on the event
   * AND again at the moment of speaking; and a missing voice is NOT a failure — leaving
   * `utterance.voice` unset makes the engine pick its own default for `utterance.lang`, which is the
   * right answer anyway. So the control is never gated on the voice list, and a browser that never
   * fires the event still speaks.
   */
  const voicesRef = useRef<readonly SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;

    const read = () => {
      const voices = synth.getVoices();
      // Never overwrite a list we have with an empty one: Chromium answers with `[]` again while the
      // engine is restarting, and forgetting the voices mid-article would change the narrator.
      if (voices.length > 0) voicesRef.current = voices;
    };

    read();
    synth.addEventListener("voiceschanged", read);
    return () => synth.removeEventListener("voiceschanged", read);
  }, []);

  /**
   * Does this browser speak, and is there enough here to be worth speaking? Answered after mount,
   * never during render — see the header.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const source = findSource(hostRef.current);
    if (!source) {
      // Say so rather than leave a gap (contract §1.6). This is a wiring mistake — a caller that
      // rendered the control without marking the prose — and its only symptom is a control that
      // never appears, which looks exactly like a browser without the API.
      console.warn(
        `[read-aloud] no [${SOURCE_ATTRIBUTE}] element inside the nearest [${SCOPE_ATTRIBUTE}], so the listen control is not rendered.`
      );
      return;
    }

    setReady(readableText(source).length >= minChars);
  }, [minChars]);

  /**
   * ⚠ THE SINGLETON IS SILENCED ON THE WAY OUT, BY BOTH ROUTES. See the header — this is the whole
   * correctness of the feature.
   *
   * Deliberately not gated on `ready` or on `mode`: an effect that only runs once the controls exist
   * is an effect that can be skipped, and `cancel()` on a queue that was never filled costs nothing.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;

    const silence = () => {
      queueRef.current = null;
      synth.cancel();
    };

    // `pagehide` rather than `beforeunload`: it fires for a move into the back/forward cache as well
    // as for a real unload, and `beforeunload` is increasingly ignored on mobile.
    window.addEventListener("pagehide", silence);
    return () => {
      window.removeEventListener("pagehide", silence);
      silence();
    };
  }, []);

  /**
   * Hand focus to the toggle when the control the reader is standing on is about to stop existing.
   *
   * ⚠ STOP IS RENDERED ONLY WHILE THERE IS SOMETHING TO STOP, so EVERY path to "idle" unmounts it —
   * its own press, the last utterance ending, and an error. When the element holding focus is removed
   * the browser drops focus to `<body>`, and the next Tab starts again at the top of the page: a
   * keyboard reader who stopped an article two thirds of the way down loses their place in it, which
   * is a worse thing to happen than the one they pressed the button to get. The toggle is the one
   * control that is always present once the group renders, so it is where focus belongs.
   *
   * ⚠ AND ONLY WHEN THE FOCUS IS GENUINELY OURS TO MOVE. The `activeElement` test is not a
   * precaution, it is the whole design: the natural end of a reading is NOT a user action, so an
   * article that finishes while the reader has moved on to the search field must not yank the caret
   * out of it. The same test is what makes this inert for a mouse user under Safari, which does not
   * focus a button on click — there is no focus to restore, so none is taken.
   */
  const keepFocusInGroup = useCallback(() => {
    // The null test comes first and is not redundant with the one below it: `activeElement` is
    // specified as NULLABLE, and Stop is unmounted for most of this component's life, so comparing
    // the two directly would find `null === null` and move focus in the one case that means "there
    // is no Stop button and nothing was focused" — the case that must do nothing at all.
    if (stopRef.current === null) return;
    if (document.activeElement !== stopRef.current) return;
    toggleRef.current?.focus();
  }, []);

  const stop = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    queueRef.current = null;
    window.speechSynthesis.cancel();
    setMode("idle");
    // Before React commits: the handler has not returned yet, so Stop is still mounted and still the
    // active element. Moving focus after the unmount would be moving it from `<body>`, too late.
    keepFocusInGroup();
  }, [keepFocusInGroup]);

  const play = useCallback(() => {
    const synth = window.speechSynthesis;
    const source = findSource(hostRef.current);
    if (!source) return;

    const text = readableText(source);
    if (text.length === 0) return;

    /*
     * ⚠ `resume()` BEFORE `cancel()`, AND IT IS NOT REDUNDANT. `cancel()` empties the queue but does
     * NOT clear the engine's paused flag in Chromium, so a reader who pauses, presses Stop and then
     * presses Read aloud again gets a queue that is filled and never spoken — a control that looks
     * like it worked and produces silence. Resuming first puts the engine back in a state where
     * `speak()` means speak.
     */
    synth.resume();
    // Null first: the `onerror` that `cancel()` fires on every discarded utterance must not be able
    // to find the queue it is about to be replaced by.
    queueRef.current = null;
    synth.cancel();

    /*
     * The language of the prose, from the document rather than assumed. This site records craft names
     * in Kashmiri, Urdu and Hindi alongside English (see `app/api/studio/crafts/route.ts`, which
     * exists partly because a name in another script read by an English voice is worse than not
     * recording the name at all), so where a page has said what language it is in, the narrator is
     * told.
     */
    const declared = source.closest("[lang]")?.getAttribute("lang")?.trim();
    const lang = declared && declared.length > 0 ? declared : document.documentElement.lang || "en";

    const voices = synth.getVoices();
    // Annotated rather than inferred: the two arms are `SpeechSynthesisVoice[]` and a `readonly`
    // array, and a union of two array types has no callable `.find` as far as TypeScript is concerned.
    const list: readonly SpeechSynthesisVoice[] = voices.length > 0 ? voices : voicesRef.current;
    const base = lang.split("-")[0]?.toLowerCase() ?? "";
    // Exact tag, then the same language in any region, then nothing — and "nothing" is a valid
    // answer that leaves the engine to choose. See `voicesRef`.
    const voice =
      list.find((candidate) => candidate.lang.toLowerCase() === lang.toLowerCase()) ??
      list.find((candidate) => candidate.lang.toLowerCase().startsWith(`${base}-`)) ??
      list.find((candidate) => candidate.lang.toLowerCase() === base);

    const chunks = toUtterableChunks(text);
    if (chunks.length === 0) return;

    const queue = chunks.map((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = lang;
      if (voice) utterance.voice = voice;

      // Only the last one ends the reading; the others merely hand over to the next in the queue.
      if (index === chunks.length - 1) {
        utterance.onend = () => {
          if (queueRef.current !== queue) return;
          queueRef.current = null;
          setMode("idle");
          keepFocusInGroup();
        };
      }

      utterance.onerror = (event) => {
        // ⚠ EVERY PATH THAT CALLS `cancel()` NULLS THE REF FIRST — `play`, `stop` and the unmount
        // `silence` all do — so the identity check below has already swallowed the storm of
        // "interrupted"/"canceled" events a cancellation produces. The error-code test after it is
        // the belt to that pair of braces: an engine that reports a cancellation on a queue we still
        // believe in must not raise a toast telling the reader their own Stop button failed.
        if (queueRef.current !== queue) return;
        queueRef.current = null;
        synth.cancel();
        setMode("idle");
        keepFocusInGroup();
        if (event.error === "interrupted" || event.error === "canceled") return;
        toast({
          tone: "error",
          title: "This article could not be read aloud",
          description: "The browser's voice is unavailable. The text itself is unaffected."
        });
      };

      return utterance;
    });

    queueRef.current = queue;
    for (const utterance of queue) synth.speak(utterance);
    setMode("playing");
  }, [toast, keepFocusInGroup]);

  /*
   * ⚠ NOTHING IS AWAITED BETWEEN THE CLICK AND `speak()`. Safari only honours the first `speak()` of a
   * document when it runs inside the gesture that caused it, so extracting the text, picking the voice
   * and queueing are all synchronous on purpose. An `await` anywhere above turns this into a button
   * that works everywhere except on an iPhone.
   */
  const toggle = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;

    if (mode === "playing") {
      synth.pause();
      setMode("paused");
      return;
    }
    if (mode === "paused") {
      synth.resume();
      setMode("playing");
      return;
    }
    play();
  }, [mode, play]);

  if (!ready) {
    /*
     * ⚠ THE HOST ELEMENT IS ALWAYS RENDERED, EVEN THOUGH IT IS EMPTY, AND IT IS NOT A PLACEHOLDER.
     * It is the anchor `findSource()` walks up from, and the measurement that decides whether the
     * controls appear at all happens in an effect — which needs the ref to be attached on the FIRST
     * render, before that decision has been taken. It carries no classes of its own, so an empty one
     * is a zero-height block with no margin: the article above and below it does not move.
     */
    return <div ref={hostRef} />;
  }

  const speaking = mode === "playing";
  const toggleIcon = speaking ? Pause : mode === "paused" ? Play : Headphones;
  const toggleLabel = speaking ? "Pause reading" : mode === "paused" ? "Resume reading" : "Read aloud";

  return (
    <div ref={hostRef}>
      <div role="group" aria-label={label} className={cn("flex flex-wrap items-center gap-2", className)}>
        {/*
          ⚠ NO `aria-live` REGION ANYWHERE IN THIS COMPONENT, AND THE REASON IS THAT THERE IS ALREADY
          ONE. `components/ui/Button.tsx` wraps every button's label in `<span aria-live="polite">`, so
          changing this label from "Read aloud" to "Pause reading" IS the announcement — made once, by
          the control the reader just pressed, which is where they are standing. A status line saying
          "Reading aloud" beside it would say the same thing a second time, which is the one thing the
          accessibility contract asks nobody to do.

          `aria-pressed` is wrong here for the same reason it would be wrong on a media player: this is
          not a two-state toggle. Idle, playing and paused are three states, and the label is the only
          thing that can carry three.
        */}
        <Button ref={toggleRef} variant="secondary" icon={toggleIcon} onClick={toggle}>
          {toggleLabel}
        </Button>

        {/*
          Stop appears only when there is something to stop. Its own live region arrives already
          holding its text, which Button.tsx notes is announced inconsistently — that is fine here and
          is in fact what is wanted: the state change was already announced by the toggle above, and a
          second reading of "Stop" would be the duplicate this component is avoiding.

          ⚠ Its `ref` is not decoration: it is the identity `keepFocusInGroup` compares against, which
          is how "the reader is standing on the button that is about to be removed" is told apart from
          "the reading merely finished". See that function.
        */}
        {mode === "idle" ? null : (
          <Button ref={stopRef} variant="ghost" icon={Square} onClick={stop}>
            Stop
          </Button>
        )}

        {/*
          The reading light. Decoration, hence `aria-hidden` — the state it echoes is already in the
          button's label, so this is a second signal for a sighted reader rather than the only one
          (contract §1.4), and it is simply absent while nothing is being spoken.

          ⚠ Under reduced motion the dot is STILL THERE and simply stops breathing. A target of full
          opacity rather than an absent `animate` prop, for the reason ScrollCue gives: dropping the
          prop abandons the element wherever the last frame left it, so a dot mid-fade would be found
          sitting at a quarter opacity and read as disabled. The cycle is composed from the house
          durations — 0.4s down, 0.4s back — rather than a number chosen by eye (contract §8).

          And to say it once more, because it is the trap: `reduce` reaches THIS DOT and nothing else.
          Reduced motion is not reduced sound.
        */}
        {speaking ? (
          <motion.span
            aria-hidden="true"
            className="ml-1 h-2 w-2 shrink-0 rounded-full bg-purple-700"
            animate={{ opacity: reduce ? 1 : 0.25 }}
            transition={
              reduce
                ? { duration: 0 }
                : { duration: DURATION.slide, ease: EASE_OUT, repeat: Infinity, repeatType: "reverse" }
            }
          />
        ) : null}
      </div>
    </div>
  );
}
