# Storyteller — Project Context for Claude

This file loads automatically at the start of every session. It's the
self-loading version of the project handoff. Keep it current as the project grows.

## What this project is

**Storyteller** is an AI-assisted, choose-your-own-adventure story builder. Core loop:

1. User gives a story premise.
2. AI suggests 3 short, distinct next-scenario options.
3. User picks one, optionally expands/edits it.
4. AI folds the choice into the running story and suggests the next 3 options.
5. Repeat.

v1 wedge is **general creative fiction** (kept broad on purpose). It's a personal
learning + portfolio project.

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
- **Frontend (LATER):** React Native via Expo. NOT built yet.
- **Architecture rule (critical):** the API key NEVER lives in the mobile app.
  Flow is: mobile app → our FastAPI backend (holds key) → Gemini. The backend is
  mandatory because anything shipped to a phone can be cracked open.

## Cost philosophy (the spine)

Users carry AI cost via pricing/quotas; the provider bills per-token. Scale is fine
IF free usage is capped. Cost levers, in order of impact:

1. **Don't resend the whole story every turn.** Maintain a compact running SUMMARY
   and send that + the current scene. (NOT built yet — the next big piece.)
2. **Model tiering:** cheap model for suggestions/short edits; reserve expensive
   model for moments that matter.
3. **Prompt caching:** static template/system text is identical every call; cached
   input is ~10x cheaper. Put static text at the front. (NOT built yet.)
4. **Cap output length** via `max_output_tokens` — output tokens cost 3–8x input.

## What's BUILT and WORKING

FastAPI server in `main.py`:

- `GET /` — health check, returns `{"status":"ok",...}`.
- `POST /suggest` — `{"premise": "..."}` → `{"scenarios": ["...","...","..."]}`.
  Uses a static `SYSTEM_PROMPT` forcing raw JSON, plus `parse_scenarios()` which
  defensively strips code fences and validates a list of strings (raises a clean
  502 on bad output).
- `POST /expand` — `{"scenario": "...", "instruction": "..."}` →
  `{"original": "...", "expanded": "..."}`. Refines a chosen scenario per a
  plain-English instruction ("make it darker"). Static `EXPAND_PROMPT`,
  `max_output_tokens=600`, `temperature=0.8`. Returns prose directly (NO JSON
  parsing — simpler than /suggest). Echoes `original` from the request rather than
  paying the model to reproduce it.
- `call_gemini(contents, max_tokens, temperature)` — the ONE shared helper both
  endpoints use. Retries transient `errors.ServerError` (5xx) up to 3 times with
  exponential backoff (1s, 2s, 4s); on exhaustion raises a clean 503. Verified live:
  the free tier overloads often, and this returns a graceful 503 instead of a crash.

Tests in `tests/test_api.py` (pytest + FastAPI `TestClient`): health check, retry
succeeds after transient 503, retry exhaustion → 503, /suggest shape, /expand shape,
/expand validation (422 on missing field). Tests MOCK the Gemini layer — no real API
calls, no cost. Run: `venv\Scripts\python.exe -m pytest tests/ -v`.

Supporting files: `requirements.txt` (fastapi, uvicorn, python-dotenv, google-genai,
pytest), `.env.example` (template), real `.env` (holds `GEMINI_API_KEY`, git-ignored),
`.gitignore` (ignores `.env`, `venv/`, `__pycache__`). Design docs live under
`docs/superpowers/specs/` and `docs/superpowers/plans/`.

Under git (local only, branch `master`, no remote yet).

## Environment / how to run

- Windows, PowerShell, VS Code. Project at `C:\dev\Storyteller`.
- Activate venv: `venv\Scripts\activate` (NOT the Unix `source` path).
- Run server: `uvicorn main:app --reload`. Test UI: `http://127.0.0.1:8000/docs`.
- Run tests: `venv\Scripts\python.exe -m pytest tests/ -v`.

## NEXT STEPS (priority order)

1. **Running summary system** — the big cost-control piece. After a scenario is
   accepted, maintain a compact summary of the story-so-far; send summary + current
   scene instead of full history. Simplest v1: return summary to the client and have
   it pass it back each turn (keeps the backend stateless).
2. **Prompt caching** for the static SYSTEM_PROMPT / EXPAND_PROMPT text.
3. **Per-user quota / rate limiting** before any public exposure (a single runaway
   user is the real bill risk).
4. **GitHub remote** — push `master` for backup + portfolio visibility.
5. **React Native (Expo) app** — chat-style UI: tappable scenario cards, an edit box,
   a running-story view. Should handle 503 gracefully ("muse is busy, tap to retry").
   Built LAST.

## Concepts already covered (don't re-explain unless asked)

venv, `.env`/env vars, Windows vs Unix activate paths, HTTP status codes (2xx/4xx/5xx),
422 validation vs 500 crash, transient vs permanent errors, exponential backoff,
FastAPI `/docs` (Swagger UI), reading tracebacks, git init / commits / .gitignore,
TDD (write failing test → watch it fail → implement → watch it pass → commit), why
tests mock the external API, DRY (one shared `call_gemini`).
