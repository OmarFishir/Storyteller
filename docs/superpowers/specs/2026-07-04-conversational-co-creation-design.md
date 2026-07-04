# Conversational Co-Creation — Design Spec

**Date:** 2026-07-04
**Status:** Approved by owner (brainstorm session, same day)
**Supersedes nothing; layers on:** the story engine (Phase 1 + story
structure), slice A (SSE streaming), slice B (Expo client), slice C
(push-to-talk). Backend `/continue/stream` and the beat/length engine are
NOT redesigned — this spec adds a second channel beside them.

## Why this exists (origin)

After first playing the slice C demo, the owner's verdict: the turn loop is
too rigid — "not what I wanted at all." The actual vision is a free
conversation with the AI to build the story together: ask follow-ups about
offered scenarios ("tell me more about the first one"), break away mid-story
to discuss characters (depth, history), and get suggestions that emerge from
the conversation rather than a fixed pick-1-of-3 gate.

Diagnosis: the current engine routes EVERY utterance into plot. There is no
discussion channel — "tell me more about scenario 1" would be folded into
the story as a steering direction. The fix is a second channel, not a
rewrite.

## Owner decisions (made in the brainstorm, binding)

1. **Discussion shapes the story.** The AI answers questions AND remembers
   what was agreed — discuss a character's history and later scenes know it.
   Discussion invents canon going FORWARD only; it never rewrites scenes
   that already happened (that is Phase 3 voice-editing, out of scope here).
2. **No confirmation step.** The model routes each utterance silently and
   acts. A misroute must therefore be cheap: when the router is unsure it
   defaults to `discuss` (one cheap reply, story untouched). Slice C's
   confirm bar + 1.5s window are REMOVED from the voice path.
3. **Cards stay, as sparks.** Suggestions are still auto-offered after each
   scene (already generated at no extra cost) but framed as ideas, not a
   menu: ignorable, steerable-past, discussable, and refreshable ("give me
   different ideas" → a new set informed by the conversation).
4. **Discussion renders as chat bubbles inline in the story flow** — like
   margin notes in a manuscript. Scenes keep their look; bubbles are
   clearly "talk". The canonical story (verbatim scenes, in order — the
   standing hard invariant) is stored separately and can never contain
   bubbles.

## Architecture: two channels, tiered routing (Approach 1)

```
utterance (voice or, later, text)
   │
   ├─ TIER 0 (client, free): guarded-ORDINAL matchCard only
   │     "the second one" → instant pick → /continue/stream (unchanged)
   │
   └─ TIER 1: POST /converse/stream  (NEW — one cheap fused model call)
         ├─ intent: discuss  → streams reply bubble; notes scribe updates canon
         ├─ intent: pick(i)  → terminal frame; client fires /continue/stream
         ├─ intent: steer    → terminal frame; client fires /continue/stream
         │                     with the utterance VERBATIM (never paraphrased)
         └─ intent: options  → terminal frame carries 3 fresh scenarios
```

- `/continue/stream` remains the ONLY way scenes get written. Discussion
  never advances the turn/beat clock.
- **matchCard change:** only the guarded-ordinal tier stays in the routing
  fast-path. The word-overlap tier is RETIRED from routing — overlap cannot
  distinguish "do the iron door one" (pick) from "tell me more about the
  iron door one" (discuss). Content-referencing utterances go to the model.
  (Whether the overlap code is deleted or kept unexported is a plan-level
  choice; it must no longer route.)

## Client-carried artifacts (stateless backend, carry-it-yourself)

Existing: `summary`, `turn`, `length`. New:

- **`notes`** — the canon artifact. Capped ~120 words. Character facts,
  history, world truths agreed in discussion. Summary = *what happened*;
  notes = *what's true*. Scene prompts receive notes so the story honors
  the conversation.
- **`discussion` tail** — the last ≤ 6 exchanges (user/AI pairs count as 2),
  so "tell me more about *that*" resolves. Hard-capped for cost; older
  bubbles simply fall out of context (they remain visible in the UI feed).

**v1 knowledge limit (accepted):** discussion sees summary + notes + current
options + the tail — NOT full verbatim scenes. "What exactly did the letter
say?" gets a summary-level answer. Revisit when Phase 3 persistence lands.

## Backend contract

### `POST /converse/stream` (SSE; conventions mirror `/continue/stream`)

Request body:

```json
{
  "template_id": "noir",
  "utterance": "tell me more about the envelope one",
  "summary": "…",
  "notes": "…",
  "options": ["…", "…", "…"],
  "discussion": [{"role": "user", "text": "…"}, {"role": "ai", "text": "…"}],
  "turn": 3,
  "length": "short"
}
```

`turn`/`length` ride along for context/labeling only — `/converse` never
moves the clock. Validation mirrors `/continue` (404 unknown template, 422
bad shapes).

**The fused call:** ONE Gemini call (same cheap `MODEL`) is prompted to emit
its verdict FIRST — a single machine-readable intent line — then, only for
`discuss`, the reply prose. The backend consumes the intent line before
forwarding anything downstream:

- **`discuss`** → forward the prose as `reply_token` frames (`{"t": "…"}`).
  When the stream ends, a second tiny **notes scribe** call folds
  `{old notes + utterance + reply}` → updated notes (contract: stay under
  the cap, preserve established facts, newest detail wins on conflict).
  Terminal frame: `discussion_complete` `{"notes": "…"}`.
- **`pick`** → validate the index against `options`. In-range → terminal
  `route` frame `{"intent": "pick", "index": 1}`; the client fires
  `/continue/stream` with `options[1]` exactly as a tap would. Out-of-range
  (model says card 5 of 3, or `options` was empty) → the backend streams a
  FIXED clarification bubble (a constant string, e.g. "I only offered
  3 ideas — which one did you mean?") as `reply_token` frames plus
  `discussion_complete` with notes unchanged: deterministic, testable, no
  extra model call, never a 500, never a blind turn.
- **`steer`** → terminal `route` frame `{"intent": "steer"}`; the client
  fires `/continue/stream` with the utterance verbatim as
  `chosen_scenario`.
- **`options`** → the same fused call generates 3 fresh scenarios (3-4
  sentences each, meaningfully different, conversation-informed); terminal
  `route` frame `{"intent": "options", "scenarios": […]}`. No story turn.
- **Unparseable verdict / garbage first line** → clean 502 error frame
  (same philosophy as scribe-garbage today). When the MODEL is unsure it is
  instructed to answer `discuss` — the cheap, story-safe default.

**Error handling — identical contract to `/continue/stream`:** retry/backoff
(5xx) and clean 429 only BEFORE the first forwarded byte; any later failure
becomes a terminal `error` frame `{"status": …, "detail": "…"}`; tokens
already shown are kept. Reuses `call_gemini` / `call_gemini_stream` and the
`DETAIL_*` constants.

**Mock mode:** `?mock=true`, gated by the same `DEV_MOCK_ENABLED`, streams a
canned discussion exchange + canned route verdicts (cycling statelessly via
a marker in the carried `notes`, the established mock trick) — zero Gemini
calls; the client feed is buildable and demoable free.

### `/continue/stream` (and `/continue`): one additive field

Optional `notes: str = ""` — default reproduces today's behavior exactly (no
existing caller breaks). Scene prompt assembly order (caching contract):
static `STORY_PROMPT` → genre style → beat → **notes** → story-so-far →
chosen direction. The fold/summary contract is unchanged — summary stays
plot; notes stays canon and is NOT updated by the story fold (only the
notes scribe writes notes).

### Cost meter

New `usage.jsonl` labels: `converse` (fused call) and `notes_fold`. Output
caps (tune at plan time, these are the design intent): intent line ≈ a dozen
tokens inside the `converse` budget; discuss reply ≤ ~300 output tokens;
notes scribe ≤ ~200; options intent shares the converse call's budget sized
to 3 × 3-4-sentence cards. Levers: tail cap (6), notes cap (~120 words),
reply cap. Nothing in this layer is invisible to the meter.

## Client design

**The story screen becomes a typed feed** — one scrolling column:

```ts
type FeedItem =
  | { kind: "scene"; text: string }        // canonical; StreamingText
  | { kind: "user_bubble"; text: string }  // right-aligned chat bubble
  | { kind: "ai_bubble"; text: string }    // left-aligned; streams
  | { kind: "cards"; options: string[] };  // after each scene; replaceable
```

- The canonical story stays a separate `scenes: string[]` — the feed
  *references* scenes; bubbles physically cannot leak into the story.
- AI reply bubbles stream word-by-word and reuse the `StreamingText`
  animation with bubble styling — legal because replies are append-only,
  the one contract `StreamingText` demands. (Interim voice transcripts
  remain plain `Text` — that constraint is unchanged.)
- "Give me different ideas" replaces the CURRENT cards feed item in place.
- **Voice flow:** release-to-talk acts immediately (no confirm bar, no 1.5s
  window — removed). Ordinal → instant pick. Anything else → `/converse`.
- **The brake:** every streaming reply/scene shows a visible stop control —
  tapping it aborts the stream mid-word, silently (slice C's AbortSignal
  plumbing is the mechanism; a deliberate stop is never an error).
- PTT disabled only while something is streaming. Card taps unchanged.
- `lib/api.ts` gains `converse()` beside `streamTurn()` — same
  `streamingFetch` seam, same single `stream_error` channel.
- Home screen: unchanged in this build.

## Testing contract (house rules: Gemini mocked, tripwire enforced)

Backend: intent-line parsing (each intent; garbage → 502; out-of-range pick
→ downgrade, never 500), notes-scribe fold contract + cap, prompt assembly
ORDER pinned for both the converse prompt and the notes-augmented scene
prompt (caching contract), error-frame paths (pre-first-byte retry/429;
mid-stream → terminal error frame), mock mode (env gate 403, canned cycle,
zero Gemini calls), `/continue` back-compat (omitted `notes` → byte-identical
prompt to today).

Client: feed rendering (bubbles never enter `scenes`; cards item replaced in
place), ordinal fast-path makes NO network call, `/converse` event handling
(reply streaming, `discussion_complete` notes carry, `route` handoff firing
`/continue/stream` with the right `chosen_scenario`), notes + discussion
tail carried on every converse request and capped, stop-mid-reply keeps
partial bubble text, confirm-bar removal (utterance acts immediately),
PTT disabled while streaming.

## Out of scope (deliberate, so this stays one buildable increment)

- Rewriting past scenes (Phase 3 voice-driven editing).
- Persistence — notes, bubbles, and scenes still die with the session.
- Narration/TTS (slice D — to be designed AFTER this, against the feed
  model, since replies as well as scenes may eventually be spoken).
- Native build (parked on the owner's phone-OS answer).
- Any change to the beat/length engine or the summary/fold contract.
- Typed text input for discussion (voice-first now; the seam — utterances
  are just strings — makes typing trivial to add later).

## Risks / accepted trade-offs

- **Silent routing will sometimes guess wrong.** Mitigations: unsure →
  `discuss`; steering passes the utterance verbatim (no paraphrase drift);
  the stop control halts a wrong reply instantly. No confirm friction was
  the owner's explicit choice.
- **Discussion adds calls** (fused call + notes scribe per discussion turn).
  Accepted: they're the product. Capped, metered, cheap model.
- **Notes cap (~120 words) will eventually squeeze canon.** Accepted for
  v1; persistence (Phase 3) is the real fix.
