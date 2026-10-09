"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch, asApiClientError, type ApiClientError } from "@/lib/client/fetcher";

/**
 * The three hooks every interactive studio screen is built from: read a list, write a change,
 * debounce a filter.
 *
 * Two decisions run through all of them and are worth stating once:
 *
 * 1. **`null` means "not loaded yet". `[]` means "there is nothing here".** Contract §9 makes these
 *    separate screens — "Loading…" and an empty state with a "New page" button — because rendering
 *    "No publications" during a fetch tells a researcher their work has vanished. `data` therefore
 *    starts `null` and only ever becomes `[]` because the server said so.
 *
 * 2. **A GENERATION COUNTER is the only race protection needed.** Every request takes the next
 *    number; when its answer arrives, an answer whose number is not the current one is dropped. The
 *    request is not aborted — an abort races the network and cannot be relied on, and the bug being
 *    prevented is not "wasted bytes", it is "the slow answer to the old query overwrote the fast
 *    answer to the new one". Ignoring the late answer fixes that completely, and the same counter
 *    doubles as the unmount guard.
 */

export interface UseResourceOptions<T> {
  /**
   * Seed the hook with data that is already known — typically handed down from a Server Component
   * that rendered the first page. Supplying it asserts the resource IS loaded, so the first paint
   * skips "Loading…".
   */
  initialData?: T;
  onSuccess?: (data: T) => void;
  onError?: (error: ApiClientError) => void;
}

export interface UseResourceResult<T> {
  /** `null` until the first answer arrives. Never `null` again afterwards unless `setData` says so. */
  data: T | null;
  error: ApiClientError | null;
  isLoading: boolean;
  /** Re-fetch the current path. Resolves when the state has settled, so a caller may `await` it after a mutation. */
  refresh: () => Promise<void>;
  /** Write the cache directly, for an optimistic edit. Retires any read already in flight — see below. */
  setData: Dispatch<SetStateAction<T | null>>;
}

/**
 * Fetch a JSON resource and keep it in component state.
 *
 * Pass `null` as the path to SUSPEND fetching — for a dependent query whose key is not ready yet
 * (`selectedProjectId ? \`/api/studio/projects/${selectedProjectId}/members\` : null`). While the
 * path is null, `data` and `error` are null and `isLoading` is false: nothing is loading and nothing
 * will, and the screen showing it must decide for itself what "not asked yet" looks like. Results
 * held from a previous key are cleared, because attributing one query's answer to another key is
 * worse than showing nothing.
 *
 * The path is the cache key. Build it with `buildQuery` so that two states of the filter bar that
 * mean the same thing produce the same string and do not re-fetch.
 */
export function useResource<T>(
  path: string | null,
  options: UseResourceOptions<T> = {}
): UseResourceResult<T> {
  const [data, setDataState] = useState<T | null>(options.initialData ?? null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(
    path !== null && options.initialData === undefined
  );

  /**
   * THE KEY THE STATE ABOVE DESCRIBES, and the adjustment made the moment it changes — DURING RENDER.
   *
   * A new path means a new question, so the render that first sees it already says "loading" and has
   * dropped the previous failure: leaving the old error on screen while the new request runs makes it
   * look as though nothing was asked. No path at all means nothing is loading and nothing will, and the
   * previous key's answer is cleared, because attributing one query's answer to another key is worse
   * than showing nothing. (Between two real paths the old rows stay up until the new ones land — a
   * filter change must not blank a list that is about to be replaced.)
   *
   * Done here rather than at the start of the effect that fetches, which is where it used to be: state
   * set synchronously in an effect is a second render of a frame the reader has already been shown,
   * and for one commit every screen saw the new key with the old key's `isLoading` and `error`.
   */
  const [shownPath, setShownPath] = useState(path);
  if (path !== shownPath) {
    setShownPath(path);
    setError(null);
    if (path === null) {
      setDataState(null);
      setIsLoading(false);
    } else {
      setIsLoading(true);
    }
  }

  const generation = useRef(0);

  // The callbacks live in a ref, refreshed after every commit. Depending on them directly would
  // restart the fetch on every render, because `onSuccess={(rows) => …}` is a new function each
  // time — an infinite fetch loop that looks like a working screen until you open the network tab.
  const latestOptions = useRef(options);
  useEffect(() => {
    latestOptions.current = options;
  });

  /**
   * Ask `target` and settle the state when it answers — and ONLY when it answers.
   *
   * It touches no state before the request is on the wire: whoever calls it has already said
   * "loading" (the render-time adjustment above for a new path, `refresh` for the same one). The
   * answer is written in the promise's callbacks, so the effect below can start a request without
   * setting state synchronously.
   */
  const request = useCallback((target: string): Promise<void> => {
    const mine = generation.current + 1;
    generation.current = mine;

    return apiFetch<T>(target).then(
      (result) => {
        if (generation.current !== mine) return;
        setDataState(result);
        setIsLoading(false);
        latestOptions.current.onSuccess?.(result);
      },
      (thrown: unknown) => {
        if (generation.current !== mine) return;
        const failure = asApiClientError(thrown);
        setError(failure);
        setIsLoading(false);
        // `data` is deliberately left alone. A failed refresh of a list that is already on screen
        // should show an error beside the list, not replace a working page with an empty one.
        latestOptions.current.onError?.(failure);
      }
    );
  }, []);

  useEffect(() => {
    if (path === null) {
      // Whatever was in flight answers a question nobody is asking any more.
      generation.current += 1;
      return;
    }

    void request(path);

    return () => {
      // Bumping on cleanup covers both a path change and an unmount: whichever happened, the answer
      // now in flight belongs to a question nobody is asking, and it drops itself when it arrives.
      generation.current += 1;
    };
  }, [path, request]);

  const refresh = useCallback(async (): Promise<void> => {
    if (path === null) return;
    setIsLoading(true);
    // Clear a previous failure at the START of the attempt: leaving the old error on screen while
    // the retry runs makes the retry look like it did nothing.
    setError(null);
    await request(path);
  }, [path, request]);

  const setData = useCallback<Dispatch<SetStateAction<T | null>>>((value) => {
    // A manual write is newer than any read already in flight, so that read is retired. Without
    // this, an optimistic reorder would be silently undone a moment later by the answer to a
    // request issued before the drag. `isLoading` is cleared here because the request that would
    // otherwise have cleared it is no longer allowed to touch state.
    generation.current += 1;
    setDataState(value);
    setIsLoading(false);
  }, []);

  return { data, error, isLoading, refresh, setData };
}

export interface UseMutationResult<TInput, TOutput> {
  /** Resolves to the result, or to `null` if it failed. Never rejects — see below. */
  mutate: (input: TInput) => Promise<TOutput | null>;
  isPending: boolean;
  error: ApiClientError | null;
  /**
   * The per-field half of a 422, separate from `error` so a form can attach each message to its own
   * control while the banner shows the sentence. `null` when the failure was not a validation one.
   */
  fieldErrors: Record<string, string[]> | null;
  reset: () => void;
}

/**
 * Run a write and track its state.
 *
 * `mutate` RESOLVES WITH `null` ON FAILURE rather than rejecting. A submit handler is an event
 * handler: a rejection from one that forgot its `try`/`catch` becomes an unhandled rejection in the
 * console and nothing at all on screen, which is the worst possible outcome for a save. The error is
 * in `error` and `fieldErrors` either way.
 *
 * (A mutation whose own successful result is `null` cannot be told apart from a failure by the
 * return value alone — check `error` in that case.)
 *
 *   const save = useMutation((input: PageInput) => patch<Page>(`/api/studio/pages/${id}`, input));
 *   const saved = await save.mutate(values);
 *   if (saved) refresh();
 */
export function useMutation<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>
): UseMutationResult<TInput, TOutput> {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);

  // Same generation trick as `useResource`: two rapid saves must leave the SECOND one's outcome on
  // screen, not whichever server happened to answer last.
  const generation = useRef(0);

  const mounted = useRef(true);
  useEffect(() => {
    // Assigned on mount as well as cleared on unmount, so a StrictMode double-mount in development
    // does not leave the hook permanently believing it is gone.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Kept in a ref for the same reason as the resource callbacks: an inline arrow would otherwise
  // change `mutate`'s identity on every render and defeat any memoised child that receives it.
  const latestFn = useRef(fn);
  useEffect(() => {
    latestFn.current = fn;
  });

  const mutate = useCallback(async (input: TInput): Promise<TOutput | null> => {
    const mine = generation.current + 1;
    generation.current = mine;
    setIsPending(true);
    setError(null);
    setFieldErrors(null);

    try {
      const result = await latestFn.current(input);
      if (mounted.current && generation.current === mine) setIsPending(false);
      return result;
    } catch (thrown) {
      const failure = asApiClientError(thrown);
      if (mounted.current && generation.current === mine) {
        setError(failure);
        setFieldErrors(failure.fieldErrors ?? null);
        setIsPending(false);
      }
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    // Retire anything in flight too, so a failure from the attempt being abandoned cannot repaint
    // errors onto a form the reader has just cleared.
    generation.current += 1;
    setIsPending(false);
    setError(null);
    setFieldErrors(null);
  }, []);

  return { mutate, isPending, error, fieldErrors, reset };
}

/**
 * Delay a value until it has stopped changing for `ms`.
 *
 * DEBOUNCE THE COMPOSED PATH, NOT THE TEXT BOX. Passing the finished query string —
 * `\`/api/studio/people${buildQuery({ q, kind, page })}\`` — through this hook and into
 * `useResource` puts the typed search and the clicked filter on ONE timer. Debouncing only the text
 * while the filter fires immediately means two overlapping requests whose order is decided by the
 * server, which is precisely the race the generation counter then has to clean up after.
 *
 * ⚠ Debounce a STRING (or another primitive). An object or array is a new identity on every render,
 * so the timer resets every render and the value never settles.
 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  // No delay at all: the value IS the debounced value, from the render that receives it. The stored
  // copy is kept level during render (not in the effect), so that if a delay is asked for later the
  // timer starts from the latest value rather than from whatever was current before the delay ended.
  if (ms <= 0 && !Object.is(debounced, value)) setDebounced(value);

  useEffect(() => {
    if (ms <= 0) return;
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);

  return ms <= 0 ? value : debounced;
}
