# Design: Phase 2 — The Vertical Slice (voice-directed, animated story client)

**Date:** 2026-07-02
**Status:** Approved (pending implementation)
**Roadmap context:** Phase 2 of `2026-07-02-voice-first-roadmap.md`
**Builds on:** Phase 1 story engine (`2026-07-02-phase1-story-engine-design.md`), live-verified, 29 tests.

## Goal

Prove the product's defining bet — voice-directed storytelling with beautifully
animated text *feels good* — with a thin vertical slice: speak or tap a
direction, watch the scene materialize word by word, hear it narrated.

## Decomposition (build order — each proven before the next)

| Slice | What | Proof |
|---|---|---|
| **A** | Backend streaming (`/continue/stream` SSE) + mock mode + CORS | curl/pytest show token-by-token streaming; mock streams free & offline |
| **B** | Expo app: template picker, premise, animated streaming story view, tappable option cards | Full playable loop in browser AND on phone, vs mock AND real Gemini |
| **C** | Push-to-talk voice input + card-matcher | Speak a direction → story advances; "the second one" → picks card 2 |
| **D** | Narration v1 (TTS via backend, abortable) | Scene is narrated aloud; stop button cuts it mid-word |

A and B are specified in detail below. **C and D get their own design
conversations** when their turn comes (speech-API workflow details and TTS
provider pricing verified fresh then). Each slice: own plan, TDD, review.

## Decisions made in this design session

| Question | Decision |
|---|---|
| Dev quota (20 req/day free tier) vs UI iteration | **SSE endpoint first, WITH a built-in mock mode** (`?mock=true`, gated by a dev env var). App gets built against the mock: unlimited free iterations, offline, deterministic. Real Gemini for end-to-end proof. Paid tier flip when the daily cap genuinely pinches (pre-authorized within the $20/mo budget). |
| Voice choosing | **Voice picks cards too** — via a cheap rules-based matcher (ordinals + word overlap), NOT an LLM classify call (which would cost a request + latency per utterance). Unmatched utterances fall through to free-form steering (graceful failure: your words still steer the story). Matcher = one pure function; upgradeable later in isolation. |
| Repo layout | **Monorepo**: Expo app in `app/` inside this repo; backend stays at root. |

## Verified technical facts (context7, 2026-07-02)

- **Expo's `fetch` streams response bodies on native** (`resp.body.getReader()`,
  documented for `text/event-stream`; global ReadableStream support on native).
  One SSE client implementation serves web and phone.
- **`expo-speech-recognition` (jamsch)** is maintained and wraps native iOS
  `SFSpeechRecognizer` / Android `SpeechRecognizer` / Web Speech API with
  start/stop + interim results — the push-to-talk shape. Caveat for slice C
  planning: native module ⇒ on-phone use likely requires an Expo **development
  build** rather than stock Expo Go; web needs nothing special.
- Node v24 + npm 11 installed (Expo prerequisites met).

## Slice A — backend streaming + mock mode (detailed)

New endpoint: `POST /continue/stream` — Server-Sent Events. Same request body
as `/continue` (`{template_id, summary, chosen_scenario}`).

**Event contract (the client builds against this):**

```
event: scene_token   data: {"t": "word "}            (many; as Gemini generates)
event: turn_complete data: {"summary": "...", "scenarios": ["...","...","..."]}
event: error         data: {"status": 429|502|503, "detail": "..."}   (terminal)
```

- Scene call uses Gemini's **streaming** API (`generate_content_stream`) via a
  new `call_gemini_stream` sibling of `call_gemini` (same 429/5xx/empty-text
  handling philosophy, label `"scene"`). The scribe call stays non-streaming
  (`generate_content`, label `"fold"`) — mechanical output, nothing to animate;
  it runs after the scene finishes, then `turn_complete` is emitted.
- **Retry semantics change at first byte:** retry/backoff applies only before
  the first token is sent. After bytes are flowing, failures emit a terminal
  `error` frame (you can't un-send half a scene). The client keeps whatever
  text already arrived.
- **Usage logging at stream end:** Gemini reports `usage_metadata` on the final
  stream chunk; log there. A client disconnect mid-stream must still log what
  was billed.
- **Mock mode:** `POST /continue/stream?mock=true` streams a canned scene
  word-by-word with realistic timing (~30–50ms/word) and a canned
  `turn_complete`. Zero Gemini calls. Gated by an env var (e.g.
  `DEV_MOCK_ENABLED=1` in `.env`) so it cannot exist in a production deploy.
  The mock doubles as a deterministic test fixture for all client animation
  work.
- **CORS middleware** added (browser dev loop calls the API cross-origin).
- The existing non-streaming `/continue` remains — the `/docs`-testable
  reference implementation, with its test net intact.
- Tests: pytest via `TestClient` streaming reads — event framing, mock mode
  (works with env var, 404/403 without), error-frame emission, turn_complete
  shape, regression on `/continue`.

## Slice B — Expo app + signature animation (detailed)

- **Location:** `app/` in this repo. Created with `create-expo-app`
  (TypeScript template — the Expo default; types double as documentation).
- **Screens** (Expo Router): **Home** — 4 genre cards (`GET /templates`),
  premise input with tappable `premise_seeds`; **Story** — streaming story
  view, then 3 option cards; tapping one sends the next `/continue/stream`
  turn. Client state = `{templateId, summary, scenes[], options[]}` in plain
  React state (client carries the summary, exactly as the backend expects).
- **`StreamingText` component — the signature animation.** Consumes a token
  stream (any async source: live SSE, mock, or test fixture — it never knows
  about networking). Words materialize with a soft fade/rise as they arrive.
  Exact easing/timing is a taste decision iterated live in the browser against
  the mock — the spec fixes the component's *interface*, not the animation
  values.
- **`lib/api.ts`** — the one module that talks to the backend: typed template
  fetch + SSE parser over Expo's streaming fetch. Base URL configurable
  (localhost for web; the PC's LAN IP for the phone).
- **Failure UX (a feature, not an afterthought):** 503 → "The muse is busy —
  tap to retry"; 429 → "Out of muse for today"; mid-stream error → keep all
  text that already appeared, offer retry of the turn. Never destroy story
  text the user watched materialize.
- Tests: component tests for `StreamingText` (fed by fixture streams) and the
  SSE parser; manual visual iteration against mock mode.

**Slice B done = the first demo:** browser: pick genre → premise → scene
materializes word-by-word → tap option → repeat. Then the same on the phone
via Expo Go, against real Gemini.

## Slice C — push-to-talk (outline; own design when its turn comes)

Hold-to-talk button; live interim transcript while speaking; on release the
utterance runs through the **card-matcher**: a pure function
`matchCard(utterance, cards) → index | null` using ordinals ("first/second/
third/last", "option N") plus simple word-overlap against card texts. Match →
that card is chosen (with visible feedback + brief cancel window); null →
utterance goes to `/continue` as free-form `chosen_scenario` (the backend
already supports this — no new API). `VoiceIn` interface hides Web Speech API
(web) vs `expo-speech-recognition` (native). No LLM, no network in matching.

## Slice D — narration v1 (outline; own design when its turn comes)

`VoiceOut` interface with abortable playback (stop control always visible).
TTS requests go **through the backend** — the same never-ship-a-key rule as
Gemini. Provider (ElevenLabs starter vs Google Cloud TTS, ~$5 experiment)
chosen at slice D design with fresh pricing. Device TTS (`expo-speech`) as
the free fallback. Audio seconds join `usage.jsonl`.

## Out of scope for all of Phase 2 (deliberate)

- `/expand` in the client (Phase 3 voice-editing brings it)
- Persistence/story IDs (Phase 3) — a page refresh may lose the story; accepted
- Hands-free/barge-in mode (Phase 5)
- Auth, quotas, billing (Phase 6)
- Word-synced narration highlighting (backlog)

## Verification (Phase 2 done when)

1. Slice-by-slice TDD + review, as established.
2. The roadmap's demo moment, live: hold the button, say "add a mysterious
   stranger", release → within seconds the story animates onto the screen
   while a decent voice narrates it — in the browser and on the phone.
3. `usage.jsonl` shows the whole turn's cost; mock mode shows zero-cost dev.
