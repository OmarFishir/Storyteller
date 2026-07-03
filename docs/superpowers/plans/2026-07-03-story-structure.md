# Story Structure + Length + Richer Scenes/Options — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stories progress through credible per-genre narrative structures at a user-chosen length (short/medium/long), scenes carry book-level environmental detail, and option cards grow to 3–4 sentences.

**Architecture:** Beat selection is a pure function in a new `story_beats.py` (turn + length → current/next beat, epilogue past the end). Structures are DATA in `templates/*.json` (validated fail-loud by the existing loader). Prompt assembly is extracted into two builders in `main.py` used by BOTH `/continue` and the stream path (removes existing duplication). The client carries `turn` + `length` statelessly, exactly like it carries `summary`.

**Tech Stack:** Existing: FastAPI + pytest (backend, 47 tests), Expo/RNTL (client, 24 tests). No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-03-story-structure-design.md` governs. HARD INVARIANT: the canonical story is the verbatim scene sequence; summaries are AI memory only.
- `ContinueRequest` gains `turn: int = 1` (422 if < 1) and `length: "short"|"medium"|"long" = "short"`. Defaults preserve today's behavior/cost for old callers.
- Beat math: `TURNS_PER_BEAT = {"short": 1, "medium": 2, "long": 3}`; `beat_index = (turn - 1) // TURNS_PER_BEAT[length]`; past the last beat → EPILOGUE (built-in constant, repeats forever — no hard stop).
- Budgets: `SCENE_BUDGETS = {"short": 600, "medium": 800, "long": 1000}`; fold call = 800 (was 400); `/suggest` = 600 (was 300). Temperatures unchanged (scene 0.9, fold 0.7, suggest 0.9).
- Summary word contract by length: short 150 / medium 200 / long 250 — the NUMBER moves out of the static FOLD_PROMPT into the dynamic section (caching rule: static text must stay identical every call).
- Options: "3-4 sentences" in FOLD_PROMPT and SYSTEM_PROMPT (was 1-2).
- Prompt order (caching contract, pinned by existing test): static prompt → genre style → beat (semi-static) → dynamic content.
- Templates without `structure` must work exactly as today (no beat lines) — loader treats `structure` as optional; when present: non-empty string `source`, non-empty `beats` list of `{name, guidance}` non-empty strings; violations → RuntimeError at startup.
- Backend: `venv/Scripts/python.exe -m pytest tests/ -v` (47 now). Client: `cd client && npx jest --watchAll=false` (24 now) + `npx tsc --noEmit`. Conventional commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- main.py full split (gemini.py/prompts.py) stays PARKED for Phase 3 — do not restructure beyond what this plan states.

---

### Task 1: `story_beats.py` — pure beat selection

**Files:**
- Create: `story_beats.py`
- Test: `tests/test_beats.py`

**Interfaces:**
- Produces: `TURNS_PER_BEAT: dict[str, int]`; `EPILOGUE_BEAT: dict` (keys `name`, `guidance`); `select_beats(structure: dict | None, turn: int, length: str) -> tuple[dict, dict] | None` — returns `(current_beat, next_beat)` where each beat is `{"name": str, "guidance": str}`; `None` when `structure` is None; `(EPILOGUE_BEAT, EPILOGUE_BEAT)` past the end; `next` of the final beat is `EPILOGUE_BEAT`. Task 3 consumes this exact signature.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_beats.py`:

```python
import pytest

import story_beats
from story_beats import EPILOGUE_BEAT, select_beats

STRUCTURE = {
    "source": "https://example.test/structure",
    "beats": [
        {"name": "Beat One", "guidance": "g1"},
        {"name": "Beat Two", "guidance": "g2"},
        {"name": "Beat Three", "guidance": "g3"},
    ],
}


def test_no_structure_returns_none():
    assert select_beats(None, turn=1, length="short") is None


def test_short_maps_one_turn_per_beat():
    current, nxt = select_beats(STRUCTURE, turn=1, length="short")
    assert current["name"] == "Beat One"
    assert nxt["name"] == "Beat Two"
    current, nxt = select_beats(STRUCTURE, turn=3, length="short")
    assert current["name"] == "Beat Three"
    assert nxt == EPILOGUE_BEAT  # next after the final beat


def test_medium_spends_two_turns_per_beat():
    assert select_beats(STRUCTURE, turn=2, length="medium")[0]["name"] == "Beat One"
    assert select_beats(STRUCTURE, turn=3, length="medium")[0]["name"] == "Beat Two"


def test_long_spends_three_turns_per_beat():
    assert select_beats(STRUCTURE, turn=3, length="long")[0]["name"] == "Beat One"
    assert select_beats(STRUCTURE, turn=4, length="long")[0]["name"] == "Beat Two"


def test_past_the_end_is_epilogue_forever():
    current, nxt = select_beats(STRUCTURE, turn=4, length="short")
    assert current == EPILOGUE_BEAT and nxt == EPILOGUE_BEAT
    current, nxt = select_beats(STRUCTURE, turn=99, length="short")
    assert current == EPILOGUE_BEAT and nxt == EPILOGUE_BEAT


def test_epilogue_has_prompt_ready_fields():
    assert EPILOGUE_BEAT["name"] and EPILOGUE_BEAT["guidance"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_beats.py -v`
Expected: collection error `ModuleNotFoundError: No module named 'story_beats'`.

- [ ] **Step 3: Implement**

Create `story_beats.py`:

```python
"""
Beat selection for structured stories.

A template's structure is an ordered list of narrative beats (data, not code —
see templates/*.json). The story's position is derived STATELESSLY from the
turn number the client carries (same pattern as the running summary): the
chosen length stretches the arc by spending more scenes inside each beat.
Past the final beat the story never hard-stops — it enters an epilogue that
leans toward closure for as long as the reader keeps choosing.
"""

TURNS_PER_BEAT = {"short": 1, "medium": 2, "long": 3}

EPILOGUE_BEAT = {
    "name": "Epilogue",
    "guidance": (
        "The story's arc is complete. Wind down gracefully: resolve remaining "
        "threads, honor the consequences of the journey, and lean toward "
        "closure — while leaving room to continue if the reader keeps going."
    ),
}


def select_beats(structure: dict | None, turn: int, length: str) -> tuple[dict, dict] | None:
    """Return (current_beat, next_beat) for this turn, or None if unstructured."""
    if structure is None:
        return None
    beats = structure["beats"]
    index = (turn - 1) // TURNS_PER_BEAT[length]
    if index >= len(beats):
        return (EPILOGUE_BEAT, EPILOGUE_BEAT)
    current = beats[index]
    nxt = beats[index + 1] if index + 1 < len(beats) else EPILOGUE_BEAT
    return (current, nxt)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (53 = 47 + 6).

- [ ] **Step 5: Commit**

```bash
git add story_beats.py tests/test_beats.py
git commit -m "feat: pure beat selection (turn + length -> current/next beat, epilogue)"
```

---

### Task 2: Structures as template data + loader validation

**Files:**
- Modify: `templates/noir.json`, `templates/fantasy.json`, `templates/fairytale.json`, `templates/scifi.json` (each gains a `structure` block)
- Modify: `story_templates.py` (validate `structure` when present)
- Test: `tests/test_templates.py`

**Interfaces:**
- Produces: every loaded template dict MAY have `template["structure"] = {"source": str, "beats": [{"name","guidance"}...]}`. All four shipped templates HAVE it. Task 3 reads `template.get("structure")`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_templates.py`:

```python
def test_structure_is_optional(tmp_path):
    _write(tmp_path, "test.json", VALID)  # VALID has no structure key
    templates = story_templates.load_templates(str(tmp_path))
    assert "structure" not in templates["test"]


def test_valid_structure_loads(tmp_path):
    good = dict(VALID)
    good["structure"] = {
        "source": "https://example.test",
        "beats": [{"name": "One", "guidance": "g"}],
    }
    _write(tmp_path, "test.json", good)
    templates = story_templates.load_templates(str(tmp_path))
    assert templates["test"]["structure"]["beats"][0]["name"] == "One"


@pytest.mark.parametrize(
    "structure",
    [
        {"beats": [{"name": "One", "guidance": "g"}]},          # missing source
        {"source": "https://x", "beats": []},                    # empty beats
        {"source": "https://x", "beats": [{"name": "One"}]},     # beat missing guidance
        {"source": "https://x", "beats": [{"name": "", "guidance": "g"}]},  # empty name
        {"source": "https://x"},                                 # missing beats
    ],
)
def test_bad_structure_fails_loud(tmp_path, structure):
    bad = dict(VALID)
    bad["structure"] = structure
    _write(tmp_path, "bad.json", bad)
    with pytest.raises(RuntimeError, match="structure"):
        story_templates.load_templates(str(tmp_path))


def test_all_shipped_templates_have_sourced_structures():
    templates = story_templates.load_templates()
    for tid in ("fantasy", "noir", "scifi", "fairytale"):
        structure = templates[tid]["structure"]
        assert structure["source"].startswith("http")
        assert len(structure["beats"]) >= 8
        for beat in structure["beats"]:
            assert beat["name"] and beat["guidance"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_templates.py -v`
Expected: the validation tests FAIL (loader accepts anything today); the shipped-templates test FAILS (KeyError: 'structure').

- [ ] **Step 3: Implement the loader validation**

In `story_templates.py`, add inside `load_templates` after the premise_seeds check:

```python
        structure = data.get("structure")
        if structure is not None:
            if not isinstance(structure, dict) or not isinstance(
                structure.get("source"), str
            ) or not structure.get("source"):
                raise RuntimeError(
                    f"Template {filename}: structure needs a non-empty string 'source'"
                )
            beats = structure.get("beats")
            if not isinstance(beats, list) or not beats:
                raise RuntimeError(
                    f"Template {filename}: structure needs a non-empty 'beats' list"
                )
            for beat in beats:
                if (
                    not isinstance(beat, dict)
                    or not isinstance(beat.get("name"), str)
                    or not beat["name"]
                    or not isinstance(beat.get("guidance"), str)
                    or not beat["guidance"]
                ):
                    raise RuntimeError(
                        f"Template {filename}: every structure beat needs non-empty "
                        "string 'name' and 'guidance'"
                    )
```

- [ ] **Step 4: Add the four structure blocks (full data — sources are load-bearing)**

Add to `templates/noir.json` (12-Step Mystery Formula):

```json
  "structure": {
    "source": "https://storytellingdb.com/12-step-mystery-formula/",
    "beats": [
      {"name": "Disclose the Mystery", "guidance": "Introduce the central puzzle or crime that drives the story; hook with the mystery itself."},
      {"name": "Set the Sleuth on the Path", "guidance": "Establish the investigator and why this case is naturally, personally theirs."},
      {"name": "Introduce the Subplot", "guidance": "Open a secondary thread — a relationship or personal stake — that deepens character alongside the case."},
      {"name": "Facts About Suspects", "guidance": "Introduce the suspects, their ties to the victim, and their possible motives."},
      {"name": "Broaden the Investigation", "guidance": "Expand beyond first interviews: new locations, records, physical evidence."},
      {"name": "Sleuth's Background", "guidance": "Reveal the investigator's relevant history — why they work the way they do, and what this case costs them."},
      {"name": "Reveal Hidden Motives", "guidance": "Concealed connections and motives surface; initial assumptions start to crack."},
      {"name": "Reveal Results", "guidance": "The sleuth lands on a preliminary theory — plausible, confident, and subtly wrong."},
      {"name": "Review the Case", "guidance": "New evidence breaks the false solution; the investigation pivots."},
      {"name": "Weigh the Evidence", "guidance": "With fresh insight, weigh everything and assemble the true final theory."},
      {"name": "Subplot Resolution", "guidance": "Close the secondary thread before the main reveal."},
      {"name": "Climax", "guidance": "The dramatic confrontation reveals the full solution — how, who, and why."}
    ]
  }
```

Add to `templates/fantasy.json` (Hero's Journey — Vogler):

```json
  "structure": {
    "source": "https://en.wikipedia.org/wiki/The_Writer%27s_Journey:_Mythic_Structure_for_Writers",
    "beats": [
      {"name": "Ordinary World", "guidance": "Show the hero's normal life — and what is quietly missing from it."},
      {"name": "Call to Adventure", "guidance": "A challenge, discovery, or invitation disrupts the ordinary world."},
      {"name": "Refusal of the Call", "guidance": "Fear, duty, or doubt holds the hero back from answering."},
      {"name": "Meeting the Mentor", "guidance": "A guide provides wisdom, tools, or the push the hero needs."},
      {"name": "Crossing the Threshold", "guidance": "The hero commits and steps into the unfamiliar world; there is no easy way back."},
      {"name": "Tests, Allies, Enemies", "guidance": "Trials reveal the new world's rules; friendships and rivalries form."},
      {"name": "Approach to the Inmost Cave", "guidance": "Preparation and gathering dread on the way to the central danger."},
      {"name": "The Ordeal", "guidance": "The hero faces their greatest fear or deadliest foe — a symbolic death and rebirth."},
      {"name": "Reward", "guidance": "The hero seizes the prize: the treasure, the secret, the reconciliation."},
      {"name": "The Road Back", "guidance": "Consequences give chase as the hero turns toward home."},
      {"name": "Resurrection", "guidance": "One final, ultimate test — the hero must prove the transformation is real."},
      {"name": "Return with the Elixir", "guidance": "Home again, changed, bearing something that heals the ordinary world."}
    ]
  }
```

Add to `templates/fairytale.json` (Story Spine — Kenn Adams):

```json
  "structure": {
    "source": "https://www.npr.org/2026/06/23/nx-s1-5750619/meet-the-creator-of-the-story-spine-an-8-sentence-tool-to-create-and-analyze-stories",
    "beats": [
      {"name": "Once Upon a Time", "guidance": "Warmly establish the world and its hero, simply and cozily."},
      {"name": "Every Day", "guidance": "Show the comforting routine of that world."},
      {"name": "But One Day", "guidance": "Something gentle-but-surprising breaks the routine."},
      {"name": "Because of That (first)", "guidance": "The first consequence pulls the hero into action."},
      {"name": "Because of That (second)", "guidance": "Consequences compound; the stakes grow, but stay bedtime-gentle."},
      {"name": "Because of That (third)", "guidance": "The chain of consequences reaches its turning point."},
      {"name": "Until Finally", "guidance": "The climactic moment resolves the trouble with warmth and courage."},
      {"name": "Ever Since Then", "guidance": "The new, better routine and its gentle lesson — end calm and reassuring."}
    ]
  }
```

Add to `templates/scifi.json` (Story Circle — Dan Harmon):

```json
  "structure": {
    "source": "https://reedsy.com/blog/guide/story-structure/dan-harmon-story-circle/",
    "beats": [
      {"name": "You", "guidance": "A character in their zone of comfort; the familiar order of their world."},
      {"name": "Need", "guidance": "They want or lack something; discontent surfaces."},
      {"name": "Go", "guidance": "They cross into an unfamiliar situation."},
      {"name": "Search", "guidance": "They adapt, struggle, and pay tolls in the unfamiliar world."},
      {"name": "Find", "guidance": "They find what they came for — though not in the form expected."},
      {"name": "Take", "guidance": "It costs more than expected; a heavy price is paid."},
      {"name": "Return", "guidance": "They head back toward the familiar world, changed by what they carry."},
      {"name": "Change", "guidance": "The new order integrates the lesson; the character and world are transformed."}
    ]
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (60 = 53 + 7 new).

- [ ] **Step 6: Commit**

```bash
git add templates/ story_templates.py tests/test_templates.py
git commit -m "feat: per-genre story structures as sourced template data, validated fail-loud"
```

---

### Task 3: Beat-aware prompts, length-scaled budgets, richer options

**Files:**
- Modify: `main.py` (ContinueRequest, prompts, budget constants, two prompt builders, wiring in `continue_story` + `_stream_turn`, `/suggest` budget, mock scenario content)
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: `story_beats.select_beats` (Task 1), `template.get("structure")` (Task 2).
- Produces: `build_scene_prompt(template: dict, req: "ContinueRequest") -> str`; `build_fold_prompt(req: "ContinueRequest", scene: str) -> str`; `SCENE_BUDGETS`, `FOLD_BUDGET = 800`, `SUMMARY_WORDS`. `ContinueRequest` gains `turn`/`length` (Task 4's client sends them).

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_api.py` (and UPDATE the existing pinned-caps assertion in
`test_continue_returns_scene_summary_and_options` from `(400, 0.7)` to
`(800, 0.7)` for the fold call — the budget deliberately changed):

```python
def test_continue_request_rejects_bad_turn_and_length():
    assert client.post("/continue", json=dict(CONTINUE_BODY, turn=0)).status_code == 422
    assert client.post("/continue", json=dict(CONTINUE_BODY, length="epic")).status_code == 422


def test_scene_prompt_carries_current_beat_and_craft():
    req = main.ContinueRequest(**CONTINUE_BODY, turn=1, length="short")
    prompt = main.build_scene_prompt(main.TEMPLATES["noir"], req)
    assert "Disclose the Mystery" in prompt
    # order: static prompt first, then style, then beat, then dynamic content
    assert prompt.index(main.STORY_PROMPT[:40]) < prompt.index(
        main.TEMPLATES["noir"]["style"][:30]
    ) < prompt.index("Disclose the Mystery") < prompt.index(req.summary)
    # environmental-craft instruction lives in the STATIC prompt (caching rule)
    assert "sensory" in main.STORY_PROMPT.lower()


def test_scene_prompt_advances_beats_with_turn_and_length():
    req = main.ContinueRequest(**CONTINUE_BODY, turn=2, length="short")
    assert "Set the Sleuth on the Path" in main.build_scene_prompt(main.TEMPLATES["noir"], req)
    req = main.ContinueRequest(**CONTINUE_BODY, turn=2, length="medium")
    assert "Disclose the Mystery" in main.build_scene_prompt(main.TEMPLATES["noir"], req)


def test_scene_prompt_epilogue_past_the_arc():
    req = main.ContinueRequest(**CONTINUE_BODY, turn=13, length="short")
    assert "Epilogue" in main.build_scene_prompt(main.TEMPLATES["noir"], req)


def test_fold_prompt_steers_toward_next_beat_and_scales_summary():
    req = main.ContinueRequest(**CONTINUE_BODY, turn=1, length="long")
    prompt = main.build_fold_prompt(req, "the scene text")
    assert "Set the Sleuth on the Path" in prompt   # next beat, not current
    assert "250" in prompt                           # long summary word budget
    assert "3-4 sentences" in main.FOLD_PROMPT


def test_scene_budget_scales_with_length(monkeypatch):
    captured = []

    def fake_call_gemini(contents, **kwargs):
        captured.append((kwargs.get("max_tokens"), kwargs.get("label")))
        if kwargs.get("label") == "fold":
            return '{"summary": "s", "scenarios": ["a", "b", "c"]}'
        return "scene"

    monkeypatch.setattr(main, "call_gemini", fake_call_gemini)
    client.post("/continue", json=dict(CONTINUE_BODY, turn=1, length="long"))
    assert (1000, "scene") in captured and (800, "fold") in captured


def test_mock_scenarios_are_three_to_four_sentences():
    for turn in main.MOCK_TURNS:
        for option in turn["scenarios"]:
            sentences = [s for s in option.replace("!", ".").replace("?", ".").split(".") if s.strip()]
            assert 3 <= len(sentences) <= 4, option
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_api.py -v`
Expected: new tests FAIL (`build_scene_prompt` missing, 422s not raised, budgets wrong, mock options short).

- [ ] **Step 3: Implement**

In `main.py`:

a) Imports: add `from typing import Literal`; `from pydantic import BaseModel, Field`; `import story_beats`.

b) `ContinueRequest` becomes:

```python
class ContinueRequest(BaseModel):
    template_id: str
    summary: str
    chosen_scenario: str
    turn: int = Field(1, ge=1)
    length: Literal["short", "medium", "long"] = "short"
```

c) Budget constants next to the prompts:

```python
SCENE_BUDGETS = {"short": 600, "medium": 800, "long": 1000}
FOLD_BUDGET = 800  # 3 options x 3-4 sentences + the summary
SUMMARY_WORDS = {"short": 150, "medium": 200, "long": 250}
```

d) `STORY_PROMPT` — replace with (static; environmental craft added):

```python
STORY_PROMPT = """You are the narrator of an interactive story.
Write the next scene as vivid prose, 2-4 short paragraphs.
Follow the genre style exactly. Continue naturally from the story so far, and
make the scene deliver on the chosen direction. Ground the scene in its place
the way published fiction does: concrete sensory detail — sound, light,
weather, texture, smell — and let the setting itself carry story, not just
dialogue and plot. End at a natural pause that invites the next choice.
Respond with ONLY the scene prose — no title, no labels, no markdown."""
```

e) `FOLD_PROMPT` — replace with (the word count moves OUT; options grow):

```python
FOLD_PROMPT = """You are the scribe for an interactive story. You receive the
story-so-far summary and the newest scene. Do two jobs:
1. Fold the newest scene into an updated summary of the WHOLE story so far.
   Keep it under the word limit given below. Preserve named characters, key
   facts, and unresolved plot threads.
2. Propose exactly 3 distinct options for what could happen next. Each option
   must be 3-4 sentences, meaningfully different from the others, and a vivid
   direction the story could take.

Respond with ONLY raw JSON, no markdown, no backticks, in exactly this shape:
{"summary": "updated summary", "scenarios": ["option one", "option two", "option three"]}"""
```

f) `SYSTEM_PROMPT` (`/suggest`): change "1-2 sentences" to "3-4 sentences"; in the `suggest` endpoint change `max_tokens=300` to `max_tokens=600`.

g) The two builders (place after the prompts). Both endpoints then call them —
delete the inline f-strings in `continue_story` AND `_stream_turn` and replace
with `build_scene_prompt(template, req)` / `build_fold_prompt(req, scene)`;
scene call `max_tokens=SCENE_BUDGETS[req.length]`, fold call `max_tokens=FOLD_BUDGET`:

```python
def build_scene_prompt(template: dict, req: ContinueRequest) -> str:
    """Assemble the storyteller prompt: static -> style -> beat -> dynamic."""
    beats = story_beats.select_beats(template.get("structure"), req.turn, req.length)
    beat_block = ""
    if beats:
        current, _ = beats
        beat_block = f"\n\nCurrent story beat: {current['name']} — {current['guidance']}"
    return (
        f"{STORY_PROMPT}\n\nGenre style:\n{template['style']}{beat_block}\n\n"
        f"Story so far:\n{req.summary}\n\n"
        f"Chosen direction:\n{req.chosen_scenario}"
    )


def build_fold_prompt(req: ContinueRequest, scene: str) -> str:
    """Assemble the scribe prompt; the summary word budget scales with length."""
    template = TEMPLATES.get(req.template_id, {})
    beats = story_beats.select_beats(template.get("structure"), req.turn, req.length)
    steer_block = ""
    if beats:
        _, nxt = beats
        steer_block = (
            f"\nSteer the options toward the next story beat: "
            f"{nxt['name']} — {nxt['guidance']}"
        )
    return (
        f"{FOLD_PROMPT}\n\nWord limit for the summary: "
        f"{SUMMARY_WORDS[req.length]} words.{steer_block}\n\n"
        f"Story-so-far summary:\n{req.summary}\n\nNewest scene:\n{scene}"
    )
```

h) Mock scenarios: rewrite each of the 9 strings in `MOCK_TURNS` to 3-4
sentences (keep the same story content, expanded — e.g. first one becomes:
"Mira forces the iron door with her shoulder and a mapmaker's stubbornness.
Inside, candlelight breathes over a great oak table. On it, a map of the
kingdom is drawing itself, ink crawling like patient ants. Every line is
perfect except the corridor she came by — which is being erased behind her.").
Write all nine with real content in this style; the Task 3 test pins the 3-4
sentence count mechanically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (~68). The pre-existing prompt-order test for /suggest and all stream tests stay green (builders preserve order and behavior at the defaults).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_api.py
git commit -m "feat: beat-aware prompts, length-scaled budgets, 3-4 sentence options"
```

---

### Task 4: Client — length picker + turn/length in requests

**Files:**
- Modify: `client/lib/api.ts` (TurnRequest + StoryLength type)
- Modify: `client/app/index.tsx` (length selector, param pass)
- Modify: `client/app/story.tsx` (turn/length in requests)
- Test: `client/app/__tests__/index.test.tsx`, `client/app/__tests__/story.test.tsx`

**Interfaces:**
- Consumes: backend contract from Task 3.
- Produces: `export type StoryLength = "short" | "medium" | "long"`; `TurnRequest` gains `turn: number; length: StoryLength`.

- [ ] **Step 1: Write the failing tests**

`index.test.tsx` — add:

```tsx
  it("passes the chosen length to the story route", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByPlaceholderText } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.changeText(getByPlaceholderText(/premise/i), "a premise");
    fireEvent.press(getByText(/^Long$/));
    fireEvent.press(getByText(/begin the story/i));
    const { router } = require("expo-router");
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/story",
      params: { templateId: "fantasy", premise: "a premise", length: "long" },
    });
  });
```

`story.test.tsx` — the router mock's `useLocalSearchParams` gains
`length: "short"`; UPDATE the three existing exact call-shape assertions to
include `turn` and `length` (opening: `turn: 1, length: "short"`; the
tap-option test's second call: `turn: 2, length: "short"`); add:

```tsx
  it("retry does not advance the turn number", async () => {
    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(
        fixtureStream([{ type: "stream_error", status: 503, detail: "busy" }])
      )
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Fresh." },
          { type: "turn_complete", summary: "s", scenarios: ["A"] },
        ])
      );
    const { getByText } = render(<Story />);
    await waitFor(() => getByText(/tap to retry/i));
    fireEvent.press(getByText(/tap to retry/i));
    await waitFor(() => getByText(/Fresh/));
    expect(spy.mock.calls[0][0].turn).toBe(1);
    expect(spy.mock.calls[1][0].turn).toBe(1); // retry re-sends the SAME turn
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false`
Expected: new/updated tests FAIL (no picker; call shapes lack turn/length).

- [ ] **Step 3: Implement**

- `client/lib/api.ts`: add `export type StoryLength = "short" | "medium" | "long";` and extend `TurnRequest` with `turn: number; length: StoryLength;`.
- `client/app/index.tsx`: below the premise input, three chips — labels exactly `Short`, `Medium`, `Long` (state default `"short"`, selected chip highlighted like the seed chips); include `length` in the `router.push` params.
- `client/app/story.tsx`: read `length` from `useLocalSearchParams` (fallback `"short"`); every `runTurn` request includes `length` and `turn: scenes.length + 1` computed at request-build time (mount → 1; after N committed scenes → N+1; retry resends frozen `pendingTurn` unchanged).

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: ALL PASS (~26), types clean.

- [ ] **Step 5: Commit**

```bash
git add client
git commit -m "feat(client): story length picker; turn+length carried on every request"
```

---

### Task 5: Verify, document, ship

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full suites**

Backend: `venv/Scripts/python.exe -m pytest tests/ -v` (~68). Client: `cd client && npx jest --watchAll=false && npx tsc --noEmit` (~26). Report exact counts.

- [ ] **Step 2: Mock smoke via TestClient** (zero quota): POST `/continue/stream?mock=true` with `turn: 5, length: "long"` → still streams (mock ignores them; regression only).

- [ ] **Step 3: Attempt ONE live structured turn** (2 quota requests): `/continue` with `template_id: "noir"`, a one-line premise as summary, `turn: 1, length: "short"`. If quota allows: verify the scene reads like a mystery OPENING (beat 1) and options steer toward investigation (beat 2); paste evidence. If 429: note it — the structured-arc live test remains blocked pending paid tier, as the spec records.

- [ ] **Step 4: CLAUDE.md**: update What's BUILT (structures as sourced data + beat selection via `story_beats.py`, turn/length contract, budgets table, 3-4 sentence options, epilogue rule, the verbatim-story invariant) and test counts; add the spec to the docs list.

- [ ] **Step 5: Commit + push**

```bash
git add CLAUDE.md
git commit -m "docs: record story structure/length engine in CLAUDE.md"
git push
```

---

## Self-Review

**Spec coverage:** structures-as-data w/ sources → Task 2 (all 40 beats present, verbatim). Turn/length contract + validation → Tasks 3/4. Beat math + epilogue-no-hard-stop → Task 1. Beat-aware storyteller/scribe + caching order → Task 3 (order pinned by test). 3-4 sentence options + budgets → Task 3. Environmental craft in static prompt → Task 3(d) + pinned. Length picker + retry-same-turn → Task 4. Invariant + Phase-3 reading view → docs only (Task 5), no code violates it. Live-verification honesty → Task 5 Step 3. ✓

**Placeholder scan:** Task 3(h) instructs rewriting 9 mock strings with a complete worked example and a mechanical test pinning the format — content authorship delegated with the format test as the gate. No TBDs. ✓

**Type consistency:** `select_beats(structure, turn, length) -> tuple | None` (Task 1) consumed in Task 3's builders; `ContinueRequest.turn/length` (Task 3) match client `TurnRequest.turn/length` (Task 4); `SCENE_BUDGETS[req.length]`/`FOLD_BUDGET` names consistent. ✓
