/**
 * VoiceOut — the narrator abstraction (architecture rule #3's twin; rule #2:
 * playback is ALWAYS stoppable mid-word). Primary engine: POST /narrate
 * (Gemini TTS via our backend) played through an Audio element. ANY failure
 * downgrades to the device's built-in voice for that utterance — the story
 * is never silent because a quota ran out. Mock mode always uses the device
 * voice: the full loop demos at zero cost.
 */

import { API_URL } from "./api";
import { streamingFetch } from "./fetch";

export type VoiceOut = {
  available: boolean;
  speak: (text: string, opts?: { kind?: "scene" | "reply" }) => void;
  stop: () => void;
  onSpeakingChange: (cb: (speaking: boolean) => void) => void;
};

const USE_MOCK = process.env.EXPO_PUBLIC_USE_MOCK === "1";

type AudioGlobals = {
  Audio?: new (src: string) => {
    paused: boolean;
    onended: (() => void) | null;
    onerror: (() => void) | null;
    play: () => Promise<void> | void;
    pause: () => void;
  };
  speechSynthesis?: { speak: (u: unknown) => void; cancel: () => void };
  SpeechSynthesisUtterance?: new (text: string) => {
    onend: (() => void) | null;
    onerror: (() => void) | null;
  };
  URL?: { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
};

const UNAVAILABLE: VoiceOut = {
  available: false,
  speak: () => {},
  stop: () => {},
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
  let currentAudio: InstanceType<NonNullable<AudioGlobals["Audio"]>> | null = null;
  let currentUrl: string | null = null;

  const setSpeaking = (s: boolean) => {
    if (speaking === s) return;
    speaking = s;
    speakingCb(s);
  };

  const halt = () => {
    generation += 1;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (currentUrl && g.URL) {
      g.URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
    g.speechSynthesis?.cancel();
    setSpeaking(false);
  };

  const deviceSpeak = (text: string, gen: number) => {
    if (!hasDevice || gen !== generation) return;
    const utterance = new g.SpeechSynthesisUtterance!(text);
    utterance.onend = () => {
      if (gen === generation) setSpeaking(false);
    };
    utterance.onerror = utterance.onend;
    setSpeaking(true);
    g.speechSynthesis!.speak(utterance);
  };

  return {
    available: true,
    speak(text, opts) {
      halt(); // one voice at a time
      const gen = generation;
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
          currentUrl = g.URL!.createObjectURL(blob);
          const audio = new g.Audio!(currentUrl);
          currentAudio = audio;
          audio.onended = () => {
            if (gen === generation) {
              currentAudio = null;
              setSpeaking(false);
            }
          };
          audio.onerror = () => {
            if (gen === generation) {
              currentAudio = null;
              deviceSpeak(text, gen);
            }
          };
          setSpeaking(true);
          void audio.play();
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
