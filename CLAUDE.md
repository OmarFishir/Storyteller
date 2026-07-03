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
- `POST /continue` — `{"template_id": "...", "summary": "...", "chosen_scenario": "...",
  "turn": 1, "length": "short"}` → `{"scene": "...", "summary": "...", "scenarios": [...]}`.
  The running-summary turn — the first cost-control piece actually wired up: the
  client carries the summary, so the backend stays stateless and never resends
  full story history. `turn` (1-based scene number, default `1`, `ge=1` → 422
  below that) and `length` (`"short" | "medium" | "long"`, default `"short"`)
  are carried by the client on every turn too (same carry-it-yourself pattern
  as `summary`) and drive beat selection + the token budgets below; the
  defaults reproduce pre-structure behavior for any old caller. Two Gemini
  calls per turn: (1) the "storyteller" (`build_scene_prompt`,
  `max_output_tokens=SCENE_BUDGETS[length]`, `temperature=0.9`) writes the next
  scene as pure prose — no JSON, so creative writing never fights JSON
  formatting — assembled in caching-friendly order: static `STORY_PROMPT` →
  genre style → current beat's `{name} — {guidance}` (via
  `story_beats.select_beats`, only when the template has a `structure`) →
  story-so-far → chosen direction. `STORY_PROMPT` itself now also carries an
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
  `suggest`, `expand`, `scene`, `fold`. A logging failure is swallowed (it must
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

Tests in `tests/test_api.py`, `tests/test_templates.py`, and `tests/test_beats.py`
(pytest + FastAPI `TestClient`, **69 tests** — incl. the corrected next-TURN
fold-steering pinning test above and a stream-path scene-budget pin): health
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
`validate_turn_payload()` helper. Tests MOCK the Gemini layer — enforced
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

Supporting files: `requirements.txt` (fastapi, uvicorn, python-dotenv, google-genai,
pytest), `.env.example` (template), real `.env` (holds `GEMINI_API_KEY`, git-ignored),
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
  `story.tsx` (Story) — runs the turn loop against `POST /continue/stream`: an
  effect kicks off the opening turn on mount, `token` events accumulate into
  `StreamingText`, `turn_complete` archives the finished scene and renders
  however many option cards the server actually sent (not hardcoded to 3), a
  `streamingRef` flag ignores a second tap while a turn is already streaming;
  a reactive `isStreaming` state mirrors that same ref (set together when a turn
  starts, reset together in `runTurn`'s `finally`) so streaming state can drive
  UI, not just gate logic. Every request (mount-effect and each chosen option) carries
  `turn: scenes.length + 1` and the `length` read from the route param via
  `resolveStoryLength()` — the route param is an unchecked value (URL-editable
  on web, and can arrive as an array if the query string duplicates the key),
  so anything other than exactly `"short"` / `"medium"` / `"long"` falls back
  to `"short"` rather than being cast straight through to the backend — the
  same carry-it-yourself pattern as the backend's `summary`; retry re-sends
  the frozen, already-built request object unchanged, so retrying never
  advances the turn counter or changes the beat the story is on. A
  `stream_error` event drives a retry banner via `errorMessage()`: 429 → the
  daily-quota message, 503 → "the muse is busy", status 0 → renders the
  client-authored `detail` string verbatim (the connection-lost /
  can't-reach-backend copy from `lib/api.ts`), anything else → a generic
  "Something went wrong — tap to retry." fallback.
  **Slice C additions:** the root is now a flex `View` with the scene/options
  `ScrollView` above and the `PushToTalk` bar pinned in a `pttArea` `View`
  BELOW it, outside the ScrollView, so the mic stays visible while scrolling
  story text; a "← Home" `Pressable` (`router.back()`) sits in a header row
  above the ScrollView. Story keeps an `AbortController` ref, created fresh
  each `runTurn` and threaded into `streamTurn`'s `signal`; an unmount effect
  calls `abortRef.current?.abort()` (stop billing a screen nobody is
  watching) and clears any pending confirm timeout. A spoken utterance flows
  through `handleUtterance`: `matchCard(utterance, options)` decides card vs.
  free-form, then a confirm bar renders `Heard: "..." → choosing option N`
  (with that card visually highlighted) or `→ steering the story`; a 1.5s
  timeout auto-fires `handleChoose` with either `options[matchedIndex]` or the
  raw utterance — the SAME `handleChoose`/`runTurn` path option-card taps use,
  so the turn clock, frozen-retry object, and overlap guard are inherited for
  free — or a Cancel button clears the pending timeout instead. The
  `PushToTalk` bar is `disabled` while streaming or while a confirm is
  pending.
- **`lib/sse.ts`** — `SSEParser`: an incremental frame parser that buffers
  across network chunk boundaries (splits on `"\n\n"`, and copes if the
  separator itself is split across chunks) and turns `scene_token` /
  `turn_complete` / `error` server events into one `StreamEvent` union.
  Malformed JSON in a known event becomes `stream_error` 500; an unknown
  event name is silently ignored ONLY when its frame's JSON parses cleanly
  (forward-compat with future backend events) — malformed JSON in ANY frame,
  known event or unknown, still yields a `stream_error`.
- **`lib/api.ts`** — `getTemplates()` and `streamTurn()`, the app's only two
  calls into the backend. `streamTurn(body, opts?: { signal?: AbortSignal })`
  (slice C) takes an optional `AbortSignal`: a deliberate abort — an
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
  path, never a raw thrown exception.
- **`lib/fetch.ts`** — `streamingFetch`, a one-line seam wrapping `expo/fetch`
  (streams response bodies on native; web's native `fetch` already streams).
  Tests mock this single function instead of touching the network.
- **`lib/voice.ts`** — `getVoiceIn(): VoiceIn`, architecture rule #3 made real
  (never call a speech service directly). Interface: `available` /
  `start(cb)` / `stop()` / `abort()` — `stop()` finishes the recognizer and
  delivers `onFinal`; `abort()` discards the in-flight session with NO
  `onFinal` at all. Wraps the browser's built-in `SpeechRecognition`
  (`window.SpeechRecognition` / `webkitSpeechRecognition` — works in Chrome,
  zero new dependencies); `continuous = true` + `interimResults = true`
  because hold-to-talk decides when the utterance ends, not the browser's own
  silence-detection. A second `start()` while one is active `abort()`s the
  superseded session first (`onend` nulled so it can't deliver a stale final)
  — the double-start mic-leak guard. A browser with no `SpeechRecognition`
  global gets a stub object (`available: false`, every method a no-op) rather
  than throwing. Permission denial (`not-allowed` / `service-not-allowed`)
  maps to a friendly "Microphone permission denied..." message via
  `onError`; other recognizer errors pass through verbatim. Privacy note
  recorded directly in the file: Chrome's recognizer sends audio to Google's
  servers — dev-acceptable, revisit the wording before launch. The native
  implementation (`expo-speech-recognition`, needs a dev build) arrives later
  behind this SAME interface — that task is still pending.
- **`lib/matchCard.ts`** — `matchCard(utterance, cards): number | null`, a
  pure function: no network, no LLM (deliberately cheap; upgradeable in
  isolation later). Two rules, in order: (1) GUARDED ordinals — "second",
  "option 2", "the last one", or a pick-verb ("pick"/"take"/"choose"/"option"/
  "select"/"go with"/"number"/"card") — checked most-specific-first so "the
  second one" hits "second" and not "one"; ordinals only fire when the
  utterance LOOKS like a pick (`<= 4` words OR a pick-word present), because
  bare words like "first"/"two" show up constantly in narrative steering
  sentences ("at first she hesitated..."); an ordinal past the end of `cards`
  returns `null` (out-of-bounds). (2) Word overlap — content words (length >
  3, stopwords stripped) shared between the utterance and each card; a card
  wins only with >= 2 overlapping words AND a strictly higher score than the
  runner-up (a tie, or no card clearing 2, → `null`). `null` from either rule
  → the caller (Story's `handleUtterance`) treats the utterance as free-form
  steering rather than a card pick.
- **`components/StreamingText.tsx`** — the signature word-materialize
  animation (Reanimated `FadeInDown` per word). Contract: append-only — pass
  the FULL accumulated text each render; already-rendered words keep stable
  keys so they never re-animate or disappear, only new words fade/rise in.
  Network-ignorant: same input whether fed by live SSE, mock mode, or a test
  fixture.
- **`components/PushToTalk.tsx`** — hold-to-talk `Pressable` behind
  `VoiceIn`: `onPressIn` → `voice.start()`, `onPressOut` → `voice.stop()`.
  Renders NOTHING when `voice.available` is false — no dead mic button on
  unsupported browsers. The live interim transcript renders as plain `Text`,
  deliberately NOT `StreamingText` — its append-only contract would break on
  interim speech that rewrites itself mid-utterance. Inline mic-permission /
  recognition errors render above the button. A `compact` prop switches from
  Story's full "🎤 Hold to talk" bar to an icon-only round button for Home; an
  overridable `testID` (default `"ptt-button"`) lets Home reuse the component
  under its own `"premise-mic"` testID.
- **Env config**: `EXPO_PUBLIC_API_URL` (backend base URL — LAN IP, not
  `localhost`, when running on a phone via Expo Go) and `EXPO_PUBLIC_USE_MOCK`
  (`1` routes `streamTurn` to `/continue/stream?mock=true`, the backend's
  zero-cost canned stream; needs the backend's own `DEV_MOCK_ENABLED=1`).
  Template: `client/.env.example` (copy to `client/.env`, git-ignored).
- **Version pins**: SDK 57 shipped ahead of some peers, so
  `@testing-library/react-native` is pinned to exact `13.3.3` and
  `react-test-renderer` to exact `19.2.3` (not ranges) to keep that
  RNTL/React version triangle consistent; `client/.npmrc` sets
  `legacy-peer-deps=true` because `jest-expo@57`'s peer range still lags
  React Native 0.86 upstream. Remove both pins once upstream catches up.
- Tests (jest-expo preset, `restoreMocks: true`, **60 tests** across 8 suites):
  `lib/__tests__/sse.test.ts` (frame parsing incl. chunk-split and
  separator-split cases, malformed JSON, unknown events);
  `lib/__tests__/api.test.ts` (`streamTurn`'s single error channel incl. the
  status-0 connection-loss and pre-stream-404 cases, plus — new (slice C) —
  the `AbortSignal` passthrough: a deliberate abort on the initial fetch and a
  mid-stream-read abort both end the generator silently with no
  `stream_error`, and the signal is threaded through to `fetch` with
  `reader.cancel()` on early exit); `lib/__tests__/smoke.test.ts`;
  `lib/__tests__/voice.test.ts` (new — `getVoiceIn`: unavailable with no
  `SpeechRecognition` global, interim transcripts streaming then a final
  delivered on `stop()`, `abort()` discarding everything with no final,
  permission-denial mapped to a friendly message, a second `start()`
  aborting the superseded session with no orphaned mic); `lib/__tests__/matchCard.test.ts`
  (new — guarded ordinals incl. "the last one" and out-of-bounds, bare
  ordinal words inside long sentences NOT matching, pick-verbs unlocking
  ordinals in longer utterances, word-overlap picking a clear winner,
  ambiguous/gibberish/empty utterances all returning `null`);
  `components/__tests__/StreamingText.test.tsx` (append-only rendering,
  paragraph breaks); `app/__tests__/index.test.tsx` (card-per-template, seed
  tap, load-failure retry, passing the chosen length to the story route, and
  — new (slice C) — the mic filling the premise input with the spoken
  transcript); `app/__tests__/story.test.tsx` (full turn loop, option cards
  tracking arrival count, mid-stream error keeps partial text, the status-0
  connection-lost detail rendering verbatim, 429 daily-quota message, retry
  re-runs the same turn, overlapping-tap guard, every request carrying
  `turn`/`length` and retry never advancing the turn number, and — new
  (slice C) — a push-to-talk block: aborting the in-flight stream on unmount,
  a spoken ordinal picking a card and auto-firing after the confirm window,
  unmatched speech steering the story free-form, Cancel inside the confirm
  window discarding the utterance, PTT disabled while a turn is streaming, a
  mic-permission error rendering inline, and the "← Home" back control
  existing); a `resolveStoryLength` unit-test block (4 tests) pinning the
  total fallback to `"short"` for an invalid string, an array (duplicated
  query param), and a missing value. Gemini is never reached from these
  tests — the backend has its own separate suite.
  Run: `cd client && npx jest --watchAll=false`.
- Verified 2026-07-04: `npx jest --watchAll=false` → 60/60 passing across 8
  suites; `npx tsc --noEmit` clean; `npx expo export --platform web` produces
  a static bundle (`client/dist/`, git-ignored) with no errors.

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
   story view with animated text, push-to-talk on-device speech recognition,
   narration v1 (quality TTS ~$5 + device-TTS fallback), abortable playback.
   Slice A (backend SSE streaming + mock mode) DONE. Slice B (Expo app: screens,
   `lib/` bridge, StreamingText animation) DONE — see "Client app (`client/`)"
   above. Slice C (push-to-talk: `VoiceIn` abstraction, `matchCard`, the PTT
   bar + confirm-bar flow, abort plumbing) is BROWSER-COMPLETE — see "Client
   app (`client/`)" above; the native build (`expo-speech-recognition` behind
   the same `VoiceIn` interface) is still pending, blocked on the user's phone
   OS decision. Slice D (narration v1) next.
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
