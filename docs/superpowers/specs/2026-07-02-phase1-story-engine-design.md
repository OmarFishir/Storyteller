# Design: Phase 1 — The Complete Story Engine

**Date:** 2026-07-02
**Status:** Approved (pending implementation)
**Roadmap context:** Phase 1 of `2026-07-02-voice-first-roadmap.md`

## Goal

Finish the backend story loop so a client (Phase 2) has something to drive:
stories that *advance* scene by scene, shaped by genre templates, with every
model call's cost logged. Plus: push the repo to a public GitHub remote.

## Decisions made in this design session

| Question | Decision |
|---|---|
| What is the story made of? | **Written scenes.** Picking an option triggers the AI to write that scene as real prose (2–3 paragraphs). The narrator (Phase 2) needs prose worth reading aloud. |
| Call shape per turn | **Two calls.** Call 1 "storyteller" writes the scene as pure prose (no JSON). Call 2 "scribe" reads old summary + new scene, returns JSON `{summary, scenarios}`. Prose stays prose; structure stays structured. Maps onto model tiering later. |
| Launch genres | Fantasy adventure, Mystery/noir, Sci-fi, Fairy tale (bedtime). (+user flagged interest in more — adding a genre is a one-file job by design.) |
| GitHub | **Public repo** — portfolio visibility from day one. |

## 1. `POST /continue` — the heart

```
Request:  { "template_id": "fantasy",
            "summary": "story-so-far summary (the premise, on turn one)",
            "chosen_scenario": "the option the user picked (possibly edited via /expand)" }

Response: { "scene": "2-3 paragraphs of written story prose",
            "summary": "updated compact summary folding in the new scene",
            "scenarios": ["next option 1", "option 2", "option 3"] }
```

All request fields required strings (`ContinueRequest`). Unknown `template_id`
→ clean 404 listing valid ids.

**Call 1 — storyteller (creative):** static story prompt + template `style` +
`Story so far: {summary}` + `What happens next: {chosen_scenario}` → scene
prose. `max_output_tokens=600`, `temperature=0.9`, no JSON parsing.

**Call 2 — scribe (mechanical):** static fold prompt + old summary + new scene
→ raw JSON `{"summary": "...", "scenarios": ["...", "...", "..."]}`.
`max_output_tokens=400`, `temperature=0.7`. Summary instructed to stay under
~150 words while preserving named characters and unresolved plot threads.
This is the cost-control contract: a 50-turn story still sends ~150 words of
history, not the whole transcript.

**State:** client carries the summary (sends it, gets the updated one back).
Backend stays stateless. Turn one: client passes the premise as `summary`.
`/expand` is unchanged: refine an option, feed the result to `/continue` as
`chosen_scenario`.

## 2. Genre templates — data, not code

- New `templates/` directory: `fantasy.json`, `noir.json`, `scifi.json`,
  `fairytale.json`.
- Each file: `{ "id", "name", "description", "style", "premise_seeds": [3] }`.
  `style` is the prompt-injection text (tone, vocabulary, pacing rules);
  `premise_seeds` are ready-made starters the user can pick or speak over.
- New module `story_templates.py`: loads + validates all template files at
  startup (fail loudly on malformed files, same philosophy as the missing-key
  check); exposes lookup by id.
- `GET /templates` returns the list (id, name, description, premise_seeds —
  NOT `style`; that's backend prompt material, not client content).
- `POST /suggest` gains optional `template_id` so genre style shapes the very
  first options. Omitted → current freeform behavior (backward compatible).

## 3. Cost logging — in the one place every call passes through

- `call_gemini` gains a `label` parameter ("suggest", "expand", "scene",
  "fold") and logs one JSONL line per successful call to `logs/usage.jsonl`
  (git-ignored): timestamp, label, model, input tokens, output tokens — read
  from the usage metadata on the Gemini response.
- New module `usage_log.py` owns file writing. No database, no dashboard —
  visible and greppable is the v1 bar.
- Exact SDK usage-metadata field names verified against the installed
  `google-genai` package during planning (not guessed).

## 4. Housekeeping in the same phase

- **Shared JSON parse helper:** generalize `parse_scenarios` into a defensive
  parse-and-validate helper (strip fences → parse → validate shape → 502 with
  raw text on garbage) used by both `/suggest` and the scribe call.
- **`main.py` gets relief, not a rewrite:** `story_templates.py` and
  `usage_log.py` are separate modules; endpoints and prompts stay in `main.py`
  until it actually hurts.
- **GitHub:** create public repo, push `master`, at the end of the phase.

## Out of scope (deliberate)

- **Streaming/SSE** — Phase 2, when a client exists to consume it. `/docs`
  can't render streams; `/continue`'s contract won't change shape.
- **Persistence / story IDs** — Phase 3.
- **Quotas / auth** — Phase 6.
- **Prompt caching / model tiering** — Phase 3+ (the two-call split already
  creates the tiering seam).

## Verification (done when)

1. TDD throughout; all tests mock the Gemini layer (the two-call flow mocked
   with sequential fake responses).
2. In `/docs`: pick a template → styled options → choose → scene written →
   repeat several turns; summary stays compact; `logs/usage.jsonl` shows each
   call's tokens.
3. `/suggest` and `/expand` still green (regression).
4. Repo visible on GitHub with full commit history.
