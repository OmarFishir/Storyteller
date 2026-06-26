# Design: `POST /expand` + shared Gemini helper

**Date:** 2026-06-26
**Status:** Approved (pending implementation)
**Author:** Storyteller project (designed in chat with Claude)

## Goal

Add the second endpoint of the story-building loop. After a user has *picked* a
scenario from `/suggest`, `/expand` lets them refine it with a plain-English
instruction ("make it darker", "longer", "add dialogue") and get a rewritten
version back, shown alongside the original.

This is next step #1 on the roadmap. It reuses the patterns established by
`/suggest` and fills a gap the handoff doc exposed: the `call_gemini_with_retry`
wrapper described in the handoff does **not** actually exist in `main.py` yet.

## Request / Response

```
POST /expand
Request:  { "scenario": "the chosen scenario text", "instruction": "make it darker" }
Response: { "original": "the chosen scenario text", "expanded": "the rewritten version" }
```

- Both request fields are required, non-empty strings (Pydantic `ExpandRequest`).
- `original` is echoed straight from the request — the model is **not** asked to
  reproduce it. We only pay the model to produce `expanded`.
- Returning both makes the response self-contained: a UI can render a before/after
  from one object without tracking client-side state. Slightly redundant on the
  wire, simpler to consume — an accepted trade.

## New shared helper: `call_gemini(contents, max_tokens, temperature)`

One function that performs the actual Gemini request, used by **both** endpoints.

- Retries transient `ServerError` (503 "overloaded" / 5xx) up to 3 times with
  exponential backoff: 1s, 2s, 4s.
- On exhaustion, raises a clean `HTTPException(503, "AI model is busy...")`
  instead of leaking a stack trace / 500.
- Returns the model's `.text`.
- **`/suggest` is refactored to call it too**, so retry logic lives in exactly
  one place (DRY — one fix point, not two copies to keep in sync).

## `/expand` specifics

- Static `EXPAND_PROMPT`, front-loaded and identical on every call (same
  caching-ready shape as the existing `SYSTEM_PROMPT`).
- `max_output_tokens: 600` (~450 words / 2-3 paragraphs) so "make it longer"
  isn't chopped mid-sentence, while still capping the expensive output lever.
- `temperature: 0.8` — middle ground. Lower than `/suggest`'s 0.9 so the model
  *follows the instruction* rather than wandering. Fixed for v1.
- **No JSON parsing.** The model returns prose; we use `.text` directly. No code
  fences to strip, no `parse_scenarios`, one fewer failure mode than `/suggest`.

## Out of scope for v1 (deliberate)

- **No broader story context.** `/expand` sees only the one scenario + the
  instruction. The running-summary system (a later project) will feed richer
  context. Staying stateless now is correct, not lazy.
- **No auth / quotas / rate limiting.** Separate later step before public exposure.
- **No user-facing creativity dial.** The temperature knob exists internally but
  is fixed at 0.8; exposing it to the client is a future feature, not v1.

## Verification (how we'll know it's done)

1. TDD: write a failing test first asserting `/expand` returns both keys with a
   non-empty `expanded` string.
2. Implement until the test passes.
3. Prove it live in `/docs`: expand a scenario with "make it darker", confirm a
   sensible rewrite.
4. Regression check: confirm `/suggest` still returns 3 scenarios after the
   refactor to `call_gemini`.

## Notes / follow-ups surfaced during design

- The project is **not under git version control yet** (`git init` pending). This
  spec will be committed once the repo is initialized.
- A `CLAUDE.md` file should be created to persist project context across sessions
  (planned for end of this session, after `/expand` lands).
