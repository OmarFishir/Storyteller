# Design: Phase 2 Slice C — Push-to-Talk Voice Input

**Date:** 2026-07-04
**Status:** Approved (pending implementation)
**Roadmap context:** Slice C of Phase 2 (`2026-07-02-phase2-vertical-slice-design.md`).
Inputs accumulated from slice A/B and story-structure reviews (see SDD ledger).

## Decisions made in this design session

| Question | Decision |
|---|---|
| Platform sequencing | **Web first.** The whole PTT experience ships and is proven in the browser (built-in SpeechRecognition, zero setup). The native dev build is the slice's LAST task; if build friction bites, it ships as documented instructions, never blocking the feature. Phone OS to be confirmed at that task. |
| Web speech dependency | None — `VoiceIn`'s web implementation uses the browser's `SpeechRecognition` directly (localhost-safe, zero new deps). `expo-speech-recognition` enters only in the native task, behind the same interface. |

## C0 — Cancellation plumbing (prerequisite, from reviews)

- `streamTurn(body, opts?: { signal?: AbortSignal })` → signal passed to
  `streamingFetch`; `reader.cancel()` in a `finally`.
- **Deliberate aborts are swallowed silently** — an `AbortError` must NOT yield
  the status-0 "Connection lost" `stream_error` (that copy now renders
  verbatim; a cancel is not a failure). The generator simply ends.
- Story aborts its in-flight stream on unmount (stops billing an unwatched
  screen) via an `AbortController` kept in a ref.
- `isStreaming` React state mirrors the existing `streamingRef` so UI renders
  busy states (PTT button disabled + visibly busy while a turn streams; a
  dropped spoken utterance must never be silent).
- Retires riding minors: reader-never-cancelled; no-unmount-abort.

## VoiceIn — the abstraction (architecture rule #3)

`client/lib/voice.ts`:

```ts
export type VoiceCallbacks = {
  onInterim: (transcript: string) => void;   // rewrites as recognition refines
  onFinal: (transcript: string) => void;     // fired at stop/recognition end
  onError: (message: string) => void;        // permission denied, no speech, etc.
};
export type VoiceIn = {
  available: boolean;
  start: (cb: VoiceCallbacks) => void;
  stop: () => void;    // finish and deliver final transcript
  abort: () => void;   // discard everything
};
export function getVoiceIn(): VoiceIn;  // returns web impl or an unavailable stub
```

- Web implementation wraps `window.SpeechRecognition || webkitSpeechRecognition`
  with `interimResults: true`, single-utterance mode; unavailable browsers get
  `{available: false}` and the mic UI does not render.
- Privacy note (recorded, not actioned): Chrome's recognition sends audio to
  Google's servers. Fine for dev; revisit wording at launch (Phase 6).
- Unit tests via a fake `SpeechRecognition` class injected on `window`.

## The card-matcher — pure function, no network

`client/lib/matchCard.ts`: `matchCard(utterance: string, cards: string[]) → number | null`.

1. Normalize: lowercase, strip punctuation.
2. **Ordinals** (win immediately if in bounds): "first/one/1", "second/two/2",
   "third/three/3", "fourth/four/4", "last", "option N" / "number N" — spoken
   forms like "the second one", "pick number two", "take the last one".
3. **Word overlap**: content words (length > 3, minus a tiny stopword list)
   shared with each card; a card matches only with ≥ 2 overlapping words AND a
   strictly higher score than the runner-up. Ties/ambiguity → null.
4. **Null → free-form steering**: the utterance goes to `/continue` verbatim as
   `chosen_scenario` (the backend has supported this since Phase 1).
   Graceful failure IS the feature.
5. Table-driven unit tests: ordinals in natural phrasings, overlap hits,
   ambiguity → null, gibberish → null, out-of-bounds ordinal → null.

## The interaction

- **Persistent PTT bar** at the bottom of Story: screens get a flex `View`
  wrapper with the ScrollView inside (per review note — button must not live
  inside the scroll content). Hold (`onPressIn`/`onPressOut`) to talk; live
  interim transcript renders as **plain Text** (NOT StreamingText — its
  append-only contract cannot handle interim rewrites; review-mandated).
- **On release — one confirm mechanism for both outcomes:** a bar shows
  "Heard: '…'" plus the action — "→ choosing option N" (matched card also
  visually highlighted) or "→ steering the story" — with a Cancel tap and
  ~1.5s auto-send. Cancel discards; timeout sends through the SAME `runTurn`
  path as taps (inherits turn clock, frozen retry, overlap guard).
- **Home**: mic affordance on the premise box; final transcript fills the
  premise input (same `VoiceIn`). No confirm bar needed — the input itself is
  the confirm step.
- **States**: mic permission denied → clear inline message; voice unavailable →
  no mic UI; turn streaming → PTT disabled with busy styling (via
  `isStreaming`).
- **Story exit control**: an explicit back affordance (review note — the
  default header was removed in slice B, leaving no visible exit).

## Out of scope (deliberate)

- Narration/TTS (slice D). Hands-free/barge-in (Phase 5). "Wrap it up now"
  voice command (needs an explicit request signal — not a faked turn number).
- LLM-based utterance matching (the rules-based matcher is the approved
  cheap path; upgradeable in isolation later).
- Option summarization for the narrator (slice D concern, already flagged).

## Verification

1. TDD throughout; jest for VoiceIn (fake SpeechRecognition), matchCard
   (table-driven), abort plumbing (AbortError swallowed ≠ connection-lost),
   Story/Home integration (RNTL; voice mocked at the VoiceIn seam).
2. Browser hand-off: in Chrome against mock mode — hold, say "the second one"
   → card 2 highlights + sends; say a free-form sentence → steers; cancel
   works; unmount mid-stream stops the stream.
3. Native dev build = final task, expected outcome "built and installed" OR
   "documented instructions + blocked on user account/OS input" — both are
   acceptable slice outcomes.
