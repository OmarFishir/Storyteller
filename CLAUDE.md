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
  duplicate id crashes on boot, not mid-request).
- `POST /suggest` — `{"premise": "...", "template_id": "..." (optional)}` →
  `{"scenarios": ["...","...","..."]}`. Uses a static `SYSTEM_PROMPT` forcing raw
  JSON, plus `parse_scenarios()` which defensively strips code fences and
  validates a list of strings (raises a clean 502 on bad output). When
  `template_id` is given, `get_template_or_404()` injects that genre's `style`
  into the prompt (404 on an unknown id); omitted, `/suggest` behaves as before.
- `POST /expand` — `{"scenario": "...", "instruction": "..."}` →
  `{"original": "...", "expanded": "..."}`. Refines a chosen scenario per a
  plain-English instruction ("make it darker"). Static `EXPAND_PROMPT`,
  `max_output_tokens=600`, `temperature=0.8`. Returns prose directly (NO JSON
  parsing — simpler than /suggest). Echoes `original` from the request rather than
  paying the model to reproduce it.
- `POST /continue` — `{"template_id": "...", "summary": "...", "chosen_scenario": "..."}`
  → `{"scene": "...", "summary": "...", "scenarios": [...]}`. The running-summary
  turn — the first cost-control piece actually wired up: the client carries the
  summary, so the backend stays stateless and never resends full story history.
  Two Gemini calls per turn: (1) the "storyteller" (`STORY_PROMPT`,
  `max_output_tokens=600`, `temperature=0.9`) writes the next scene as pure prose
  — no JSON, so creative writing never fights JSON formatting; (2) the "scribe"
  (`FOLD_PROMPT`, `max_output_tokens=400`, `temperature=0.7`) folds the new scene
  into an updated summary (contract: stay under ~150 words, preserve named
  characters/facts/unresolved threads) and proposes the next 3 options. Reuses
  `parse_model_json()` and `get_template_or_404()` from `/suggest`.
- `POST /continue/stream` — SSE twin of `/continue`, same request body, plus an
  optional `?mock=true`. Streams `scene_token` frames (`{"t": "..."}`) as the
  scene is generated, then one `scene_token*` → `turn_complete`
  (`{"summary": "...", "scenarios": [...]}`) or, on any failure, a terminal
  `error` frame (`{"status": ..., "detail": "..."}`) instead — the client keeps
  every token already shown, since you can't un-send half a scene. Retry/backoff
  and the clean 429 only apply BEFORE the first byte of the scene; once
  streaming has started, any failure (mid-stream 5xx, 429 from the follow-up
  fold call, etc.) becomes a terminal error frame instead of a retry. Mock mode
  (`?mock=true`, gated by `DEV_MOCK_ENABLED=1` in `.env`, 403 if unset) streams a
  canned scene word-by-word with realistic pacing and a canned `turn_complete`
  — zero Gemini calls, doubles as the client-animation dev fixture.
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

Tests in `tests/test_api.py` and `tests/test_templates.py` (pytest + FastAPI
`TestClient`, **45 tests**): health check; retry-then-succeed and
retry-exhaustion → 503; 429-without-retry and other-4xx passthrough; empty-response
→ 502; /suggest shape bare and with `template_id` (404 on unknown; prompt ORDER
pinned: static prompt → genre style → premise, the caching contract); /expand
shape and validation (422); /continue's scene+summary+scenarios shape, call order
(`scene` then `fold`), per-call cost caps pinned ((600,0.9)/(400,0.7)), its
404/422/502 paths incl. structurally-bad scribe JSON; `parse_model_json`
fence-stripping and non-object rejection; usage-log appends, logging-failure
resilience + stderr warning; the template loader's validation (missing keys,
duplicate ids, empty dir) plus the real `templates/` dir loading all four genres;
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

Supporting files: `requirements.txt` (fastapi, uvicorn, python-dotenv, google-genai,
pytest), `.env.example` (template), real `.env` (holds `GEMINI_API_KEY`, git-ignored),
`.gitignore` (ignores `.env`, `venv/`, `__pycache__`, `logs/`), `story_templates.py`
(genre-template loader), `usage_log.py` (cost meter), `templates/*.json` (the 4
genres). Design docs live under `docs/superpowers/specs/` and `docs/superpowers/plans/`.

Public on GitHub: `github.com/OmarFishir/Storyteller`, branch `master` tracking
`origin/master`.

## Environment / how to run

- Windows, PowerShell, VS Code. Project at `C:\dev\Storyteller`.
- Activate venv: `venv\Scripts\activate` (NOT the Unix `source` path).
- Run server: `uvicorn main:app --reload`. Test UI: `http://127.0.0.1:8000/docs`.
- Run tests: `venv\Scripts\python.exe -m pytest tests/ -v`.

## NEXT STEPS — follow the roadmap

The approved phase plan lives in
`docs/superpowers/specs/2026-07-02-voice-first-roadmap.md`. Summary:

1. **Phase 1 (DONE): story engine** — `/continue` running-summary endpoint
   (client carries summary; stateless), genre template system v1 (4 genres as
   data files, `GET /templates`), token/cost logging, public GitHub remote. All
   live-verified against real Gemini; see "What's BUILT and WORKING" above.
2. **Phase 2 (NEXT): vertical slice** — Expo app skeleton, streaming (SSE) story view
   with animated text, push-to-talk on-device speech recognition, narration v1
   (quality TTS ~$5 + device-TTS fallback), abortable playback.
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
