/**
 * VoiceIn — the project's voice-input abstraction (architecture rule #3:
 * never call a speech service directly; web vs phone implementations swap
 * behind this interface).
 *
 * This slice ships the WEB implementation on the browser's built-in
 * SpeechRecognition (Chrome et al; works on localhost). The native
 * implementation (expo-speech-recognition, needs a dev build) arrives in the
 * slice's final task behind this same interface.
 *
 * Privacy note (recorded in the spec): Chrome's recognition sends audio to
 * Google's servers. Acceptable for dev; revisit wording before launch.
 */

export type VoiceCallbacks = {
  onInterim: (transcript: string) => void;
  onFinal: (transcript: string) => void;
  onError: (message: string) => void;
};

export type VoiceIn = {
  available: boolean;
  start: (cb: VoiceCallbacks) => void;
  stop: () => void;
  abort: () => void;
};

type RecognitionCtor = new () => {
  interimResults: boolean;
  continuous: boolean;
  lang: string;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;
};

const UNAVAILABLE: VoiceIn = {
  available: false,
  start: () => {},
  stop: () => {},
  abort: () => {},
};

export function getVoiceIn(): VoiceIn {
  const g = globalThis as never as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  if (!Ctor) return UNAVAILABLE;

  let rec: InstanceType<RecognitionCtor> | null = null;

  return {
    available: true,
    start(cb: VoiceCallbacks) {
      if (rec) {
        rec.onend = null; // discard the superseded session: no final delivery
        rec.abort();
      }
      rec = new Ctor();
      rec.interimResults = true;
      rec.continuous = true; // hold-to-talk: we decide when it ends, not silence
      rec.lang = "en-US";

      let finalText = "";
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const chunk = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += chunk;
          else interim += chunk;
        }
        cb.onInterim((finalText + interim).trim());
      };
      rec.onerror = (e) => {
        cb.onError(
          e.error === "not-allowed" || e.error === "service-not-allowed"
            ? "Microphone permission denied. Enable the mic to speak your story."
            : `Speech recognition error: ${e.error}`
        );
      };
      rec.onend = () => {
        cb.onFinal(finalText.trim());
      };
      rec.start();
    },
    stop() {
      rec?.stop(); // recognizer fires onend -> onFinal
    },
    abort() {
      if (rec) {
        rec.onend = null; // discard: no final delivery
        rec.abort();
      }
    },
  };
}
