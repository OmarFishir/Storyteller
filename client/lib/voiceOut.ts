/**
 * VoiceOut — the narrator abstraction (architecture rule #3's twin; rule #2:
 * playback is ALWAYS stoppable mid-word). Primary engine: POST /narrate
 * (Gemini TTS via our backend) played through ONE persistent Audio element.
 * ANY failure downgrades to the device's built-in voice for that utterance —
 * the story is never silent because a quota ran out. Mock mode always uses
 * the device voice for narration: story + narration demo at zero cost,
 * matching the backend's own mock stance. STT (the mic, see lib/voice.ts) is
 * NEVER mocked — it always POSTs a recorded clip to the real /transcribe
 * endpoint regardless of this flag, so a mic press in mock mode still costs
 * a fraction of a cent per utterance.
 *
 * iOS Safari only allows sound that traces back to a real tap, and it
 * blesses INDIVIDUAL media elements once played during a user gesture. So:
 * one element for the whole page load, blessed by unlock() (call it
 * synchronously from any tap handler), src-swapped per utterance. The
 * element and its bless live at MODULE scope — getVoiceOut() builds fresh
 * closures per call, and a per-call element would lose the bless between
 * Home (where the first tap happens) and Story (where narration plays).
 */

import { API_URL } from "./api";
import { streamingFetch } from "./fetch";

export type VoiceOut = {
  available: boolean;
  speak: (text: string, opts?: { kind?: "scene" | "reply" }) => void;
  stop: () => void;
  /** Bless the shared audio element for iOS autoplay. Call synchronously
   * from a real tap handler. Idempotent; harmless where not needed; its own
   * play() rejection (a no-gesture call) is swallowed and simply doesn't
   * bless — the next tap retries. */
  unlock: () => void;
  onSpeakingChange: (cb: (speaking: boolean) => void) => void;
};

const USE_MOCK = process.env.EXPO_PUBLIC_USE_MOCK === "1";

// A minimal valid WAV (PCM mono, two silent samples) as a data URI — what
// unlock() plays, muted, to bless the shared element inside a tap handler.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQQAAAAAAA==";

// How long the device-voice fallback waits before checking the engine
// actually started — iOS drops a gesture-less speechSynthesis.speak() with
// NO event at all.
const SYNTH_WATCHDOG_MS = 1500;

type AudioEl = {
  src: string;
  muted: boolean;
  paused: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play: () => Promise<void> | void;
  pause: () => void;
};

type AudioGlobals = {
  Audio?: new () => AudioEl;
  speechSynthesis?: {
    speak: (u: unknown) => void;
    cancel: () => void;
    speaking?: boolean;
  };
  SpeechSynthesisUtterance?: new (text: string) => {
    onend: (() => void) | null;
    onerror: (() => void) | null;
  };
  URL?: { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
};

// Module scope on purpose — see the header comment.
let sharedAudio: AudioEl | null = null;
let unlocked = false;

/** Test-only: forget the shared element and its bless between tests. */
export function __resetVoiceOutForTests() {
  sharedAudio = null;
  unlocked = false;
}

const UNAVAILABLE: VoiceOut = {
  available: false,
  speak: () => {},
  stop: () => {},
  unlock: () => {},
  onSpeakingChange: () => {},
};

export function getVoiceOut(): VoiceOut {
  const g = globalThis as never as AudioGlobals;
  const hasDevice = !!g.speechSynthesis && !!g.SpeechSynthesisUtterance;
  const hasAudio = !!g.Audio && !!g.URL;
  if (!hasDevice && !hasAudio) return UNAVAILABLE;

  let speakingCb: (speaking: boolean) => void = () => {};
  let speaking = false;
  let generation = 0; // bumped on every speak/stop: stale async work no-ops
  let currentUrl: string | null = null;

  const ensureAudio = (): AudioEl | null => {
    if (!hasAudio) return null;
    if (!sharedAudio) sharedAudio = new g.Audio!();
    return sharedAudio;
  };

  const setSpeaking = (s: boolean) => {
    if (speaking === s) return;
    speaking = s;
    speakingCb(s);
  };

  const halt = () => {
    generation += 1;
    sharedAudio?.pause();
    if (currentUrl && g.URL) {
      g.URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
    g.speechSynthesis?.cancel();
    setSpeaking(false);
  };

  const deviceSpeak = (text: string, gen: number) => {
    if (gen !== generation) return; // stale generation: don't touch state
    if (!hasDevice) {
      setSpeaking(false); // no fallback voice available; pipeline dies here
      return;
    }
    const synth = g.speechSynthesis!; // capture once: protects late watchdog from torn-down global
    const utterance = new g.SpeechSynthesisUtterance!(text);
    let settled = false;
    utterance.onend = () => {
      settled = true;
      if (gen === generation) setSpeaking(false);
    };
    utterance.onerror = utterance.onend;
    synth.speak(utterance);
    // iOS drops a gesture-less speak() with NO event at all. If the engine
    // explicitly reports it is not speaking shortly after, flip the pipeline
    // off so the UI can't hang in "speaking". Only an explicit false counts —
    // an engine without a .speaking property gets the benefit of the doubt.
    // The captured synth prevents a torn-down global from crashing late-firing timeouts.
    setTimeout(() => {
      if (settled || gen !== generation) return;
      if (synth.speaking === false) setSpeaking(false);
    }, SYNTH_WATCHDOG_MS);
  };

  return {
    available: true,
    unlock() {
      if (unlocked) return;
      const el = ensureAudio();
      if (!el) return;
      if (!el.paused) return; // never hijack live playback for a bless
      unlocked = true;
      el.muted = true;
      el.src = SILENT_WAV;
      Promise.resolve(el.play()).then(
        () => {
          // Don't pause a real narration that started while this resolved.
          if (el.src === SILENT_WAV) {
            el.pause();
            el.muted = false;
          }
        },
        () => {
          // No gesture context: nothing was blessed. Swallowed on purpose —
          // the next tap's unlock() retries.
          unlocked = false;
          if (el.src === SILENT_WAV) {
            el.pause(); // a rejected play never started; park the element again
            el.muted = false;
          }
        }
      );
    },
    speak(text, opts) {
      halt(); // one voice at a time
      const gen = generation;
      // "Speaking" means the narration PIPELINE is active, not that audio is
      // physically playing yet — flipped true here, synchronously, so the
      // "■ Stop" control stays reachable through the multi-second /narrate
      // fetch instead of only appearing once playback starts.
      setSpeaking(true);
      if (USE_MOCK || !hasAudio) {
        deviceSpeak(text, gen);
        return;
      }
      streamingFetch(`${API_URL}/narrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, kind: opts?.kind ?? "scene" }),
      })
        .then(async (res) => {
          if (gen !== generation) return; // stopped/superseded while in flight
          if (!res.ok) {
            deviceSpeak(text, gen); // quota/failure -> never silent
            return;
          }
          const blob = await res.blob();
          if (gen !== generation) return;
          const audio = ensureAudio()!; // hasAudio guaranteed on this path
          currentUrl = g.URL!.createObjectURL(blob);
          audio.muted = false;
          audio.src = currentUrl;
          audio.onended = () => {
            if (gen !== generation) return;
            // Natural end: free the blob URL (previously a bounded leak —
            // only stop()/supersede ever revoked it).
            if (currentUrl && g.URL) {
              g.URL.revokeObjectURL(currentUrl);
              currentUrl = null;
            }
            setSpeaking(false);
          };
          audio.onerror = () => {
            if (gen === generation) deviceSpeak(text, gen);
          };
          Promise.resolve(audio.play()).catch(() => {
            // Autoplay policy block: no tap traces to this play(). Do NOT
            // fall back to the device voice — on iOS it's equally
            // gesture-gated and fails SILENTLY, which would hang "speaking"
            // forever. This utterance goes unspoken; the story continues.
            if (gen === generation) setSpeaking(false);
          });
        })
        .catch(() => {
          if (gen === generation) deviceSpeak(text, gen);
        });
    },
    stop: halt,
    onSpeakingChange(cb) {
      speakingCb = cb;
    },
  };
}
