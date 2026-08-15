"use client";

/**
 * useAutosave — the autosave engine.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ A PUBLISHED ITEM IS NEVER AUTOSAVED. THIS IS THE MOST IMPORTANT BEHAVIOURAL DECISION IN THE CMS.
 *
 * Autosaving live content means a half-written sentence is on the public site four seconds after
 * somebody starts typing it. Not a draft of it — the actual page a visitor is reading. An editor who
 * opens a published article to fix one word, gets interrupted mid-sentence and closes the laptop has
 * published the interruption.
 *
 * So when `isPublished` is true this hook runs NO timers at all. The reader keeps editing, the form
 * tracks its dirty state exactly as before, and nothing leaves the browser until they choose Save — a
 * deliberate act, made when the sentence is finished. There is no second copy behind a live record:
 * Save writes the same row the public site reads, so the change is on the site the moment it lands,
 * and the notice below says exactly that.
 *
 * SAY SO ON SCREEN. Silence here is worse than either behaviour: an editor who believes their work is
 * being saved and finds it is not has lost it, and an editor who believes it is not being saved and
 * finds it is has published something by accident. `PUBLISHED_AUTOSAVE_NOTICE` is the sentence, so
 * every screen says it the same way. Pass it to `SaveBar`'s `note`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE OTHER FOUR RULES, EACH OF WHICH IS A BUG THAT HAS SHIPPED SOMEWHERE:
 *
 * 1. NEVER TWO SAVES AT ONCE. A second save started while the first is in flight can land out of
 *    order — the server answers them in whatever order it likes — and the older body overwrites the
 *    newer content. The reader watches a sentence they deleted come back. So there is ONE save loop,
 *    held in a ref as a shared promise (the same discipline as `refreshOnce()` in
 *    lib/client/fetcher.ts), and a request arriving while it runs sets a single-slot flag instead. The
 *    loop makes AT MOST ONE follow-up pass, with the data as it is by then, and only if that data is
 *    genuinely newer than what was just sent.
 *
 * 2. DIRTINESS IS A SERIALISED SNAPSHOT COMPARISON, not a flag somebody remembers to set. A studio
 *    form is controlled React state, so it re-renders on every keystroke and its objects are new
 *    identities every time; an identity comparison would call every render a change and autosave four
 *    times a second. Comparing the serialised form means a re-render with identical values is not
 *    dirty, and — the useful half — typing a character and deleting it again leaves the form CLEAN.
 *
 * 3. IT STOPS ON UNMOUNT AND FIRES NOTHING AFTERWARDS. The scheduled timer is cleared by the effect's
 *    cleanup, so no save is ever *started* by a component that has gone. A save already in flight is
 *    deliberately NOT aborted — the whole point of an autosave is that the bytes arrive — but it
 *    touches no state when it resolves. A `setState` into an unmounted tree logs a React warning, and
 *    worse, the failure it was reporting becomes invisible.
 *
 * 4. RETRIES ARE BOUNDED, THEN IT STOPS AND SAYS SO. Backoff doubles from `intervalMs` up to 30
 *    seconds, for `maxRetries` consecutive failures, and then no more automatic attempts are made:
 *    `error` stays populated and `retriesExhausted` is true so the screen can say "Autosave has
 *    stopped trying". An autosave that retries for ever against a 422 burns the battery, fills the
 *    server log, and hides a real problem behind an animation that never stops. An explicit `saveNow()`
 *    resets the counter — a person asking again is a new fact.
 *
 * WHAT THIS HOOK DOES NOT DO: it does not own the data, and it does not undo. "Discard" is the
 * screen's own job — set your form state back to what the server gave you and the snapshot comparison
 * makes the form clean again by itself, with nothing here to tell.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { asApiClientError, type ApiClientError } from "@/lib/client/fetcher";

/** The words every screen uses for a published item. See the header. */
export const PUBLISHED_AUTOSAVE_NOTICE =
  "This record is live. Nothing saves on its own; choosing Save publishes your changes to the site immediately.";

export type AutosaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

/** Why the automatic timer is standing down. `null` means it is running. */
export type AutosavePausedReason = "published" | "disabled";

/** The ceiling on the backoff. Past this, waiting longer only delays the operator noticing. */
const MAX_BACKOFF_MS = 30_000;

/** One in-flight save plus one follow-up. See rule 1. */
const MAX_PASSES = 2;

export interface UseAutosaveOptions<T> {
  /** The form's current state. Anything JSON-serialisable — it is what gets sent. */
  data: T;
  /**
   * Persists it. Resolve for success, throw for failure; the thrown message is surfaced verbatim,
   * because `lib/api.ts` guarantees it is a plain sentence ready to render.
   */
  save: (data: T) => Promise<void>;
  /** Quiet time before an automatic save. Default 4000ms. */
  intervalMs?: number;
  /**
   * Runs the automatic timer. Default true. `false` stops the timer only — `saveNow()` always works,
   * because a reader pressing Save is not the thing this switch is about.
   */
  enabled?: boolean;
  /** ⚠ True when the record is live on the public site. See the header — this is not a detail. */
  isPublished?: boolean;
  /**
   * How the snapshot is taken. Default `JSON.stringify`, which is stable as long as your state
   * object's keys are built in the same order every render (a spread of a fixed shape is). Pass your
   * own if it is not, or to exclude a field whose change should not count as an edit.
   *
   * ⚠ Frozen at mount. A serialiser that changed identity mid-life would redefine what "dirty" means
   * and mark a clean form dirty.
   */
  serialise?: (data: T) => string;
  /** Consecutive failures before automatic saving gives up. Default 3. */
  maxRetries?: number;
  /** After a successful save. Given the snapshot that was SENT, not the data as it is now. */
  onSaved?: (data: T) => void;
  onError?: (error: ApiClientError) => void;
}

export interface UseAutosaveResult {
  status: AutosaveStatus;
  /** When the last successful save landed, by this browser's clock. `null` until one has. */
  lastSavedAt: Date | null;
  /** Save immediately. Resolves true on success. Never rejects, so an onClick needs no try/catch. */
  saveNow: () => Promise<boolean>;
  error: ApiClientError | null;
  isDirty: boolean;
  /** The automatic timer is standing down. `pausedReason` says why. */
  autosavePaused: boolean;
  pausedReason: AutosavePausedReason | null;
  /** Automatic saving has given up after `maxRetries` failures. `saveNow()` still works. */
  retriesExhausted: boolean;
  /**
   * Treat the current data as saved, without saving it. For when the record was persisted by another
   * path — a Publish, a section reorder, a restore — so this hook's baseline moves with it instead of
   * leaving the bar saying "Unsaved changes" about changes that are on the server.
   */
  markSaved: () => void;
}

interface Snapshot<T> {
  data: T;
  serialised: string;
}

function defaultSerialise<T>(value: T): string {
  // Deliberately unguarded. A form whose state cannot be serialised cannot be sent to the server
  // either, so failing here — at the earliest and most obvious point — beats discovering it inside a
  // fetch that reports "[object Object]".
  return JSON.stringify(value);
}

export function useAutosave<T>({
  data,
  save,
  intervalMs = 4000,
  enabled = true,
  isPublished = false,
  serialise,
  maxRetries = 3,
  onSaved,
  onError
}: UseAutosaveOptions<T>): UseAutosaveResult {
  // Frozen at mount — see the option's note.
  const serialiseFn = useRef<(value: T) => string>(serialise ?? defaultSerialise).current;

  const serialised = useMemo(() => serialiseFn(data), [data, serialiseFn]);

  /** The snapshot last known to be on the server. Everything about dirtiness is this one comparison. */
  const [baseline, setBaseline] = useState<string>(() => serialiseFn(data));
  const [phase, setPhase] = useState<"idle" | "saving">("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [failures, setFailures] = useState(0);

  const isDirty = serialised !== baseline;

  const mountedRef = useRef(true);
  useEffect(() => {
    // Set on mount as well as cleared on unmount, so a StrictMode double-mount in development does
    // not leave the hook permanently believing it is gone.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * The current data, and the current callbacks, read by the save loop.
   *
   * Written in an EFFECT, never during render. A render can be discarded under concurrent rendering,
   * and a ref written on a discarded render would leave the loop saving values that never committed —
   * sending the server a state the reader never saw.
   */
  const latestRef = useRef<Snapshot<T> | null>(null);
  const saveRef = useRef(save);
  const callbacksRef = useRef({ onSaved, onError });
  useEffect(() => {
    latestRef.current = { data, serialised };
    saveRef.current = save;
    callbacksRef.current = { onSaved, onError };
  });

  /** The single running save chain, or null. Its presence IS the "busy" flag. */
  const runningRef = useRef<Promise<boolean> | null>(null);
  /** One slot: "another save was asked for while we were busy". */
  const pendingRef = useRef(false);

  /** One request, start to finish, including every state update it is allowed to make. */
  const attempt = useCallback(async (snapshot: Snapshot<T>): Promise<boolean> => {
    setPhase("saving");
    // Clear a previous failure at the START of the attempt: leaving the old error on screen while the
    // retry runs makes the retry look like it did nothing (the same reasoning as useResource).
    setError(null);

    try {
      await saveRef.current(snapshot.data);
    } catch (thrown) {
      const failure = asApiClientError(thrown);
      if (mountedRef.current) {
        setError(failure);
        setFailures((count) => count + 1);
        setPhase("idle");
        callbacksRef.current.onError?.(failure);
      }
      return false;
    }

    if (!mountedRef.current) return true;

    // The baseline is the snapshot that was SENT, not the data as it stands now. The reader may have
    // typed during the request; calling those keystrokes saved would lose them silently — and leaving
    // the form dirty is what makes the follow-up pass below happen.
    setBaseline(snapshot.serialised);
    setLastSavedAt(new Date());
    setFailures(0);
    setPhase("idle");
    callbacksRef.current.onSaved?.(snapshot.data);
    return true;
  }, []);

  /**
   * The save loop. One instance at a time; a caller arriving while it runs joins its outcome.
   *
   * Returning the RUNNING promise rather than starting a second chain is what makes "never two at
   * once" true for `saveNow()` as well as for the timer: a reader pressing Save mid-autosave gets the
   * real answer to their press, not a silent false.
   */
  const pump = useCallback(async (): Promise<boolean> => {
    const running = runningRef.current;
    if (running) {
      pendingRef.current = true;
      return running;
    }

    const chain = (async (): Promise<boolean> => {
      let outcome = false;

      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        pendingRef.current = false;

        const snapshot = latestRef.current;
        if (!snapshot) break;

        outcome = await attempt(snapshot);
        // A failure stops the loop. The backoff effect owns the retry, so hammering here would
        // multiply every outage by MAX_PASSES.
        if (!outcome) break;
        if (!mountedRef.current) break;
        if (!pendingRef.current) break;

        const next = latestRef.current;
        // Nothing newer to send. Saving the same bytes twice is a wasted round trip and a second
        // identical revision in the history.
        if (!next || next.serialised === snapshot.serialised) break;
      }

      return outcome;
    })();

    runningRef.current = chain;
    // Cleared only if it is still the current chain, so a later chain is not wiped by an older one's
    // cleanup.
    void chain.finally(() => {
      if (runningRef.current === chain) runningRef.current = null;
    });

    return chain;
  }, [attempt]);

  const pausedReason: AutosavePausedReason | null = isPublished
    ? "published"
    : !enabled
      ? "disabled"
      : null;
  const retriesExhausted = failures >= Math.max(1, maxRetries);

  /**
   * The timer. Also the debounce: `serialised` is a dependency, so every keystroke tears down the
   * pending timer and starts a new one, and the save happens `intervalMs` after the reader stops.
   *
   * The cleanup is what makes rule 3 true — an unmount clears the timer, so no save is ever started
   * by a component that has gone.
   */
  useEffect(() => {
    if (pausedReason !== null) return;
    if (!isDirty) return;
    if (retriesExhausted) return;

    const delay =
      failures === 0
        ? Math.max(0, intervalMs)
        : Math.min(Math.max(1, intervalMs) * 2 ** failures, MAX_BACKOFF_MS);

    const timer = window.setTimeout(() => {
      void pump();
    }, delay);

    return () => window.clearTimeout(timer);
  }, [pausedReason, isDirty, serialised, failures, retriesExhausted, intervalMs, pump]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    // A person asking again is a new fact: the retry budget starts over.
    setFailures(0);
    return pump();
  }, [pump]);

  const markSaved = useCallback(() => {
    const snapshot = latestRef.current;
    if (!snapshot) return;
    setBaseline(snapshot.serialised);
    setLastSavedAt(new Date());
    setError(null);
    setFailures(0);
  }, []);

  /**
   * Derived, never stored. Two pieces of state that both claim to know whether the form is dirty will
   * eventually disagree, and the one that is wrong is always the one on screen.
   *
   * The order matters: a failure outranks "unsaved", because "Unsaved changes" on a form that just
   * failed to save reads as "nothing has gone wrong yet".
   */
  const status: AutosaveStatus =
    phase === "saving"
      ? "saving"
      : error !== null
        ? "error"
        : isDirty
          ? "dirty"
          : lastSavedAt !== null
            ? "saved"
            : "idle";

  return {
    status,
    lastSavedAt,
    saveNow,
    error,
    isDirty,
    autosavePaused: pausedReason !== null,
    pausedReason,
    retriesExhausted,
    markSaved
  };
}
