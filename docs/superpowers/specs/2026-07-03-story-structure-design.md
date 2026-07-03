# Design: Story Structure, Story Length, and Richer Scenes/Options

**Date:** 2026-07-03
**Status:** Approved (pending implementation)
**Context:** First live play sessions (mock) exposed that stories wander with no
arc, options are thin (1–2 sentences), and scene prose is plot-only. Product
direction from the owner: stories progress through credible narrative
structures, run as short or as long as the user wants, and read with the
environmental detail of published fiction.

## Decisions made in this design session

| Question | Decision |
|---|---|
| Which structure per genre? | Noir: the owner-supplied 12-Step Mystery Formula. Others: researched, credibly-sourced arcs (below). All as template DATA. |
| Story length | User-chosen per story: **short / medium / long**. The arc STRETCHES (more scenes per beat); it never truncates. No hard stop ever — epilogue mode continues as long as the user keeps choosing. |
| Reading the full story | **Phase 3** (with persistence). Invariant recorded below. |
| Option length | 3–4 sentences per option (owner ask). Phase 4 flag: narrated options this long ≈ 30–40s of listening per turn — the narrator will likely summarize options rather than read them verbatim. |

## Hard invariant (owner requirement — no future phase may violate)

**The canonical story is the verbatim sequence of scenes exactly as generated.**
The running summary is AI working memory ONLY — it exists so the backend never
resends full history (cost spine) and it never appears in any reading
experience. "Stitch the full story together" = join the stored scenes; zero
summarization. (Today scenes live in client state per session; Phase 3
persistence makes them durable and adds the reading/export view.)

## The four structures (source-cited; encoded as data)

| Genre | Structure | Beats | Source |
|---|---|---|---|
| noir | 12-Step Mystery Formula | 12 | https://storytellingdb.com/12-step-mystery-formula/ |
| fantasy | The Hero's Journey (Vogler, *The Writer's Journey*) | 12 | https://en.wikipedia.org/wiki/The_Writer%27s_Journey:_Mythic_Structure_for_Writers |
| fairytale | The Story Spine (Kenn Adams) | 8 | https://www.npr.org/2026/06/23/nx-s1-5750619/meet-the-creator-of-the-story-spine-an-8-sentence-tool-to-create-and-analyze-stories |
| scifi | The Story Circle (Dan Harmon) | 8 | https://reedsy.com/blog/guide/story-structure/dan-harmon-story-circle/ |

Each `templates/*.json` gains:

```json
"structure": {
  "source": "<url>",
  "beats": [ { "name": "...", "guidance": "1-2 sentences of prompt guidance" }, ... ]
}
```

Loader validation (fail-loud at startup, matching existing philosophy):
`structure` is OPTIONAL; when present it must have a non-empty string `source`
and a non-empty `beats` list of objects each with non-empty string `name` and
`guidance`. A template without `structure` works exactly as today (no beat
lines in prompts) — graceful for future custom genres.

## Contract changes (backend, stateless as always)

`ContinueRequest` (both `/continue` and `/continue/stream`) gains:

- `turn: int = 1` — 1-based scene number, counted and sent by the client
  (same carry-it-yourself pattern as `summary`). Values < 1 → 422.
- `length: "short" | "medium" | "long" = "short"` — chosen once at story
  start on the Home screen and sent with every turn. Default preserves
  today's behavior/costs for old callers.

## Beat selection (pure function, unit-tested)

```
TURNS_PER_BEAT = {"short": 1, "medium": 2, "long": 3}
beat_index = (turn - 1) // TURNS_PER_BEAT[length]
beat_index < len(beats)  → current = beats[beat_index]
                            next    = beats[beat_index + 1] if it exists else EPILOGUE
beat_index >= len(beats) → EPILOGUE mode
```

EPILOGUE is a built-in constant, not per-template: guidance to wind down
gracefully, resolve remaining threads, and offer closure-leaning options —
while continuing to generate for as long as the user keeps choosing. A long
noir spends ~3 scenes inside each investigative beat (36-scene arc); a short
fairy tale completes its Story Spine in ~8 scenes.

## Prompt changes

1. **Storyteller call** (scene writing) gains, between genre style and the
   dynamic story content: `Current story beat: {name} — {guidance}`.
   The static `STORY_PROMPT` itself gains craft instructions (environmental
   storytelling): ground every scene in its place — sensory detail (sound,
   light, weather, texture), setting that carries story, the detail level of
   published fiction; not just plot-advancing dialogue.
2. **Scribe call** (fold) gains, in its dynamic section: `Steer the options
   toward the next story beat: {next.name} — {next.guidance}` (or the epilogue
   steering text). `FOLD_PROMPT`'s option instruction changes from "1-2
   sentences" to "3-4 sentences, meaningfully different, each a vivid direction
   the story could take".
3. **`/suggest`**'s `SYSTEM_PROMPT` options also become 3–4 sentences (same
   product surface; no beat awareness — it runs before the story starts).
4. Prompt ordering stays caching-friendly: static prompt → genre style
   (semi-static) → beat (semi-static) → summary/choice (dynamic).

## Token budgets (constants; scale with length)

| Call | short | medium | long | note |
|---|---|---|---|---|
| scene (`max_output_tokens`) | 600 | 800 | 1000 | room for environmental detail |
| fold (`max_output_tokens`) | 800 | 800 | 800 | 3 × 3-4-sentence options + summary |
| summary word contract (in prompt) | ~150 | ~200 | ~250 | longer stories carry more names/threads |
| `/suggest` | 600 | — | — | single value; options got bigger |

Cost honesty: worst case (long) ≈ ~1,800 output tokens/turn ≈ still well under
a cent on Flash-Lite. The meaningful cost implication is Phase 4 narration
(TTS bills per character) — flagged above.

## Client changes (small)

- **Home**: a length selector (Short / Medium / Long, default Short) shown with
  the premise input; passed to `/story` via params.
- **Story**: `TurnRequest` gains `turn` + `length`; `turn` derived as
  `scenes.length + 1` at request-build time (retry resends the frozen
  `pendingTurn` unchanged, so retries never advance the beat clock).
- Existing call-shape tests updated; a new test pins that retry keeps the same
  `turn`.

## Mock mode

Unchanged mechanically (canned 3-scene cycle, marker-driven). Its canned
`scenarios` get rewritten to 3–4 sentences so the cards preview the real feel.
The mock ignores `turn`/`length`/structure — it exercises the pipe, not the
prompts.

## Out of scope (deliberate)

- Reading view / export — Phase 3 (with persistence), per owner decision.
- "Wrap it up now" explicit ending command — natural voice feature, slice C+.
- Per-beat model tiering (expensive model for Climax beats) — future lever the
  two-call split already enables.

## Verification

1. TDD: pure beat-selection tests (all lengths, boundaries, epilogue);
   loader structure validation; prompt-injection tests (capture `contents`,
   assert beat names appear at the right turns/lengths); budget pins per
   length; client turn/length shape tests incl. retry-same-turn.
2. All four `templates/*.json` load with valid structures at startup.
3. **Live arc quality cannot be verified on the free tier** (a short noir arc
   = 24 Gemini calls > 20/day cap). Plumbing is test-pinned now; the arc
   *feel* test needs the paid-tier flip (pre-authorized) or accumulation of
   free-tier days. This spec's value lands fully only after that run.
