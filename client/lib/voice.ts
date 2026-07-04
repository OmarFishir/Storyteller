/**
 * VoiceIn v2 — the project's voice-input abstraction (architecture rule #3),
 * now powered by RECORD-THEN-TRANSCRIBE: hold-to-talk records a clip
 * (MediaRecorder), release uploads it to POST /transcribe, and the server's
 * Gemini call returns the words. The Chrome SpeechRecognition engine from
 * slice C is retired — live play showed it garbling natural speech, and
 * recognition quality is exactly what this interface exists to let us swap.
 *
 * Interface contract (unchanged from slice C):
 *   stop()  = finish: upload the clip, deliver onFinal (non-empty only)
 *   abort() = discard: no upload, no callbacks
 * Web v2 NEVER calls onInterim (no live words from server STT) — PushToTalk
 * renders "listening…"/"transcribing…" from press state instead. The
 * callback stays in the interface for future streaming STT and native impls.
 *
 * The phone implementation (record via Expo's audio module, upload the same
 * way — works in plain Expo Go, no dev build) slots in behind this same
 * interface as a follow-up.
 */

import { API_URL } from "./api";
import { streamingFetch } from "./fetch";

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

type MediaGlobals = {
  navigator?: {
    mediaDevices?: {
      getUserMedia?: (c: { audio: boolean }) => Promise<{
        getTracks: () => Array<{ stop: () => void }>;
      }>;
    };
  };
  MediaRecorder?: {
    new (stream: unknown, options?: { mimeType?: string }): {
      state: string;
      mimeType: string;
      ondataavailable: ((e: { data: Blob }) => void) | null;
      onstop: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    isTypeSupported?: (mime: string) => boolean;
  };
};

const UNAVAILABLE: VoiceIn = {
  available: false,
  start: () => {},
  stop: () => {},
  abort: () => {},
};

export function getVoiceIn(): VoiceIn {
  const g = globalThis as never as MediaGlobals;
  if (!g.navigator?.mediaDevices?.getUserMedia || !g.MediaRecorder) {
    return UNAVAILABLE;
  }

  type Session = {
    recorder: InstanceType<NonNullable<MediaGlobals["MediaRecorder"]>> | null;
    tracks: Array<{ stop: () => void }>;
    chunks: Blob[];
    discarded: boolean;
    stopRequested: boolean;
  };
  let session: Session | null = null;

  const releaseTracks = (s: Session) => {
    s.tracks.forEach((t) => t.stop());
    s.tracks = [];
  };

  const finishSession = (s: Session, cb: VoiceCallbacks) => {
    // Runs from recorder.onstop: the clip is complete.
    releaseTracks(s);
    if (s.discarded) return;
    const mime = s.recorder?.mimeType || "audio/webm";
    const blob = new Blob(s.chunks, { type: mime });
    if (blob.size === 0) return; // nothing recorded: nothing to deliver
    const form = new FormData();
    form.append("audio", blob, "utterance.webm");
    streamingFetch(`${API_URL}/transcribe`, { method: "POST", body: form })
      .then(async (res) => {
        if (!res.ok) {
          let detail = `Transcription failed (${res.status})`;
          try {
            detail = (await res.json()).detail ?? detail;
          } catch {}
          cb.onError(detail);
          return;
        }
        const transcript = String((await res.json()).transcript ?? "").trim();
        if (transcript) cb.onFinal(transcript);
      })
      .catch(() => {
        cb.onError("Couldn't reach the storyteller to transcribe. Is the backend running?");
      });
  };

  return {
    available: true,
    start(cb: VoiceCallbacks) {
      // Supersede any live session silently (slice C's double-start guard).
      if (session) {
        session.discarded = true;
        try {
          session.recorder?.stop();
        } catch {}
        releaseTracks(session);
      }
      const s: Session = {
        recorder: null,
        tracks: [],
        chunks: [],
        discarded: false,
        stopRequested: false,
      };
      session = s;

      g.navigator!.mediaDevices!.getUserMedia!({ audio: true })
        .then((stream) => {
          if (s.discarded) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          s.tracks = stream.getTracks();
          const MR = g.MediaRecorder!;
          const mime = MR.isTypeSupported?.("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : undefined;
          const recorder = mime ? new MR(stream, { mimeType: mime }) : new MR(stream);
          s.recorder = recorder;
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) s.chunks.push(e.data);
          };
          recorder.onstop = () => finishSession(s, cb);
          recorder.start();
          // Released before the mic warmed up? Finish immediately.
          if (s.stopRequested) recorder.stop();
        })
        .catch(() => {
          cb.onError(
            "Microphone permission denied. Enable the mic to speak your story."
          );
        });
    },
    stop() {
      if (!session) return;
      session.stopRequested = true;
      try {
        session.recorder?.stop();
      } catch {}
    },
    abort() {
      if (!session) return;
      session.discarded = true;
      session.stopRequested = true;
      try {
        session.recorder?.stop();
      } catch {}
      releaseTracks(session);
    },
  };
}
