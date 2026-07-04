# The Audio Slice — Design Spec (STT in + TTS out)

**Date:** 2026-07-04
**Status:** Approved by owner (brainstorm session, same day)
**Supersedes:** slice D's original "narration v1" scope — the owner chose one
coherent audio-stack slice (hearing + speaking together) after live play
showed Chrome's built-in recognizer garbling speech ("she doesn't applying").
**Layers on:** the conversational co-creation feed (scenes + bubbles + ■ Stop
+ `pendingConverse` retry), slice C's abort plumbing, and the `VoiceIn`
abstraction — whose swappability (architecture rule #3) is the whole reason
this slice is cheap.

## Why this exists (origin)

The owner's target experience: "as seamless as Claude's voice chat mode."
That decomposes into three gaps: (1) it mishears you — Chrome's free
recognizer garbles accented/natural speech; (2) it doesn't talk back — no
narration; (3) no buttons — hands-free. This slice closes (1) and (2).
Hands-free stays Phase 5. Word-sync, streamed-before-text-finishes audio,
and per-genre voices stay Phase 4.

## Owner decisions (binding)

1. **Everything speaks, automatically.** Scenes AND discussion replies are
   narrated as they complete — the voice-chat feel is the product. Always
   stoppable mid-word.
2. **Browser first, phone-ready.** Built and verified in Chrome; the
   recording/playback seams are designed so plain Expo Go covers the phone
   later (server-side STT removes the need for a native dev build for voice
   input). Phone verification is a documented follow-up, not a blocker.
3. **Approach A — All-Gemini** (chosen over best-of-breed Groq+OpenAI and
   over frugal device-voice-only): STT via Gemini audio understanding and
   TTS via Google's Gemini TTS model, both on the EXISTING key. Zero new
   accounts. The device's built-in voice is `VoiceOut`'s automatic fallback
   (quota/key failure → robot voice, never silence), and mock mode uses it
   so the full loop demos at zero cost.
4. **Paid-tier flip recommended alongside** (owner action): audio roughly
   doubles calls per turn and the free tier already 503s under today's load.
   Expected spend at real usage: single-digit dollars/month, inside the ~$20
   dev budget.

## Verified pricing (2026-07-04 — re-verify at plan time, never from memory)

- STT: audio input bills as ordinary input tokens (~25–32 tokens/second of
  speech) on Gemini — a 5s utterance is fractions of a cent; the EXISTING
  token meter captures it automatically. (Market alternatives for context:
  Groq Whisper ~$0.0006/min, OpenAI transcribe $0.003/min.)
- TTS: Gemini Flash TTS ~$20/1M audio tokens (~25 tokens/second of audio) —
  ≈ 3–8¢ per narrated scene, ~1¢ per reply. (OpenAI tts-1 $15/1M chars;
  ElevenLabs $50–100/1M chars — Phase 4 luxury, not v1.)
- Sources: tokenmix.ai Whisper/TTS roundups, futureagi.com STT guide,
  texttolab.com OpenAI TTS pricing, tokencost.app TTS comparison.

## Backend

### `POST /transcribe`

- Request: multipart/form-data with one audio file (the client's recorded
  clip; webm/opus from the browser's MediaRecorder, m4a from the phone
  later). A reasonable max size cap (a PTT utterance is seconds, not
  minutes) → oversized uploads get a clean 413.
- Behavior: ONE Gemini call on the existing `MODEL` (it is multimodal):
  audio part + a static transcription instruction (verbatim, no
  punctuation-editorializing, no commentary — output ONLY the transcript).
  Returns `{"transcript": "..."}`. Empty/unusable audio → clean 502 (same
  philosophy as empty model text).
- Usage label `stt`; audio bills as input tokens so `usage_log` works
  unchanged.
- Same retry/429/503 mapping as every other call (reuses the shared
  helpers).

### `POST /narrate`

- Request: `{"text": "...", "kind": "scene" | "reply"}`. Text length is
  naturally bounded (scenes by `SCENE_BUDGETS`, replies by
  `CONVERSE_BUDGET`); a defensive char cap → 413 on abuse.
- Behavior: ONE call to a new `TTS_MODEL` constant beside `MODEL` (exact
  current model id verified from Google's docs at plan time). Returns audio
  bytes (`audio/*` content type per what the API emits) as a normal HTTP
  response — v1 is NOT streamed; narration starts when a scene/reply is
  complete. Audio-before-text-finishes is Phase 4's headline, deliberately
  excluded here.
- Usage label `tts`: log text characters in and audio tokens out (extend the
  usage row only if the SDK exposes audio token counts; otherwise characters
  in + 0 out with a comment — the meter must never lie silently).
- Same clean 429/503/502 error mapping. Mock mode: NOT needed server-side —
  the client skips `/narrate` entirely in mock mode and uses the device
  voice.

## Client

### `VoiceIn` v2 — same interface, new engine

- The Chrome `SpeechRecognition` implementation is RETIRED (it is the
  component that failed). New web implementation behind the SAME
  `VoiceIn` interface: pressIn → `MediaRecorder` starts; pressOut → recorder
  stops → clip POSTs to `/transcribe` → `onFinal(transcript)`. `abort()`
  discards the recording with no upload, no `onFinal`.
- UX change (accepted): no live interim words. While held: a "listening…"
  pulse. After release: a brief transcribing state (sub-second to ~2s)
  before the transcript lands as the user bubble. `onInterim` stays in the
  `VoiceCallbacks` interface for future streaming STT but the web v2 impl
  NEVER calls it — the "listening…"/"transcribing…" status is rendered by
  `PushToTalk` itself from press state, not from interim callbacks.
- No-mic / permission-denied browsers: the `available: false` stub and the
  friendly inline error, exactly as today.
- Phone-ready seam: the later Expo Go implementation is the same
  record-then-upload pattern via Expo's audio module — interface unchanged,
  this slice just keeps the boundary clean.

### `VoiceOut` — new abstraction (rule #3's twin)

- Interface: `{ available: boolean, speak(text: string, opts?: {kind}):
  void, stop(): void, isSpeaking (observable state) }`.
- Primary implementation: fetch `/narrate`, play via an audio element —
  ALWAYS stoppable mid-word (architecture rule #2; retrofitting = rewrite).
- Fallback implementation: the device/browser built-in voice
  (`speechSynthesis`). Automatic downgrade on `/narrate` failure (429/503/
  network) — the story is never silent because a quota ran out.
- Mock mode (`EXPO_PUBLIC_USE_MOCK=1`): always the device voice — zero cost,
  full loop demoable.

### Wiring (Story screen)

- `turn_complete` → speak the finished scene. `discussion_complete` → speak
  the reply. Nothing else speaks (option cards are read, not performed).
- ■ Stop now stops BOTH the text stream and any playing audio.
- Holding the mic INTERRUPTS narration (you talk, it shuts up) — pressIn
  calls `VoiceOut.stop()` before recording starts.
- New `isSpeaking` state, deliberately SEPARATE from `isStreaming` (final
  review of the previous slice warned against overloading that flag): PTT is
  enabled while speaking (that's the interruption path) and disabled only
  while text is generating.

## Failure philosophy

- Narration can never block or damage the story: the text is already on
  screen; on failure fall back to device voice, or stay quiet with a
  stderr-visible log. No error banner for a mute narrator.
- Transcription failure surfaces as the existing inline PTT error (same spot
  as mic-permission errors); nothing is auto-retried into the story.
- Audio never touches the turn/beat clock, the summary, the notes, or the
  canonical `scenes` — it is strictly a presentation layer over the feed.

## Testing contract (house rules: Gemini mocked, tripwire enforced)

- Backend: `/transcribe` happy path + empty-audio 502 + oversize 413 +
  error mapping + `stt` label pinned; `/narrate` happy path + char cap +
  error mapping + `tts` label/budget pinned. No test ever reaches Gemini.
- Client: `VoiceIn` v2 (record → upload → onFinal; abort discards; errors
  inline) with `MediaRecorder` and `fetch` faked at the seams; `VoiceOut`
  (speak plays, stop halts, fallback downgrades on failure, mock forces
  device voice); Story wiring (scene/reply completion triggers speak;
  ■ Stop silences; pressIn interrupts narration; `isSpeaking` never gates
  PTT; `isStreaming` still does).

## Out of scope (deliberate)

- Streamed narration, per-genre voices, word-level text/audio sync (Phase 4).
- Hands-free / barge-in without buttons (Phase 5).
- Phone verification on a real device (follow-up task — needs the owner's
  phone; the seams are built ready).
- Persistence of audio; audio for old/archived scenes (narrate-on-arrival
  only; replay of history arrives with persistence in Phase 3).

## Risks / accepted trade-offs

- **Gemini-transcription accuracy vs dedicated Whisper-class ASR:** believed
  good, unproven for this owner's voice — the FIRST live checkpoint of the
  slice is a transcription quality gut-check; if it disappoints, the
  `VoiceIn` seam makes swapping to Groq/OpenAI STT a one-implementation
  change (Approach B held in reserve).
- **Shared quota pool:** story calls and audio calls compete on one key —
  mitigated by the paid-tier recommendation; free tier remains functional
  (fallback voice absorbs TTS quota failures).
- **Narration latency v1:** a full scene's audio generates in one shot after
  the text completes — a perceptible pause before the voice starts. Accepted;
  fixing it (streamed TTS) is exactly Phase 4.
- **No live interim transcript anymore:** a small UX regression during the
  hold, traded for dramatically better final accuracy.
