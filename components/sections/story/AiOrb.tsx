"use client";

/**
 * AiOrb — the intelligence, given a body: the story's one non-woven presence.
 *
 * The shader orb (components/ui/voice-powered-orb) is the visual for AI in movement V — a ring of
 * violet plasma that turns slowly on its own and, if the reader INVITES it, listens: speech makes
 * it spin and shimmer. The invitation is the whole interaction design — a microphone on a public
 * page is granted, never taken, so the orb mounts deaf and the button below it is the only path
 * to `getUserMedia`.
 *
 * THE LIFECYCLE ECONOMY (the ParticleField rule, applied from outside): the orb runs a rAF loop
 * whenever mounted, so this wrapper (a) lazy-imports the ogl chunk only when the section
 * approaches the viewport, (b) UNMOUNTS the orb entirely when it leaves (rootMargin keeps a
 * buffer so scrolling back is seamless), and (c) never mounts it at all under reduced motion —
 * the resting state is a still dye-gradient disc, which is the design at rest, not a stopped
 * animation (contract §1.4). The takeover signal (lib/takeover) is honoured too: while the modal
 * story covers the page there is no reason to keep a hidden orb burning frames.
 */

import { Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";

import type { VoicePoweredOrbProps } from "@/components/ui/voice-powered-orb";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { pageIsCovered, TAKEOVER_EVENT } from "@/lib/takeover";
import { cn } from "@/lib/utils";

type OrbComponent = ComponentType<VoicePoweredOrbProps>;

/**
 * The Web Speech API's recognition constructor, reached defensively: it is prefixed in every
 * Chromium and ABSENT in Firefox, and this file must compile with neither in lib.dom. The minimal
 * structural type below is all this component touches — adding @types/dom-speech-recognition for
 * one consumer would be a heavier dependency than the feature.
 */
interface MinimalSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
interface SpeechCapableWindow extends Window {
  SpeechRecognition?: new () => MinimalSpeechRecognition;
  webkitSpeechRecognition?: new () => MinimalSpeechRecognition;
}

export function AiOrb({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotionPreference();

  const [Orb, setOrb] = useState<OrbComponent | null>(null);
  const [near, setNear] = useState(false);
  const [covered, setCovered] = useState(false);
  const [listening, setListening] = useState(false);
  /** What the microphone permission did when the reader asked for it. See the effect below. */
  const [mic, setMic] = useState<"idle" | "asking" | "granted" | "denied" | "unavailable">("idle");
  const [speaking, setSpeaking] = useState(false);
  /** The reader's words, live. Null when recognition is unsupported — a different fact from "". */
  const [transcript, setTranscript] = useState<string | null>("");
  const recognitionRef = useRef<MinimalSpeechRecognition | null>(null);

  /*
   * THE TRANSCRIPT — what it heard, written back to the reader while they speak.
   *
   * Same consent gate as the analyser: recognition starts only while `listening` is true, i.e.
   * strictly after the reader pressed the microphone button (the browser's own mic permission has
   * already been granted to the orb's getUserMedia by then, so this adds no second prompt in
   * Chromium). Interim results are shown as they form — the point is the mirror, not a minutes
   * document — and only the LAST utterance is kept, because a scrolling transcript under an orb
   * is a chat log, which this is not.
   *
   * ⚠ Firefox ships no SpeechRecognition: `transcript` stays null there and the line under the
   * orb simply never renders. The orb itself (amplitude-driven) works everywhere, so the feature
   * degrades by shedding words, not by breaking.
   */
  useEffect(() => {
    if (!listening) {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      return;
    }

    const speechWindow = window as SpeechCapableWindow;
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setTranscript(null);
      return;
    }

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    // English default; the recogniser auto-adapts poorly, but a wrong guess still shows the
    // reader that it is LISTENING, which is the interaction being demonstrated.
    recognition.lang = "en-IN";

    recognition.onresult = (event) => {
      const last = event.results[event.results.length - 1]?.[0];
      if (last) setTranscript(last.transcript.trim());
    };
    // Chromium ends recognition after silence; while the toggle is still on, begin again.
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        try {
          recognition.start();
        } catch {
          // Already restarting, or the tab lost the microphone — the orb carries on without words.
        }
      }
    };
    recognition.onerror = () => {
      // "no-speech" and "aborted" arrive in normal use; the onend restart covers recovery.
    };

    try {
      recognition.start();
      setTranscript("");
    } catch {
      setTranscript(null);
    }

    return () => {
      recognitionRef.current = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // Never started — nothing to stop.
      }
    };
  }, [listening]);

  // Near-viewport gate + lazy chunk. The import fires once, on first approach; the mount flag
  // keeps toggling with visibility so the rAF loop never runs for an orb nobody can see.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || reduce) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setNear(entry.isIntersecting);
        if (entry.isIntersecting) {
          void import("@/components/ui/voice-powered-orb").then((module) => {
            setOrb(() => module.VoicePoweredOrb);
          });
        }
      },
      { rootMargin: "240px 0px" }
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [reduce]);

  useEffect(() => {
    const sync = () => setCovered(pageIsCovered());
    sync();
    window.addEventListener(TAKEOVER_EVENT, sync);
    return () => window.removeEventListener(TAKEOVER_EVENT, sync);
  }, []);

  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ASK FOR THE MICROPHONE HERE, FROM THE BUTTON — because until now NOTHING RELIABLY DID.
   *
   * The permission prompt had exactly two possible sources and both are conditional:
   *
   *   • `VoicePoweredOrb`'s own `getUserMedia`, which only runs once the orb is MOUNTED — and it
   *     mounts on `!reduce && near && !covered && Orb !== null`. Reduced motion, a WebGL refusal, a
   *     chunk that has not landed yet, or a takeover covering the page, and there is no orb, so
   *     nothing asks.
   *   • `recognition.start()` below, which prompts in Chromium — but Firefox has no
   *     `SpeechRecognition` at all and Brave deletes it, so on those there is no second chance.
   *
   * Land on any of those combinations and the reader presses "Let it hear you", the label flips to
   * "Stop listening", and the browser never asks them anything. Reported as "the site never asks for
   * microphone permissions", and that is exactly right.
   *
   * ⚠ THE TRACKS ARE STOPPED IMMEDIATELY, ON PURPOSE. This call exists to raise the PROMPT and to
   * learn the answer, not to hold the device: the orb opens its own stream when it mounts, and the
   * grant persists for the page, so its request goes through without a second prompt. Holding this
   * one open as well would light the recording indicator for a feature the reader may have turned
   * straight back off, and would keep the microphone busy for another tab.
   *
   * It runs only while `listening` is true, so the prompt still follows the reader's own press —
   * the consent gate this component is careful about everywhere else.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  useEffect(() => {
    if (!listening) {
      setMic("idle");
      return;
    }

    // `mediaDevices` is undefined outside a secure context, which on this site means somebody is
    // running it over plain http — worth saying rather than failing mutely.
    if (!navigator.mediaDevices?.getUserMedia) {
      setMic("unavailable");
      return;
    }

    let cancelled = false;
    setMic("asking");

    void navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
        if (!cancelled) setMic("granted");
      })
      .catch(() => {
        // Refused, dismissed, blocked by policy, or no input device — the reader cannot tell these
        // apart and neither can we, so one honest sentence covers all of them.
        if (!cancelled) setMic("denied");
      });

    return () => {
      cancelled = true;
    };
  }, [listening]);

  const showShader = !reduce && near && !covered && Orb !== null;

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div ref={hostRef} className="relative h-56 w-56 sm:h-72 sm:w-72">
        {/* The resting disc — always in the markup, so reduced motion, a slow chunk and a far
            scroll position all show the same composed presence rather than a hole. The shader
            paints over it when it is allowed to run. */}
        <div
          aria-hidden="true"
          className="absolute inset-4 rounded-full opacity-80"
          style={{
            background:
              "radial-gradient(closest-side, oklch(0.56 0.205 305 / 0.5), oklch(0.4 0.18 305 / 0.25) 55%, transparent 72%)"
          }}
        />
        {showShader ? <Orb className="absolute inset-0" enableVoiceControl={listening} onVoiceDetected={setSpeaking} /> : null}
      </div>

      {/*
        The invitation.

        ⚠ THIS USED TO BE GATED ON `!reduce`, AND THAT IS WHY THE MICROPHONE WAS "NOT FUNCTIONAL AT
        ALL". The reasoning was sound when it was written — under reduced motion the shader never
        mounts, so the button's only effect would have been an orb that does not turn, and a control
        with no visible effect is a broken control. But it meant a reader with reduced motion on, at
        the operating system OR through this site's own toggle, got no button at all: nothing to
        press, no permission prompt, no way in. That is not a degraded feature, it is a missing one,
        and it is invisible to anyone testing without the preference set.

        It no longer holds either way. Pressing this now produces three things that have nothing to
        do with motion — the browser's permission prompt, the state line below, and the transcript —
        so the control has a visible effect under reduction too. REDUCED MOTION IS NOT REDUCED SOUND;
        it is a request about things that move, and the orb's stillness already honours it.
      */}
      {
        <button
          type="button"
          aria-pressed={listening}
          onClick={() => setListening((current) => !current)}
          className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-full border border-gold-300/30 bg-gold-300/5 px-5 font-display text-sm font-semibold text-gold-200 transition hover:border-gold-300/60 hover:bg-gold-300/15 focus-visible:!outline-logo-cream"
        >
          {listening ? (
            <>
              <MicOff aria-hidden="true" className="h-4 w-4" />
              Stop listening
            </>
          ) : (
            <>
              <Mic aria-hidden="true" className="h-4 w-4" />
              Let it hear you
            </>
          )}
        </button>
      }

      {/* One quiet line of state. `aria-live` deliberately absent — "speaking/quiet" flips with
          every sentence and a screen reader narrating that is noise (the §8 readout rule). */}
      {listening ? (
        <p className="mt-2 text-xs text-white/50">
          {/*
            The permission comes FIRST, because until it is answered "Listening" is a claim the page
            cannot support — the microphone is not open yet. Only once it is granted does the old
            speaking/quiet readout mean anything.
          */}
          {mic === "asking"
            ? "Waiting for you to allow the microphone…"
            : mic === "denied"
              ? "The microphone was not allowed, so it cannot hear anything. Your browser's address bar has the switch."
              : mic === "unavailable"
                ? "No microphone is available to this page."
                : speaking
                  ? "It hears you — watch it turn."
                  : "Listening. Say something."}
        </p>
      ) : null}

      {/* What it heard, mirrored back — the words themselves, in the story's own gold. Fixed
          height so the line's arrival never shoves the chapter below; sliced from the END because
          the freshest words are the mirror. */}
      {listening && transcript !== null ? (
        <p className="mt-3 flex min-h-10 max-w-md items-center justify-center px-4 text-center font-display text-sm italic leading-snug text-gold-200/90">
          {transcript ? `“${transcript.length > 140 ? `…${transcript.slice(-140)}` : transcript}”` : null}
        </p>
      ) : null}

      {/*
        ⚠ THE BROWSER HAS NO RECOGNISER — SAY SO, RATHER THAN RENDERING NOTHING.
        `transcript` is set to `null` in exactly one case that is not an error: the effect above
        found neither `SpeechRecognition` nor `webkitSpeechRecognition`. Until now that produced
        SILENCE — the orb turned, the button said "Stop listening", and no words ever appeared —
        which is indistinguishable from a bug, and was reported as one.

        It is not a bug, and it is not rare. FIREFOX has never shipped the interface at all, and
        BRAVE REMOVES IT ON PURPOSE: the Chromium implementation streams the microphone to Google's
        servers for recognition, so Brave deletes the API rather than route its users' audio there.
        Both are working as their makers intend, and no amount of code here changes it — the honest
        response is to tell the reader what happened and let them decide.

        The orb itself is amplitude-driven from `getUserMedia` and turns perfectly well in both, so
        this really is the feature shedding WORDS rather than failing.
      */}
      {listening && transcript === null ? (
        <p className="mt-3 flex min-h-10 max-w-md items-center justify-center px-4 text-center text-xs leading-snug text-white/50">
          It is listening and the orb is turning, but this browser has no speech recogniser, so the
          words cannot be shown. Firefox has never had one, and Brave removes it deliberately rather
          than send your microphone to Google. Chrome, Edge or Safari will show them.
        </p>
      ) : null}
    </div>
  );
}
