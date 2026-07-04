# Storyteller — Project Context for Claude

This file loads automatically at the start of every session. It's the
self-loading version of the project handoff. Keep it current as the project grows.

## What this project is

**Storyteller** is a **voice-chat-first**, AI-assisted story maker. The user
*talks* to a storyteller; it narrates back with an expressive voice while the
story text animates on screen. The user steers the plot by voice, starting from
genre templates. Two turn modes, user-selectable per session: push-to-talk
(walkie-talkie) and hands-free interruptible (barge-in). Core story loop:

1. User picks a genre template and gives/speaks a premise.
2. AI suggests 3 short, distinct next-scenario options.
3. User picks one by voice, optionally expands/edits it by voice.
4. AI folds the choice into the running story (summary), narrates, suggests next 3.
5. Repeat.

It's a personal learning + portfolio project. Full roadmap (approved 2026-07-02):
`docs/superpowers/specs/2026-07-02-voice-first-roadmap.md` — READ IT before
planning any new feature work.

## Goals, in priority order

1. Real **AI-engineering practice** (the interesting work is the backend).
2. A **portfolio piece**.
3. Reinforce **IU B.Sc. Software Development + IBM GenAI** coursework.
4. Ideally **make some money** — the path to that IS the cost-control engineering
   below (capped free usage + paid tiers), not a separate feature.

Not trying to beat Sudowrite/NovelAI commercially. The app is the vehicle; the
engineering is the point.

## How to work with the project owner

- They direct AI tools to build things and are **actively learning to code** — not
  yet fluent in Python/backend idioms.
- **Teach as you go:** when a new concept/tool/term comes up, explain it in plain
  English in a sentence or two, like a mentor on the job.
- Keep responses concise by default; go deep only when asked.
- Tell them what they NEED to hear, not what they want to hear. Push back on bad ideas.
- **Design in chat first, then implement.** Brutally small increments — prove one
  endpoint works before adding the next.
- When something breaks, read the terminal traceback's LAST line first, don't guess.
- **The doc is a story about the code; the code is the truth.** Always read the
  actual code before building on assumptions about it.

## Stack decisions (already made)

- **Backend:** Python 3.14 + FastAPI. This is where the AI engineering lives.
- **LLM provider:** Google Gemini, model `gemini-2.5-flash-lite` (cheapest tier).
  Kept in ONE constant `MODEL` in `main.py` so providers/models swap in one place.
  Developed against the free Google AI Studio tier.
- **Frontend:** React Native via **Expo with web preview** — one codebase,
  iterate in a browser tab, run the same code on the phone via Expo Go. The
  client is CENTRAL to this product (voice + animations), not an afterthought —
  it arrives in roadmap Phase 2 as a thin vertical slice.
- **Architecture rule (critical):** the API key NEVER lives in the mobile app.
  Flow is: mobile app → our FastAPI backend (holds key) → Gemini. The backend is
  mandatory because anything shipped to a phone can be cracked open.

## Four architecture rules for the voice-first build (every phase)

1. **Streaming everywhere.** Text animations need words as they're generated.
   Every new backend endpoint streams (Server-Sent Events).
2. **Abortable audio from day one.** All narration playback must be stoppable
   mid-word — hands-free barge-in depends on it; retrofitting = rewrite.
3. **Voice behind an abstraction.** Thin `VoiceIn`/`VoiceOut` interfaces; never
   call a speech service directly. Web vs phone, cheap vs expressive voices —
   all swappable (same philosophy as the `MODEL` constant).
4. **Cost meter from the start.** Log tokens (later: audio seconds) per request
   per story. You can't cap what you can't see.

## Cost philosophy (the spine)

Users carry AI cost via pricing/quotas; the provider bills per-token. Scale is fine
IF free usage is capped. Cost levers, in order of impact:

1. **Don't resend the whole story every turn.** Maintain a compact running SUMMARY
   and send that + the current scene. **Built** — `POST /continue`'s "scribe" call
   folds each new scene into a ~150-word summary; the client carries it, so the
   backend never resends full story history.
2. **Model tiering:** cheap model for suggestions/short edits; reserve expensive
   model for moments that matter.
3. **Prompt caching:** static template/system text is identical every call; cached
   input is ~10x cheaper. Put static text at the front. (NOT built yet.)
4. **Cap output length** via `max_output_tokens` — output tokens cost 3–8x input.
5. **Voice costs (new with voice-first):** text-to-speech bills per character,
   realtime voice APIs bill per audio minute. Same discipline applies: meter it,
   cap it, make paying users carry it.

**Dev budget: up to ~$20/month.** Free tiers are the floor; one paid experiment
at a time (quality TTS voice, paid Gemini tier when free-tier 503s block work).
Verify current prices at each phase's design — never from memory.

## What's BUILT and WORKING

FastAPI server in `main.py`:

- **CORS** — wide-open (`allow_origins=["*"]`) so the browser-based Expo dev loop
  (a different origin) can call this API. Dev-only stance; must be locked down
  before any public exposure (roadmap Phase 6).
- `GET /` — health check, returns `{"status":"ok",...}`.
- `GET /templates` — lists the 4 genre templates (`fantasy`, `noir`, `scifi`,
  `fairytale`) as `{id, name, description, premise_seeds}`. The `style` field
  (prompt-injection text) stays server-side, never returned to the client.
  Templates are DATA — one `templates/*.json` file per genre — loaded fail-loud
  at startup by `story_templates.py` (missing keys, empty `premise_seeds`, or a
  duplicate id crashes on boot, not mid-request). Each template also carries an
  OPTIONAL `structure` block — a sourced narrative arc as an ordered list of
  beats (`{name, guidance}`) — validated the same fail-loud way when present
  (non-empty `source` URL; non-empty `beats`; every beat a non-empty `name` +
  `guidance`) and, like `style`, never returned by this endpoint. All four
  shipped genres have one: `noir` → the 12-Step Mystery Formula (12 beats,
  storytellingdb.com); `fantasy` → the Hero's Journey per Vogler's *The
  Writer's Journey* (12 beats, Wikipedia); `fairytale` → Kenn Adams's Story
  Spine (8 beats, via an NPR piece); `scifi` → Dan Harmon's Story Circle (8
  beats, via a Reedsy guide). A template without `structure` still works
  exactly as before (no beat line in prompts) — the hook for future
  custom/unstructured genres.
- `story_beats.py` — `select_beats(structure, turn, length) -> (current, next) | None`,
  the pure function turning "which turn, how long a story" into "which
  narrative beat" — stateless, the same carry-it-yourself pattern as the
  running summary. `TURNS_PER_BEAT = {"short": 1, "medium": 2, "long": 3}` sets
  how many scenes the arc spends inside each beat — this is what STRETCHES a
  longer story instead of truncating it: `beat_index = (turn - 1) //
  TURNS_PER_BEAT[length]`. Once `beat_index` runs past the structure's last
  beat, `select_beats` returns a built-in `EPILOGUE_BEAT` (not per-template)
  forever after — **stories never hard-stop**: past the arc's end the guidance
  leans toward winding down and resolving threads, but generation keeps going
  for as long as the reader keeps choosing. A `None` structure (a genre with no
  arc) makes `select_beats` return `None`, and every beat-aware prompt piece
  below no-ops cleanly.
- `POST /suggest` — `{"premise": "...", "template_id": "..." (optional)}` →
  `{"scenarios": ["...","...","..."]}`. Uses a static `SYSTEM_PROMPT` forcing raw
  JSON, plus `parse_scenarios()` which defensively strips code fences and
  validates a list of strings (raises a clean 502 on bad output). Each option
  is 3-4 sentences and vivid (`max_output_tokens=600`, up from 300 in the
  1-2-sentence era). When `template_id` is given, `get_template_or_404()`
  injects that genre's `style` into the prompt (404 on an unknown id); omitted,
  `/suggest` behaves as before.
- `POST /expand` — `{"scenario": "...", "instruction": "..."}` →
  `{"original": "...", "expanded": "..."}`. Refines a chosen scenario per a
  plain-English instruction ("make it darker"). Static `EXPAND_PROMPT`,
  `max_output_tokens=600`, `temperature=0.8`. Returns prose directly (NO JSON
  parsing — simpler than /suggest). Echoes `original` from the request rather than
  paying the model to reproduce it.
- `POST /transcribe` — the audio slice's EARS. Multipart `audio` file in →
  `{"transcript": "..."}` out. ONE Gemini call on the shared `MODEL` constant
  (`[TRANSCRIBE_PROMPT, Part.from_bytes(data, mime_type=audio.content_type or
  "audio/webm")]` — static prompt first, the caching-order convention;
  `STT_BUDGET=200`, `temperature=0.0` since transcription is mechanical, zero
  creativity wanted), label `stt`. `MAX_AUDIO_BYTES=2_000_000` (~2MB) rejects
  an oversized clip with a 413 BEFORE any model call — a push-to-talk clip is
  seconds long, never that big. Audio input bills as ordinary input tokens
  (~30/sec of speech), so the existing token meter captures STT cost with
  zero schema change. Reuses `call_gemini` end to end, so its whole
  retry/429/empty-response contract applies unchanged. New dep:
  `python-multipart` (FastAPI needs it to parse multipart/form-data).
- `POST /narrate` — the audio slice's MOUTH. `{"text": "...", "kind": "scene"
  | "reply"}` → raw `audio/wav` bytes. `call_gemini_tts` calls Gemini's TTS
  path on its own `TTS_MODEL = "gemini-2.5-flash-preview-tts"` constant
  (swap-in-one-place, same philosophy as `MODEL`) with `VOICE_NAME = "charon"`
  (v1: one narrator voice; per-genre voices are Phase 4) and
  `TTS_BUDGET=4000` audio tokens (~2.5 min of speech), label `tts`. Mirrors
  `call_gemini`'s error contract (retry 5xx w/ backoff, clean 429, an
  empty/missing audio part → 502) — a third copy of the retry block;
  extraction to a shared helper is queued for the Phase 3 `main.py` split,
  consistency wins until then. `pcm_to_wav` (stdlib `wave`, no new dep) wraps
  the model's raw 16-bit PCM in a WAV container at 24kHz mono — browsers
  can't play bare PCM. `NARRATE_CHAR_CAP=6000` → 413 before any model call
  (scenes are already budget-bounded; this is abuse armor for arbitrary
  text). `kind` is accepted but not yet used to vary voice/style — a future
  hook.
- `POST /continue` — `{"template_id": "...", "summary": "...", "chosen_scenario": "...",
  "turn": 1, "length": "short", "notes": ""}` → `{"scene": "...", "summary": "...", "scenarios": [...]}`.
  The running-summary turn — the first cost-control piece actually wired up: the
  client carries the summary, so the backend stays stateless and never resends
  full story history. `turn` (1-based scene number, default `1`, `ge=1` → 422
  below that) and `length` (`"short" | "medium" | "long"`, default `"short"`)
  are carried by the client on every turn too (same carry-it-yourself pattern
  as `summary`) and drive beat selection + the token budgets below; the
  defaults reproduce pre-structure behavior for any old caller. `notes`
  (new, default `""`) carries the discussion channel's canon — see
  `/converse/stream` below — into the scene prompt ONLY; the fold call that
  updates the running summary never sees it, because summary = what HAPPENED
  and notes = what IS TRUE, kept deliberately separate. Two Gemini
  calls per turn: (1) the "storyteller" (`build_scene_prompt`,
  `max_output_tokens=SCENE_BUDGETS[length]`, `temperature=0.9`) writes the next
  scene as pure prose — no JSON, so creative writing never fights JSON
  formatting — assembled in caching-friendly order: static `STORY_PROMPT` →
  genre style → current beat's `{name} — {guidance}` (via
  `story_beats.select_beats`, only when the template has a `structure`) →
  established story notes (`req.notes`, omitted entirely when empty, so an
  empty-notes call reproduces a byte-identical prompt to pre-notes behavior,
  pinned by test) → story-so-far → chosen direction. `STORY_PROMPT` itself now also carries an
  environmental-craft instruction: ground every scene in concrete sensory
  detail (sound, light, weather, texture) the way published fiction does, not
  just plot-advancing dialogue. (2) the "scribe" (`build_fold_prompt`,
  `max_output_tokens=FOLD_BUDGET`, `temperature=0.7`) folds the new scene into
  an updated summary (contract: stay under `SUMMARY_WORDS[length]` words,
  preserve named characters/facts/unresolved threads) and proposes the next 3
  options — each 3-4 sentences, meaningfully different, steered toward the
  beat the NEXT TURN will land in: `story_beats.select_beats(structure, turn
  + 1, length)`'s CURRENT beat, not the structurally-next one — the same beat
  the arc is still lingering in on medium/long (options generated at turn t
  are consumed at turn t+1, which is often still inside turn t's beat), the
  following beat only on that beat's last turn, and the epilogue past the
  arc's end.
  Budgets scale with `length`: `SCENE_BUDGETS = {"short": 600, "medium": 800,
  "long": 1000}` (room for environmental detail), `FOLD_BUDGET = 800` (flat —
  sized for 3 × 3-4-sentence options plus the summary), `SUMMARY_WORDS =
  {"short": 150, "medium": 200, "long": 250}` (a longer story needs more room
  to retain names/threads). Reuses `parse_model_json()`/`validate_turn_payload()`
  and `get_template_or_404()` from `/suggest`.
- `POST /continue/stream` — SSE twin of `/continue`, same request body, plus an
  optional `?mock=true`. Streams `scene_token` frames (`{"t": "..."}`) as the
  scene is generated, then one `scene_token*` → `turn_complete`
  (`{"summary": "...", "scenarios": [...]}`) or, on any failure, a terminal
  `error` frame (`{"status": ..., "detail": "..."}`) instead — the client keeps
  every token already shown, since you can't un-send half a scene. Retry/backoff
  and the clean 429 only apply BEFORE the first byte of the scene; once
  streaming has started, any failure (mid-stream 5xx, 429 from the follow-up
  fold call, etc.) becomes a terminal error frame instead of a retry. Mock mode
  (`?mock=true`, gated by `DEV_MOCK_ENABLED=1` in `.env`, 403 if unset) streams
  one of 3 canned scenes word-by-word with realistic pacing and a canned
  `turn_complete`, self-advancing statelessly through that 3-scene cycle via a
  `"(mock turn N)"` marker embedded in the `summary` the client carries back —
  the same carry-it-yourself trick as the real engine (fixed after live play
  made a repeating scene indistinguishable from a duplication bug) — zero
  Gemini calls, doubles as the client-animation dev fixture. Mock mode ignores
  `turn`/`length` entirely — it exercises the pipe, not the prompts (verified:
  `turn=5, length="long"` still streams the correct next canned scene).
- `POST /converse/stream` — the conversation channel beside the story engine,
  same SSE shape and error contract as `/continue/stream`. Request:
  `{"template_id": "...", "utterance": "...", "summary": "...", "notes": "",
  "options": [...], "discussion": [...], "turn": 1, "length": "short"}` —
  stateless, carry-it-yourself like `/continue`; `discussion` is the last
  <=6 `{role: "user"|"ai", text}` entries (belt-and-braces cap — the client
  caps it too). ONE fused cheap-model call (`build_converse_prompt`, label
  `converse`, `CONVERSE_BUDGET=600`, `temperature=0.8`) whose FIRST LINE is a
  machine-readable intent verdict — `INTENT: discuss | steer | options |
  pick N` (`parse_intent_line`; N is 1-based in the model's mouth, converted
  to a 0-based index on the wire) — and the prompt explicitly instructs
  unsure → discuss, the cheap, story-safe default (a misroute costs one
  reply, never a polluted story). Four routes: `discuss` streams the reply
  prose that follows the intent line as `reply_token` frames, then a second
  tiny call (`build_notes_prompt`, label `notes_fold`, `NOTES_BUDGET=200`,
  `temperature=0.7`, capped at `NOTES_WORDS=120` words) folds any new durable
  fact into the notes, ending in `discussion_complete {"notes": "..."}` —
  summary = what HAPPENED (the fold call owns it), notes = what IS TRUE
  (only this call ever writes notes). `steer`/`pick`/`options` never touch
  the notes scribe and never stream prose — each emits ONE terminal `route`
  frame (`{"intent": "pick", "index": N}` / `{"intent": "steer"}` /
  `{"intent": "options", "scenarios": [...]}`, the last validated through the
  same `parse_scenarios` as `/suggest`) for the client to act on. An
  out-of-range or number-less pick downgrades to `pick_invalid` → a FIXED
  clarification string (`pick_clarification`, no extra model call) streamed
  as one `reply_token` + `discussion_complete` with notes UNCHANGED — never a
  500, never a blind turn. A first line that isn't a recognizable INTENT
  line at all is model garbage → clean 502 error frame. Same SSE error
  contract as `/continue/stream`: anything after streaming starts becomes a
  terminal `error` frame; tokens already sent are kept. Mock mode
  (`?mock=true`, `DEV_MOCK_ENABLED` gate, 403 if unset) triggers on the
  utterance text alone: "idea"/"option" → canned `options` route
  (`MOCK_TURNS[0]`'s scenarios); an utterance starting "she "/"he "/"they " →
  canned `steer` route; anything else → a canned discuss reply + canned
  notes (`MOCK_CONVERSE_REPLY` / `MOCK_CONVERSE_NOTES`) — zero Gemini calls.
- `call_gemini(contents, max_tokens, temperature, label="unlabeled")` — the ONE
  shared helper every endpoint uses. Error handling (hardened after the Phase 1
  final review): retries transient `errors.ServerError` (5xx) up to 3 times with
  exponential backoff (1s, 2s, 4s), clean 503 on exhaustion (verified live); a
  429 quota `ClientError` raises a clean 429 immediately (NO retry — backoff
  can't fix a daily cap; other 4xx re-raise); an empty/None `response.text`
  (safety block / no candidates) raises a clean 502 instead of leaking
  `"scene": null` into a story as a false 200. Also logs every call's token
  usage (below) — the cost meter lives here because every endpoint funnels
  through this one function.
- `call_gemini_stream(contents, max_tokens, temperature, label="unlabeled")` —
  streaming sibling of `call_gemini`: a generator yielding the model's text
  chunk by chunk via `generate_content_stream`, for `/continue/stream`'s scene
  call. Retry/backoff (5xx) and the clean 429 apply only BEFORE the first
  chunk — a generator, so those raise on first `next()`, not at call time; once
  a chunk has been yielded, a mid-stream 5xx is mapped to a clean
  `HTTPException(503)` (→ a clean 503 error frame downstream, not a raw-text
  500 — final-review fix, live-verified failure mode). Usage is logged once the
  stream ends, in a `finally` block, so a mid-stream failure or client
  disconnect still records whatever usage was seen by then. User-facing detail
  strings live in the `DETAIL_MODEL_BUSY` / `DETAIL_QUOTA` constants.
- `usage_log.log_usage(label, model, input_tokens, output_tokens)` — appends one
  JSON line per Gemini call to `logs/usage.jsonl` (git-ignored). Labels in use:
  `suggest`, `expand`, `scene`, `fold`, `converse`, `notes_fold`, `stt`, `tts`. A logging failure is swallowed (it must
  never break the request it's measuring) but warns on stderr so a dead meter is
  visible. The whole "dashboard" for now is opening the file.

**Hard invariant (owner requirement — no future phase may violate):** the
canonical story is the verbatim sequence of scenes exactly as generated. The
running summary is AI working memory ONLY — it exists so the backend never
resends full history (the cost spine above) and it never appears in any
reading experience. "The full story" = joining the stored scenes verbatim,
zero summarization. Scenes live in client state per session today; the
reading/export view arrives with persistence in Phase 3. Full design:
`docs/superpowers/specs/2026-07-03-story-structure-design.md`.

Tests in `tests/test_api.py`, `tests/test_templates.py`, `tests/test_beats.py`,
`tests/test_converse.py`, and `tests/test_audio.py`
(pytest + FastAPI `TestClient`, **115 tests** — up from 103; the delta is
`test_audio.py`'s new 12-test suite): health
check; retry-then-succeed
and retry-exhaustion → 503; 429-without-retry and other-4xx passthrough;
empty-response → 502; /suggest shape bare and with `template_id` (404 on
unknown; prompt ORDER pinned: static prompt → genre style → premise, the
caching contract); /expand shape and validation (422); /continue's
scene+summary+scenarios shape, call order (`scene` then `fold`), per-call cost
caps pinned ((600,0.9)/(800,0.7)), its 404/422/502 paths incl.
structurally-bad scribe JSON, plus 422 on a bad `turn`/`length`;
`parse_model_json` fence-stripping and non-object rejection; usage-log
appends, logging-failure resilience + stderr warning; the template loader's
validation (missing keys, duplicate ids, empty dir, and — new — the optional
`structure` block: missing `source`, empty `beats`, a beat missing
`name`/`guidance` all fail loud) plus the real `templates/` dir loading all
four genres AND their sourced structures; `story_beats.select_beats`'s pure
turn/length → beat math (short/medium/long turns-per-beat, epilogue forever
past the last beat, `None` structure → `None`); `build_scene_prompt`/
`build_fold_prompt` injecting the current/next beat's name+guidance and the
environmental-craft instruction at the right turns and lengths, including the
epilogue case past the arc; the scene token budget scaling with `length`; the
9 canned mock scenarios mechanically pinned to 3-4 sentences each;
`call_gemini_stream`'s chunk yielding + usage logging, retry-before-first-chunk,
429-no-retry, empty-stream 502, and usage logged on early close (client
disconnect mid-stream); `/continue/stream` mock mode (env-gate 403 when unset,
canned scene streams correctly, 404 on unknown template before streaming
starts); CORS headers present; the real streaming path emitting `scene_token*`
→ `turn_complete`, scribe-garbage becoming an `error` frame, and a mid-stream
failure keeping already-sent tokens; a regression test pinning `/continue`'s
behavior unchanged after its validation was refactored into the shared
`validate_turn_payload()` helper; and — new for `/continue`'s `notes` field —
the scene prompt slotting notes between the current beat and the
story-so-far, an empty-notes prompt staying byte-identical to pre-notes
behavior, and `/continue/stream` accepting and using `notes`.
`tests/test_converse.py` covers the whole `/converse/stream` channel:
`parse_intent_line` for all four intents plus case/whitespace tolerance, an
out-of-range or number-less pick downgrading to `pick_invalid` (never a
crash), a non-INTENT first line raising a clean 502; `pick_clarification`'s
card-count wording (incl. the zero-cards case); `parse_notes`'s happy path
and its missing-key 502; `build_converse_prompt`'s pinned assembly order
(static → style → notes → summary → options → discussion → utterance) and
its empty-context placeholders; `build_notes_prompt` carrying the word limit
and all three pieces; the real streaming path — discuss streaming
`reply_token`s then folding notes via the separate `notes_fold` call,
pick/steer/options each emitting exactly one `route` frame (empty options
scenarios → error frame), an invalid pick answering with the fixed
clarification and unchanged notes with NO scribe call reached, a garbage
intent line and notes-scribe garbage both becoming 502 error frames, a
mid-stream failure keeping already-sent tokens, and 404/422 before streaming
starts; plus mock mode (env-gate 403 when unset, the canned discuss reply +
canned notes, and the "idea"/"option" → options and "she/he/they " → steer
utterance triggers). `tests/test_audio.py` covers the whole audio slice
(parse-helpers/`TestClient` duplicated from `test_api.py` on purpose — tests
aren't a package, consolidation rides with the Phase 3 split): `/transcribe`'s
stripped-transcript happy path with contents ORDER pinned (static prompt
first) and its `stt`/`STT_BUDGET`/`temperature=0.0` call args, the client's
`content_type` passed through as the audio part's mime type, `MAX_AUDIO_BYTES`
413 firing before any model call, a missing multipart file's 422, and Gemini
errors mapping through unchanged; `/narrate`'s WAV response + `tts`
usage-log row, `pcm_to_wav` producing a valid RIFF container, the
`NARRATE_CHAR_CAP` 413, a missing `text` field's 422; and `call_gemini_tts`'s
PCM extraction + usage logging, its 502 when no audio part comes back, and
its clean 429 mapping — the same contract as `call_gemini`. Tests MOCK the
Gemini layer — enforced
structurally: `tests/conftest.py` sets a dummy `GEMINI_API_KEY` (suite runs on
a clean clone, no `.env` needed) and an autouse tripwire makes any un-mocked
Gemini call fail loudly. Run: `venv\Scripts\python.exe -m pytest tests/ -v`.

Live-verified against real Gemini (2026-07-02): `/templates` → `/suggest` with
`template_id=fantasy` → `/continue` produced a real fantasy-style scene and a
58-word summary that correctly retained the story's key location by name. A
second `/continue` turn hit the account's free-tier *daily* request cap (20
req/day; `/continue` burns 2/turn) — expected free-tier friction, not a defect;
it now surfaces as a clean 429. Minor known wrinkle (deliberately riding to
Phase 6): per-minute 429s get the same "daily quota" message as daily-cap 429s.

Live-verified `/continue/stream` (2026-07-03): mock mode (`?mock=true`) — 62
`scene_token` frames reassembling exactly to `MOCK_SCENE`, one `turn_complete`
matching `MOCK_TURN`, zero Gemini calls. Real path — two attempts, each showing
genuine incremental token streaming from Gemini; attempt 1's scene was cut off
mid-stream by a transient 503 (model overload), correctly surfacing as a
terminal `error` frame; attempt 2's scene streamed to completion but the
follow-up fold call then hit the free-tier request cap, again correctly
surfacing as a terminal `error` frame (`status: 429`). Both confirm the
mid-stream failure → error-frame contract works against the real API; the
full happy path (`scene_token*` → `turn_complete` against live Gemini) should
be re-attempted on a fresh-quota day before slice B's end-to-end test.

Live-verified structured `/continue` (2026-07-03): one real turn against
`template_id="noir"`, `turn=1`, `length="short"` returned 200 (quota happened
to allow it this run — the free-tier daily cap isn't guaranteed available; a
429 here is an accepted contingency, not a defect). The scene read as a
genuine mystery OPENING (beat 1, "Disclose the Mystery"): a detective meets a
mayoral aide in a rain-soaked alley and is handed a sealed envelope tied to a
crime the mayor wants "gone. Permanently." All 3 returned options pushed
toward investigating that envelope (open it now, take it back for controlled
analysis, or press the aide for more) — exactly the direction beat 2, "Set
the Sleuth on the Path", steers toward. The full multi-turn arc (an early beat
through the epilogue) still can't be verified on the free tier — a short noir
arc alone is 24 Gemini calls — and remains blocked pending a paid tier, per
the design spec.

Live-verified the audio slice (2026-07-04, in-process `TestClient` vs real
Gemini): `/narrate` on `{"text": "The rain fell on the empty street.", "kind":
"scene"}` returned 200, `content-type: audio/wav`, 138,810 bytes of audio, and
a `tts` row landed in `logs/usage.jsonl` on the FIRST try — `TTS_MODEL =
"gemini-2.5-flash-preview-tts"` is live and correct, the `gemini-3.1-flash-tts`
contingency swap was NOT needed. `/transcribe` on a stdlib-generated 1-second
silent WAV (16kHz mono, all-zero samples) hit the account's free-tier *daily*
request cap — a clean `429` (`{"detail": "Daily AI quota reached..."}`), not a
500 or stack trace, so the contract held; no `stt` row was logged (expected —
`call_gemini`'s 429 branch raises before a response, hence before usage
logging, ever happens) and the transcription-quality question itself
(silence in, near-empty text out) remains unverified pending a fresh-quota
day. Both endpoints' error contracts (200/413/422/429/502/503) are otherwise
pinned by `test_audio.py` alone.

Supporting files: `requirements.txt` (fastapi, uvicorn, python-dotenv, google-genai,
pytest, python-multipart), `.env.example` (template), real `.env` (holds `GEMINI_API_KEY`, git-ignored),
`.gitignore` (ignores `.env`, `venv/`, `__pycache__`, `logs/`), `story_templates.py`
(genre-template loader), `usage_log.py` (cost meter), `templates/*.json` (the 4
genres). Design docs live under `docs/superpowers/specs/` and `docs/superpowers/plans/`.

Public on GitHub: `github.com/OmarFishir/Storyteller`, branch `master` tracking
`origin/master`.

### Client app (`client/`)

Expo Router + TypeScript, SDK 57 (React Native 0.86, React 19.2.3). Lives in
`client/`, not `app/` — Expo Router's file-based routing owns an `app/` folder
*inside* the project, so the project root needed a different name (approved
deviation from the original spec's `app/`).

- **Screens** (`client/app/`): `index.tsx` (Home) — loads `GET /templates`,
  renders a genre card per template plus tappable premise-seed chips that fill
  the premise box, a story-length picker (chip row: `Short` / `Medium` /
  `Long`, default `Short`, styled like the genre-card selection highlight),
  "Begin the story" routes to `/story` carrying the chosen `length` as a route
  param alongside the template/premise. A compact `PushToTalk` mic sits beside
  the premise box (rendered only once a template is selected and voice input
  is available); the final transcript replaces the premise value directly —
  the input itself is the confirm step, no separate confirmation UI on Home.
  `story.tsx` (Story) — a typed feed drives the screen: `FeedItem` is
  `{kind: "scene", text}` | `{kind: "user_bubble", text}` |
  `{kind: "ai_bubble", text}` | `{kind: "cards", options}`, rendered in order
  inside one `ScrollView`. `scenes` (the array of verbatim scene strings)
  stays separate from `feed` and remains the canonical story + turn clock
  (`turn: scenes.length + 1` on every request) — the hard invariant above is
  untouched by the conversational feature. `runTurn` (against
  `POST /continue/stream`) is unchanged in shape: `token` events accumulate
  into `StreamingText`, `turn_complete` archives the scene into both `scenes`
  and `feed` (a scene item + a fresh `cards` item for the server's returned
  options, after dropping any leftover `cards` item — an offer is consumed by
  the next turn) and updates `summary`; `turn`/`length` carrying, the
  `resolveStoryLength()` fallback, and the frozen-retry-object semantics are
  all as before. A spoken (or typed) utterance flows through
  `handleUtterance`: `matchCard(utterance, options)` — now ORDINALS ONLY,
  see `lib/matchCard.ts` below — either fires `handleChoose` (the SAME
  `runTurn` path option-card taps use) INSTANTLY, no confirm window, or falls
  through to `runConverse(utterance)`. **The slice C confirm bar and its 1.5s
  auto-fire window are REMOVED** (owner decision: silent routing — an
  ordinal match is unambiguous enough to act on immediately, and anything
  else is better served by an actual conversational reply than a guessed
  paraphrase). `runConverse` posts to `POST /converse/stream` carrying
  `utterance, summary, notes, options, discussion` (the last <=6 turns,
  capped the same way on both sides) plus `turn`/`length`; it optimistically
  appends a `user_bubble` to the feed and the discussion tail, streams
  `reply_token`s into a live `ai_bubble` (`StreamingText`, keyed by an
  incrementing `replyCount` so each reply animates independently), and on
  `discussion_complete` commits the finished bubble to `feed`/`discussion`
  and the returned `notes` to state — notes are canon; they only change
  through this event. A `route` frame (pick/steer/options) is acted on AFTER
  the stream loop and guard release: `pick`/`steer` call `handleChoose`
  (the indexed card, or the utterance verbatim); `options` swaps the current
  `cards` feed item for the fresh scenarios without running a turn. `runTurn`
  and `runConverse` share one `streamingRef`/`isStreaming` busy guard (a card
  tap can't race a live conversation or vice versa) and one
  `AbortController` ref; a "■ Stop" control (rendered only while
  `isStreaming`) aborts whichever stream is live — silently, via
  `streamPost`'s shared abort semantics, never surfacing as an error, and any
  partial scene or reply already shown is kept. A converse failure arms
  `pendingConverse` (the failed utterance) instead of `pendingTurn`;
  `handleRetry` re-runs `runConverse` (never a stale turn) when it's set,
  replaying the SAME discussion tail rather than double-appending the user's
  line. The unmount effect (abort on navigate-away) and the `stream_error` →
  `errorMessage()` banner (429/503/status-0/generic) are unchanged from
  slice B/C. The "← Home" `Pressable` (`router.back()`) still sits in a
  header row above the ScrollView, and the `PushToTalk` bar still lives
  BELOW the ScrollView in a `pttArea` `View` so it stays visible while
  scrolling. Narration (slice D) speaks AUTOMATICALLY and non-negotiably —
  no per-turn opt-in: `runTurn`'s `turn_complete` calls
  `voiceOut.speak(sceneText, {kind: "scene"})`, and `runConverse`'s
  `discussion_complete` calls `voiceOut.speak(replyText, {kind: "reply"})`. A
  `voiceOut.onSpeakingChange(setIsSpeaking)` effect keeps `isSpeaking` a
  SEPARATE state from `isStreaming` on purpose (the co-creation review's
  riding note — don't overload Stop-button semantics with playback state —
  resolved here): narration can keep talking after a stream has already
  finished, and the reverse. The "■ Stop" control now renders while
  `isStreaming || isSpeaking` (either used to be sufficient alone) and its
  press both aborts the in-flight stream AND calls `voiceOut.stop()` — one
  button silences generation and narration together. `PushToTalk` gained an
  `onActivate` prop wired to `voiceOut.stop()`: pressing the mic to speak
  interrupts any narration playing, so the user is never talking over the
  AI. `isStreaming` (NOT `isSpeaking`) still gates the mic's `disabled`
  prop — you can start talking while a reply/scene narrates, since
  interrupting it mid-word is the point.
- **`lib/sse.ts`** — `SSEParser`: an incremental frame parser that buffers
  across network chunk boundaries (splits on `"\n\n"`, and copes if the
  separator itself is split across chunks) and turns `scene_token` /
  `turn_complete` / `error` (story channel) and `reply_token` /
  `discussion_complete` / `route` (converse channel) server events into one
  `StreamEvent` union. Malformed JSON in a known event becomes `stream_error`
  500; an unknown event NAME is silently ignored ONLY when its frame's JSON
  parses cleanly (forward-compat with future backend events) — malformed
  JSON in ANY frame, known event or unknown, still yields a `stream_error`.
  A `route` frame with a recognized event name but an intent the client
  can't act on (anything other than `pick`/`steer`/`options`) is a BROKEN
  CONTRACT, not forward-compat, so it also yields `stream_error` rather than
  being silently ignored.
- **`lib/api.ts`** — `getTemplates()`, `streamTurn()`, and `converse()` (new),
  the app's three calls into the backend. `streamTurn` and `converse` both
  run through one shared generator, `streamPost(url, body, opts?: { signal?:
  AbortSignal })`, so they get identical semantics: a deliberate abort — an
  `AbortError` thrown by the initial `fetch` OR one raised mid-read while
  consuming the response body — ends the generator SILENTLY, never as a
  `stream_error`; `reader.cancel()` runs best-effort in a `finally` regardless
  of how the generator exits, so the HTTP body is always released. Otherwise
  ONE error channel: a pre-stream plain-HTTP failure (404/403/422), a network
  failure that never reaches the server (`status: 0`, "Can't reach the
  storyteller. Is the backend running?"), and a connection that drops
  mid-stream after tokens already arrived (`status: 0`, "Connection lost
  mid-story. Tap to retry.") all surface through the SAME `stream_error` event
  that real backend `error` frames use — the UI renders exactly one failure
  path, never a raw thrown exception. `converse()` posts to
  `POST /converse/stream` with the `ConverseRequest` shape (`template_id,
  utterance, summary, notes, options, discussion, turn, length`); both
  functions append `?mock=true` under `EXPO_PUBLIC_USE_MOCK`.
- **`lib/fetch.ts`** — `streamingFetch`, a one-line seam wrapping `expo/fetch`
  (streams response bodies on native; web's native `fetch` already streams).
  Tests mock this single function instead of touching the network.
- **`lib/voice.ts`** — `getVoiceIn(): VoiceIn`, architecture rule #3 made
  real (never call a speech service directly), now on its SECOND engine:
  **record-then-transcribe**. Interface unchanged from slice C — `available`
  / `start(cb)` / `stop()` / `abort()`, `stop()` finishes the recording and
  delivers `onFinal`, `abort()` discards with NO callback at all — but the
  engine underneath changed: hold-to-talk records a clip via `MediaRecorder`
  (`audio/webm;codecs=opus` when supported), release uploads it as multipart
  to `POST /transcribe`, and the server's Gemini call returns the words.
  Chrome's built-in `SpeechRecognition` engine from slice C is RETIRED — live
  play showed it garbling natural speech, and recognition quality is exactly
  what this interface exists to let the project swap out. Web v2 NEVER calls
  `onInterim` (no live words from server STT) — `PushToTalk` renders
  "listening…"/"transcribing…" from PRESS STATE instead of recognizer
  callbacks; the callback stays in the interface for a future streaming-STT
  or native impl. A second `start()` while one is live still supersedes the
  prior session (the double-start mic-leak guard carried over from slice
  C) — its tracks are released and it's marked discarded so a late
  `onstop`/upload response can't deliver a stale transcript. Media tracks are
  ALWAYS released (`releaseTracks`, on finish, supersede, and abort alike) —
  no hot mic left running. An in-flight `/transcribe` upload whose session
  was aborted or superseded mid-upload is discarded on delivery, checked on
  both the fetch's resolution and its rejection — the review-caught race a
  fix added mid-slice, so a stale transcript can never land on a screen that
  moved on. Permission denial maps to the same friendly
  "Microphone permission denied..." message as before; a network failure
  during upload gets its own "Couldn't reach the storyteller to transcribe"
  message. A browser with no `getUserMedia`/`MediaRecorder` gets the same
  `available: false` stub as before. The native implementation (record via
  Expo's audio module, upload the same way — works in plain Expo Go, no dev
  build needed anymore since recognition itself moved server-side) slots in
  behind this SAME interface as a follow-up.
- **`lib/voiceOut.ts`** — `getVoiceOut(): VoiceOut`, the narrator abstraction
  (architecture rule #3's twin) and rule #2 (abortable audio) made real.
  Interface: `available` / `speak(text, opts?: {kind})` / `stop()` /
  `onSpeakingChange(cb)`. Primary path: POST the text to `/narrate`, play the
  returned WAV through an `Audio` element. ANY failure downgrades to the
  device's built-in voice (`speechSynthesis` + `SpeechSynthesisUtterance`)
  for that utterance — a quota/network failure or a mid-playback `onerror`
  all fall through, so the story is never silent because Gemini TTS ran out.
  `EXPO_PUBLIC_USE_MOCK=1` always uses the device voice (the full loop demos
  at zero cost, matching the backend's own mock stance). A monotonic
  `generation` counter bumps on every `speak()`/`stop()` — the stale-async
  guard: a `/narrate` response, blob-URL creation, or `Audio`/
  `SpeechSynthesisUtterance` callback that resolves after a NEWER
  `speak()`/`stop()` fired is a no-op, so two overlapping narrations (or one
  that outlives a Stop press) can never both talk. `stop()` (`halt`) always
  pauses/cancels whichever engine is live, revokes the blob URL, and flips
  `isSpeaking` false — called on every Stop press and on unmount.
  `onSpeakingChange` is a single-slot subscriber register (Story is the only
  current subscriber — last-writer-wins if a second ever appears). No
  `Audio`/`speechSynthesis` global at all → `available: false`, every method
  a no-op, matching `VoiceIn`'s unavailable stub.
- **`lib/matchCard.ts`** — `matchCard(utterance, cards): number | null`, a
  pure function: no network, no LLM (deliberately cheap — the free fast-path
  before falling back to `/converse`). ONE rule now, GUARDED ordinals only —
  "second", "option 2", "the last one", or a pick-verb ("pick"/"take"/
  "choose"/"option"/"select"/"go with"/"number"/"card") — checked
  most-specific-first so "the second one" hits "second" and not "one";
  ordinals only fire when the utterance LOOKS like a pick (`<= 4` words OR a
  pick-word present), because bare words like "first"/"two" show up
  constantly in narrative steering sentences ("at first she hesitated...");
  an ordinal past the end of `cards` returns `null` (out-of-bounds). The
  WORD-OVERLAP tier (content words shared between the utterance and a card's
  text) is RETIRED — it couldn't distinguish "do the iron door one" (a pick)
  from "tell me more about the iron door one" (a question about that card's
  content), and auto-picking a question was exactly the rigidity the
  conversational redesign set out to remove. `null` → the caller (Story's
  `handleUtterance`) routes the utterance to `/converse`, where a model
  decides pick / steer / discuss / options with actual context instead of
  guessing from word overlap.
- **`components/StreamingText.tsx`** — the signature word-materialize
  animation (Reanimated `FadeInDown` per word). Contract: append-only — pass
  the FULL accumulated text each render; already-rendered words keep stable
  keys so they never re-animate or disappear, only new words fade/rise in.
  Network-ignorant: same input whether fed by live SSE, mock mode, or a test
  fixture.
- **`components/PushToTalk.tsx`** — hold-to-talk `Pressable` behind
  `VoiceIn`: `onPressIn` → `voice.start()` (v2: begins recording),
  `onPressOut` → `voice.stop()` (v2: uploads for transcription). Renders
  NOTHING when `voice.available` is false — no dead mic button on
  unsupported browsers. Status text now comes from PRESS STATE, not
  recognizer callbacks (VoiceIn v2 never calls `onInterim`): a `phase` state
  machine (`idle` / `listening` / `transcribing`) renders "listening…" while
  the mic is held and "…" while the clip uploads, with an 8-second
  stuck-phase timeout back to `idle` guarding against an empty clip (no
  `onFinal`/`onError` fires for one, so nothing else would ever clear it).
  Inline mic-permission / transcription-failure errors render above the
  button. A new `onActivate` prop fires first thing in `handlePressIn`,
  before `voice.start()` — Story wires it to `voiceOut.stop()` so pressing
  the mic interrupts any narration playing. A `compact` prop switches from
  Story's full "🎤 Hold to talk" bar to an icon-only round button for Home; an
  overridable `testID` (default `"ptt-button"`) lets Home reuse the component
  under its own `"premise-mic"` testID. Unmount still aborts any live
  recording (slice C's hot-mic guard, unchanged).
- **Env config**: `EXPO_PUBLIC_API_URL` (backend base URL — LAN IP, not
  `localhost`, when running on a phone via Expo Go) and `EXPO_PUBLIC_USE_MOCK`
  (`1` routes `streamTurn`/`converse()` to their `?mock=true` endpoints, the
  backend's zero-cost canned streams; needs the backend's own `DEV_MOCK_ENABLED=1`).
  Template: `client/.env.example` (copy to `client/.env`, git-ignored).
- **Version pins**: SDK 57 shipped ahead of some peers, so
  `@testing-library/react-native` is pinned to exact `13.3.3` and
  `react-test-renderer` to exact `19.2.3` (not ranges) to keep that
  RNTL/React version triangle consistent; `client/.npmrc` sets
  `legacy-peer-deps=true` because `jest-expo@57`'s peer range still lags
  React Native 0.86 upstream. Remove both pins once upstream catches up.
- Tests (jest-expo preset, `restoreMocks: true`, **96 tests** across 9
  suites, up from 80 — the delta is a new `lib/__tests__/voiceOut.test.ts`
  suite plus a rewritten `voice.test.ts` for the v2 record-then-transcribe
  engine and new narration cases in `story.test.tsx`): `lib/__tests__/sse.test.ts` (frame parsing incl.
  chunk-split and separator-split cases, malformed JSON, unknown events, and
  — new — `reply_token`/`discussion_complete` parsing plus all three `route`
  intents, with an unrecognized route intent yielding `stream_error` rather
  than being silently ignored); `lib/__tests__/api.test.ts` (`streamTurn`'s
  single error channel incl. the status-0 connection-loss and pre-stream-404
  cases, the `AbortSignal` passthrough: a deliberate abort on the initial
  fetch and a mid-stream-read abort both end the generator silently with no
  `stream_error`, `reader.cancel()` on early exit — and, new, `converse()`
  posting to `/converse/stream` and yielding parsed frames while sharing
  `streamTurn`'s single error channel and silent-abort semantics);
  `lib/__tests__/smoke.test.ts`; `lib/__tests__/voice.test.ts` (REWRITTEN for
  VoiceIn v2's record-then-transcribe engine: `getVoiceIn` unavailable
  without `mediaDevices`/`MediaRecorder`, `stop()` uploading the clip and
  delivering the transcript with tracks released, `abort()` discarding with
  no upload and no callbacks, permission denial mapped to the friendly
  message, a failed transcription surfacing via `onError` not `onFinal`, an
  empty transcript delivering nothing, a second `start()` discarding the
  superseded session's upload, and — the Task 3 review-caught race — an
  `abort()`/second-`start()` during an IN-FLIGHT upload suppressing that
  stale delivery, plus permission denial after an abort delivering nothing);
  `lib/__tests__/voiceOut.test.ts` (NEW: `getVoiceOut`'s `speak()` narrating
  via `/narrate` and playing the returned WAV with `isSpeaking` flipping
  on/off, `stop()` halting playback mid-word, a `/narrate` failure falling
  back to the device voice, `stop()` while the fetch is still in flight
  meaning the audio never plays, a second `speak()` superseding the first,
  and unavailability with no audio capability at all);
  `lib/__tests__/matchCard.test.ts` (SLIMMED to ordinals-only: guarded
  ordinals incl. "the last one" and out-of-bounds, bare ordinal words inside
  long sentences NOT matching, pick-verbs unlocking ordinals in longer
  utterances, "last" with an empty cards list returning `null` — not `-1` —
  and, replacing the retired word-overlap tests, a block proving content
  references like "tell me more about the iron door one" and "the door" all
  return `null` — i.e. route to `/converse` instead of being guessed as a
  pick); `components/__tests__/StreamingText.test.tsx` (append-only
  rendering, paragraph breaks); `app/__tests__/index.test.tsx`
  (card-per-template, seed tap, load-failure retry, passing the chosen
  length to the story route, and the mic filling the premise input with the
  spoken transcript); `app/__tests__/story.test.tsx` (the story-turn block:
  full turn loop, option cards tracking arrival count, mid-stream error
  keeps partial text, the status-0 connection-lost detail rendering
  verbatim, 429 daily-quota message, retry re-runs the same turn,
  overlapping-tap guard, every request carrying `turn`/`length` and retry
  never advancing the turn number, aborting the in-flight stream on unmount;
  plus a REWRITTEN push-to-talk block for the conversational feature: a
  spoken ordinal picks a card immediately with no `/converse` call at all;
  non-ordinal speech calls `/converse` carrying notes/options/the discussion
  tail, and that notes+tail correctly carry into the NEXT converse call;
  `route` frames for pick/steer/options each drive the right client action
  (firing a turn verbatim, firing a turn with the indexed card, or swapping
  the option cards without running a turn); the "■ Stop" control aborts a
  streaming reply silently and keeps the partial bubble with no error
  painted; retry after a converse failure re-runs the CONVERSATION, not a
  turn, and does not duplicate the optimistic user bubble or discussion
  entry; consumed cards disappear once the next turn starts; PTT stays
  disabled while a turn is streaming; a mic-permission error renders inline;
  the "← Home" back control exists; and — NEW for narration — a scene speaks
  when its turn completes, a reply speaks when its discussion completes, the
  "■ Stop" control silences narration too (on top of aborting a stream),
  holding the mic interrupts any narration playing, and speaking never
  disables the mic because `isSpeaking` is not `isStreaming`); a
  `resolveStoryLength` unit-test block
  (4 tests) pinning the total fallback to `"short"` for an invalid string, an
  array (duplicated query param), and a missing value. Gemini is never
  reached from these tests — the backend has its own separate suite.
  Run: `cd client && npx jest --watchAll=false`.
- Verified 2026-07-04: `npx jest --watchAll=false` → 80/80 passing across 8
  suites; `npx tsc --noEmit` clean; `npx expo export --platform web` produces
  a static bundle (`client/dist/`, git-ignored) with no errors.
- Conversational-co-creation final-review hardening (same day, commit
  `e097e13`): ■ Stop pressed while a converse stream is still open suppresses
  any already-captured `route` (a braked route can never fire a turn — the
  guard also covers routes arriving on an unmounted screen); `parse_notes`
  rejects blank/whitespace notes with a 502 (one bad scribe output can no
  longer silently erase all canon — trade-off: a zero-canon exchange whose
  scribe returns literally empty text surfaces as a retryable error, the
  right asymmetry); the SSE `route` parser treats a pick without a valid
  index or an options frame without scenarios as malformed-frame
  `stream_error`s (defensive — the server validates upstream); the converse
  temperatures (0.8/0.7) are pinned by tests like every other call's cost
  caps.
- Final-review hardening (same day, commit `57da2f7`): `matchCard`'s "last"
  path bounds-guarded against an empty cards list; `PushToTalk` aborts any
  live recognition on unmount (no hot mic / ghost turn after navigating
  away); `streamTurn`'s `reader.cancel()` rejection is swallowed on the
  promise itself (it rejects on an errored/aborted stream — a sync
  try/catch can't catch it); `runTurn` cancelled any pending confirm timer
  right after its overlap guard so a card tap or retry during the confirm
  window couldn't double-fire — moot now that the confirm bar/timer itself
  is gone (see the Story screen description above; conversational
  co-creation replaced it with instant ordinal picks + a "■ Stop" control).
- Audio slice (slice D — `/transcribe` ears, `/narrate` mouth, `VoiceIn` v2,
  `VoiceOut`, the Story narration wiring above) SHIPPED, commits `9be7069`
  (`/narrate`) through `95fb9a5` (auto-narration wiring). Task 3's own
  final-review fix (commit `402a99e`) closed a plan-authored race: an
  in-flight `/transcribe` upload could deliver stale `onFinal`/`onError`
  callbacks after its session was aborted or superseded — fixed with
  discarded re-checks in the upload and permission continuations, 3
  regression tests. Verified 2026-07-04 (this checkpoint): `npx jest
  --watchAll=false` → 96/96 across 9 suites; `npx tsc --noEmit` clean; `npx
  expo export --platform web` clean. Riding minors: the last blob URL of a
  playback session is never revoked on natural `onended` (a bounded leak);
  `onSpeakingChange` is single-slot (fine while Story is the only
  subscriber); a theoretical silent-playback edge if `Audio` exists but
  `speechSynthesis` doesn't under `USE_MOCK`. BROWSER-COMPLETE, mock-verified
  and live-Gemini-verified for `/narrate` (see the backend section's
  live-verify paragraph); the owner's Chrome mic-and-ear gut-check (speaking
  a real utterance, hearing the Gemini voice, interrupting it) has NOT
  happened yet — that hand-off is what closes this slice for real.

## Environment / how to run

- Windows, PowerShell, VS Code. Project at `C:\dev\Storyteller`.
- Activate venv: `venv\Scripts\activate` (NOT the Unix `source` path).
- Run server: `uvicorn main:app --reload`. Test UI: `http://127.0.0.1:8000/docs`.
- Run backend tests: `venv\Scripts\python.exe -m pytest tests/ -v`.
- Run client (web preview): `cd client && npx expo start --web`. Mock story
  turns need the backend running with `DEV_MOCK_ENABLED=1` in ITS `.env`
  (client's own `.env`, from `client/.env.example`, sets
  `EXPO_PUBLIC_USE_MOCK=1` to opt in).
- Run client tests: `cd client && npx jest --watchAll=false`. Type-check:
  `cd client && npx tsc --noEmit`.

## NEXT STEPS — follow the roadmap

The approved phase plan lives in
`docs/superpowers/specs/2026-07-02-voice-first-roadmap.md`. Summary:

1. **Phase 1 (DONE): story engine** — `/continue` running-summary endpoint
   (client carries summary; stateless), genre template system v1 (4 genres as
   data files, `GET /templates`), token/cost logging, public GitHub remote. All
   live-verified against real Gemini; see "What's BUILT and WORKING" above.
2. **Phase 2 (IN PROGRESS): vertical slice** — Expo app skeleton, streaming (SSE)
   story view with animated text, push-to-talk voice input, conversational
   co-creation (discuss/steer/pick/options routed through one fused call),
   narration v1 (Gemini TTS + device-TTS fallback), abortable playback.
   Slice A (backend SSE streaming + mock mode) DONE. Slice B (Expo app: screens,
   `lib/` bridge, StreamingText animation) DONE. Slice C (push-to-talk +
   conversational co-creation: `VoiceIn` abstraction, the ordinals-only
   `matchCard` fast-path, `/converse/stream`, the feed/bubble UI, notes
   canon) SHIPPED and mock-verified in the browser; the confirm-bar flow from
   the original push-to-talk design was removed along the way in favor of
   instant ordinal picks + a stop control. Slice D (narration v1: `/transcribe`,
   `/narrate`, `VoiceIn` v2 record-then-transcribe, `VoiceOut`, auto-narration
   wiring — see "Client app (`client/`)" and the backend section above)
   SHIPPED and BROWSER-COMPLETE: all suites green (backend 115, client 96),
   `/narrate` live-verified against real Gemini TTS, `/transcribe`'s contract
   (never a 500) live-verified though its actual transcription quality
   wasn't (free-tier daily quota). Chrome's `SpeechRecognition` engine from
   slice C was RETIRED mid-slice in favor of server-side Gemini STT — better
   recognition quality was the whole point, so voice input now runs through
   the same backend as everything else, no dev build required. STILL
   PENDING, riding to a future session: (1) the owner's live Chrome
   mic-and-ear gut-check — speak a premise, hear the Gemini voice, interrupt
   it mid-word, judge transcription accuracy and voice quality — this is the
   slice's actual acceptance test and hasn't run yet; (2) the phone follow-up
   (an Expo Go recording implementation behind the same `VoiceIn`/`VoiceOut`
   interfaces — no dev build needed now that recognition itself is
   server-side); (3) the paid-tier flip, still recommended — audio doubles
   the Gemini calls per turn on a free tier that already 503s under load.
   Phase 4 (below) is next on the audio track once the gut-check lands:
   streamed narration (word-synced playback instead of whole-clip WAV) and
   per-genre voices.
3. **Phase 3: product core** — story persistence (SQLite, story IDs), voice-driven
   editing with morph animation, prompt caching, latency/failure UX.
4. **Phase 4: expressive narration** — streamed audio, per-genre voices, loose sync.
5. **Phase 5: hands-free mode** — barge-in via realtime voice API (evaluated fresh),
   the turn-mode toggle.
6. **Phase 6: money** — accounts, per-user quotas (tokens + audio seconds),
   free tier + subscription (RevenueCat), TestFlight → App Store, content safety.

Each phase gets its own brainstorm → spec → plan cycle when it starts.

## Concepts already covered (don't re-explain unless asked)

venv, `.env`/env vars, Windows vs Unix activate paths, HTTP status codes (2xx/4xx/5xx),
422 validation vs 500 crash, transient vs permanent errors, exponential backoff,
FastAPI `/docs` (Swagger UI), reading tracebacks, git init / commits / .gitignore,
TDD (write failing test → watch it fail → implement → watch it pass → commit), why
tests mock the external API, DRY (one shared `call_gemini`).
