# Storyteller — Voice-First Product Roadmap

**Date:** 2026-07-02
**Status:** Approved
**Supersedes:** the "mobile app built LAST, tap-on-cards UI" framing in earlier docs.

## The product in one sentence

You *talk* to a storyteller; it narrates back with an expressive voice while the
story text animates beautifully on screen; you steer the plot by voice, from
genre templates, in either walkie-talkie or hands-free mode.

## Decisions made in this design session (2026-07-02)

| Question | Decision |
|---|---|
| Does the AI speak aloud? | **Yes — full voice conversation.** Expressive narration + text animating in sync. |
| Turn flow | **Both modes, as a user-selectable setting**: turn-based push-to-talk AND hands-free interruptible (barge-in). Users may switch day to day. Turn-based ships first; architecture keeps the hands-free door open from day one. |
| Platform | **Expo (React Native) with web preview.** One codebase; iterate in browser, run on phone. Voice APIs differ web vs native → hidden behind a thin voice layer. |
| Dev budget | **Up to ~$20/month** during development. Free tiers are the floor; one paid experiment at a time (quality TTS voice, paid Gemini tier when free-tier 503s block work). |
| Build order | **Experience-first.** Finish the minimal story loop, then immediately build a thin vertical slice of the defining experience (speak → animated text → narration). Riskiest bet validated earliest. |

## Four architecture rules (apply to every phase)

1. **Streaming everywhere.** Animations need text word-by-word, not in one blob.
   Every new backend endpoint streams (Server-Sent Events).
2. **Abortable audio from day one.** All narration playback must be stoppable
   mid-word. Hands-free barge-in later depends on this; retrofitting = rewrite.
3. **Voice behind an abstraction.** The app talks to thin `VoiceIn`/`VoiceOut`
   interfaces, never directly to a speech service. Web vs phone, cheap vs
   expressive — all swappable behind it (same philosophy as the `MODEL` constant).
4. **Cost meter from the start.** Every request logs tokens (later: audio
   seconds) per story. You can't cap what you can't see; the budget is enforced
   by looking, not hoping.

## Phases

Each phase gets its own brainstorm → spec → plan cycle when we reach it. This
roadmap is the map, not the terrain.

### Phase 1 — Complete the story engine *(backend, ~free)*

- **Running summary system**: new `/continue` endpoint — takes current summary +
  chosen scenario → returns updated summary + next 3 options. Client carries the
  summary each turn; backend stays stateless.
- **Genre template system v1**: templates as data files (genre, tone rules,
  opening premise seeds, style instructions injected into prompts).
  `GET /templates` lists them. Start with ~4 genres.
- **Token/cost logging** on every request.
- **GitHub remote** (moved up from "someday") — backup before anything grows.

**Done when:** a full story is playable end-to-end in `/docs` — pick a template,
suggest, choose, continue, repeat — with per-request token costs visible in a log.

### Phase 2 — The vertical slice: prove the magic *(client is born, ~$5–10/mo)*

The riskiest bet is "voice-directed storytelling with animated text feels good."
This phase tests exactly that; everything else stays thin.

- **Expo app skeleton** — developed in browser, run on phone via Expo Go.
- **Streaming story view** — signature animation #1: words materialize as the
  model generates them. Backend gets its first SSE endpoint.
- **Push-to-talk input** — hold, speak, release. On-device speech recognition
  (free): Web Speech API in browser, native recognizer on phone, behind `VoiceIn`.
- **Narration v1** — ~$5 of budget buys the early "wow": a quality TTS voice
  (ElevenLabs starter vs Google Cloud TTS — decided in that phase's design),
  device TTS as free fallback. Abortable playback built in.

**Done when:** hold button → say "add a mysterious stranger" → release → within
seconds the story animates onto screen while a decent voice narrates it.
That is the demo-to-anyone moment.

### Phase 3 — Make it a real product core *(depth, ~free)*

- **Story persistence** — SQLite server-side, story IDs; stateless summary
  graduates into saved sessions. Story library screen (resume, multiple stories).
- **Voice-driven editing** — "change the last scene, make him a villain" →
  `/expand` wired into the client. Signature animation #2: old text morphs into
  the new version.
- **Prompt caching + model tiering hooks** — remaining cost levers.
- **Latency & failure UX** — "the muse is busy" states, retry affordances,
  mic-permission flows. Voice apps live or die on how waiting feels.

### Phase 4 — Expressive narration *(voice quality, ~$5–15/mo)*

- **Streamed narration** — audio starts before the full text is generated
  (biggest perceived-latency win in the product).
- **Voice selection** — narrator voice per genre (noir = gravel, fairy tale = warmth).
- **Loose text/audio sync** — animation pace roughly follows narration.
  (Word-perfect karaoke sync stays a nice-to-have.)

### Phase 5 — Hands-free mode *(the second turn mode, hardest engineering)*

- Open mic with barge-in: interrupt the narrator mid-sentence, it adapts.
  Likely Gemini Live API (realtime bidirectional audio) — evaluated fresh at
  phase start; this corner of the ecosystem moves fast.
- Echo cancellation, wake behavior, battery reality.
- **The mode toggle** — walkie-talkie today, hands-free tomorrow.

Phases 2–4 build every prerequisite (streaming, abortable audio, voice
abstraction), so this phase is hard but not a rewrite.

### Phase 6 — Money *(public exposure)*

- **Accounts** (Apple/Google sign-in); **per-user quotas** on tokens AND audio
  seconds — runaway-user protection is the price of going public.
- **Free tier + subscription** (RevenueCat as the RN billing layer). Free tier
  sized so users carry the AI cost — the original thesis.
- **TestFlight beta → App Store.**
- **Content safety pass** (Gemini safety settings tuned per genre) — a story app
  will meet kids and edge cases.

## Features the app NEEDS (not in the original ask, but load-bearing)

- Mic permission UX
- Interrupted-session recovery (a phone call mid-narration)
- Offline / poor-network behavior
- Content safety filters
- Usage metering per user
- A "stop talking" control always on screen
- Silent-switch and audio-focus handling (music apps, calls)

## Nice-to-haves (backlog; none block anything)

- Word-synced text highlighting during narration (karaoke mode)
- Ambient soundscapes per genre
- Scene illustrations (image gen — expensive; revisit with revenue)
- Export story as ebook/PDF; share a story snippet
- Branching explorer ("what if I'd picked B?")
- Family/collab mode
- Multi-language

## Budget reality ($20/month during development)

- Phases 1 & 3: free.
- Phase 2: ~$5–10 (TTS experiment; paid Gemini tier if free-tier 503s block dev —
  already observed in practice).
- Phase 4: similar.
- Phase 5: realtime audio is the one to watch; sized at phase start.
- All service prices get verified against current pricing at each phase's design,
  never guessed from memory.
