# Phase 1: Story Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the backend story loop: `/continue` advances stories scene-by-scene with a running summary, genre templates shape every prompt, every Gemini call is cost-logged, and the repo lands on public GitHub.

**Architecture:** `/continue` makes two Gemini calls per turn — a creative "storyteller" call producing pure prose, and a mechanical "scribe" call returning JSON `{summary, scenarios}`. Templates are JSON data files loaded at startup by `story_templates.py`. `usage_log.py` writes one JSONL line per call from inside `call_gemini` (the single choke point). Backend stays stateless — the client carries the summary.

**Tech Stack:** Python 3.14, FastAPI, google-genai SDK, pytest + FastAPI `TestClient` (Gemini always mocked in tests), `gh` CLI (v2.92 confirmed installed) for GitHub.

## Global Constraints

- Windows + PowerShell. Test runs: `venv\Scripts\python.exe -m pytest tests/ -v` (in Bash: `venv/Scripts/python.exe -m pytest tests/ -v`).
- Model name lives in ONE constant: `MODEL = "gemini-2.5-flash-lite"` in `main.py`.
- API key only in `.env` (git-ignored). Never in code or logs.
- Cost caps: storyteller call `max_output_tokens=600` temp `0.9`; scribe call `max_output_tokens=400` temp `0.7`; `/suggest` stays `300`/`0.9`; `/expand` stays `600`/`0.8`.
- Summary contract: scribe instructed to keep summary under ~150 words, preserving named characters and unresolved threads.
- All tests mock the Gemini layer. No real API calls in the suite.
- SDK usage fields (verified in installed package): `response.usage_metadata.prompt_token_count`, `.candidates_token_count` — each `Optional[int]`, and `usage_metadata` itself may be absent → guard with `getattr`/`or 0`.
- Prompt ordering rule (caching-ready): static prompt text first, then semi-static genre style, then dynamic user content.

---

### Task 1: Usage logging (`usage_log.py` + `call_gemini` wiring)

**Files:**
- Create: `usage_log.py`
- Create: `tests/conftest.py`
- Modify: `main.py` (call_gemini signature + logging; import)
- Modify: `.gitignore` (add `logs/`)
- Test: `tests/test_api.py` (add 2 tests)

**Interfaces:**
- Consumes: existing `call_gemini(contents, max_tokens, temperature)`, `MODEL`, Gemini response objects.
- Produces: `usage_log.log_usage(label: str, model: str, input_tokens: int, output_tokens: int) -> None` (module globals `LOG_DIR`, `LOG_PATH`); `call_gemini(contents: str, max_tokens: int, temperature: float, label: str = "unlabeled") -> str`. Tasks 4–5 pass `label=` explicitly.

- [ ] **Step 1: Write the failing tests**

Create `tests/conftest.py` (pytest auto-loads this; the `autouse` fixture redirects ALL tests' usage logs to a temp dir so the suite never writes real files):

```python
import pytest

import usage_log


@pytest.fixture(autouse=True)
def _redirect_usage_log(tmp_path, monkeypatch):
    """Every test writes usage logs to a throwaway temp dir, not logs/."""
    monkeypatch.setattr(usage_log, "LOG_DIR", str(tmp_path))
    monkeypatch.setattr(usage_log, "LOG_PATH", str(tmp_path / "usage.jsonl"))
```

Add to `tests/test_api.py` (imports at top: `import json as jsonlib`, `import usage_log`):

```python
def test_log_usage_appends_jsonl_lines():
    usage_log.log_usage("test", "some-model", 123, 45)
    usage_log.log_usage("test2", "some-model", 10, 5)

    with open(usage_log.LOG_PATH, encoding="utf-8") as f:
        lines = f.read().strip().splitlines()
    assert len(lines) == 2
    entry = jsonlib.loads(lines[0])
    assert entry["label"] == "test"
    assert entry["input_tokens"] == 123
    assert entry["output_tokens"] == 45
    assert "ts" in entry


def test_call_gemini_logs_usage(monkeypatch):
    logged = []
    monkeypatch.setattr(
        main.usage_log, "log_usage", lambda **kw: logged.append(kw)
    )

    class FakeUsage:
        prompt_token_count = 11
        candidates_token_count = 22

    class FakeResponse:
        text = "hi"
        usage_metadata = FakeUsage()

    monkeypatch.setattr(
        main.client.models, "generate_content", lambda **k: FakeResponse()
    )

    main.call_gemini("p", max_tokens=10, temperature=0.1, label="scene")
    assert logged == [
        {"label": "scene", "model": main.MODEL, "input_tokens": 11, "output_tokens": 22}
    ]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_api.py -v`
Expected: collection ERROR (`ModuleNotFoundError: No module named 'usage_log'`) — conftest imports it. That's the correct failure.

- [ ] **Step 3: Implement**

Create `usage_log.py`:

```python
"""
Tiny cost meter. One JSONL line per Gemini call.

JSONL = one JSON object per line. Trivially greppable and parseable —
the whole "dashboard" for now is opening the file. logs/ is git-ignored.
"""
import json
import os
from datetime import datetime, timezone

LOG_DIR = "logs"
LOG_PATH = os.path.join(LOG_DIR, "usage.jsonl")


def log_usage(label: str, model: str, input_tokens: int, output_tokens: int) -> None:
    os.makedirs(LOG_DIR, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "label": label,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
```

In `main.py`: add `import usage_log` after `from google.genai import errors`. Change `call_gemini`'s signature and success path:

```python
def call_gemini(
    contents: str, max_tokens: int, temperature: float, label: str = "unlabeled"
) -> str:
    """
    Make ONE Gemini request, retrying transient server errors (5xx) with
    exponential backoff (1s, 2s, 4s). Returns the model's text.

    Logs token usage for every successful call (the cost meter lives here
    because every endpoint funnels through this one function).

    If the model is still unavailable after all retries, raises a clean
    503 (HTTPException) instead of leaking a 500/stack trace.
    """
    delays = [1, 2, 4]  # waits between attempts; 3 retries after the first try
    for attempt in range(len(delays) + 1):  # 4 attempts total
        try:
            response = client.models.generate_content(
                model=MODEL,
                contents=contents,
                config={
                    "max_output_tokens": max_tokens,
                    "temperature": temperature,
                },
            )
            usage = getattr(response, "usage_metadata", None)
            usage_log.log_usage(
                label=label,
                model=MODEL,
                input_tokens=(usage.prompt_token_count or 0) if usage else 0,
                output_tokens=(usage.candidates_token_count or 0) if usage else 0,
            )
            return response.text
        except errors.ServerError:
            if attempt < len(delays):
                time.sleep(delays[attempt])
            # On the final attempt we fall through and raise below.

    raise HTTPException(
        status_code=503,
        detail="The AI model is busy right now. Please try again in a moment.",
    )
```

Add `label=` to the two existing call sites: in `suggest` → `label="suggest"`; in `expand` → `label="expand"`.

Append to `.gitignore`:

```
logs/
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/test_api.py -v`
Expected: all 8 PASS (6 existing + 2 new). Note: the existing retry test's `FakeResponse` has no `usage_metadata` → the `getattr` guard logs zeros and nothing breaks; the conftest fixture keeps those writes in tmp.

- [ ] **Step 5: Commit**

```bash
git add usage_log.py tests/conftest.py tests/test_api.py main.py .gitignore
git commit -m "feat: log token usage per Gemini call to logs/usage.jsonl"
```

---

### Task 2: Genre templates (`story_templates.py`, 4 JSON files, `GET /templates`)

**Files:**
- Create: `templates/fantasy.json`, `templates/noir.json`, `templates/scifi.json`, `templates/fairytale.json`
- Create: `story_templates.py`
- Create: `tests/test_templates.py`
- Modify: `main.py` (load templates at startup; `GET /templates`; `get_template_or_404`)
- Test: `tests/test_api.py` (add 1 endpoint test)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `story_templates.load_templates(directory: str = "templates") -> dict[str, dict]` (raises `RuntimeError` on malformed/empty); `main.TEMPLATES: dict[str, dict]`; `main.get_template_or_404(template_id: str) -> dict` (raises `HTTPException(404)`). Template dict keys: `id`, `name`, `description`, `style`, `premise_seeds`. Tasks 3–5 use `TEMPLATES` and `get_template_or_404`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_templates.py`:

```python
import json

import pytest

import story_templates

VALID = {
    "id": "test",
    "name": "Test",
    "description": "d",
    "style": "s",
    "premise_seeds": ["p1", "p2"],
}


def _write(tmp_path, name, data):
    (tmp_path / name).write_text(json.dumps(data), encoding="utf-8")


def test_loads_valid_templates(tmp_path):
    _write(tmp_path, "test.json", VALID)
    templates = story_templates.load_templates(str(tmp_path))
    assert templates["test"]["name"] == "Test"


def test_rejects_missing_keys(tmp_path):
    bad = dict(VALID)
    del bad["style"]
    _write(tmp_path, "bad.json", bad)
    with pytest.raises(RuntimeError, match="missing keys"):
        story_templates.load_templates(str(tmp_path))


def test_rejects_duplicate_ids(tmp_path):
    _write(tmp_path, "a.json", VALID)
    _write(tmp_path, "b.json", VALID)
    with pytest.raises(RuntimeError, match="Duplicate"):
        story_templates.load_templates(str(tmp_path))


def test_rejects_empty_dir(tmp_path):
    with pytest.raises(RuntimeError, match="No templates"):
        story_templates.load_templates(str(tmp_path))


def test_real_templates_dir_loads_all_four():
    templates = story_templates.load_templates()
    assert {"fantasy", "noir", "scifi", "fairytale"} <= set(templates)
```

Add to `tests/test_api.py`:

```python
def test_templates_endpoint_lists_genres_without_style():
    resp = client.get("/templates")
    assert resp.status_code == 200
    templates = resp.json()["templates"]
    ids = {t["id"] for t in templates}
    assert {"fantasy", "noir", "scifi", "fairytale"} <= ids
    for t in templates:
        assert "style" not in t  # prompt material stays server-side
        assert isinstance(t["premise_seeds"], list) and t["premise_seeds"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: `tests/test_templates.py` fails at import (`ModuleNotFoundError: No module named 'story_templates'`); the endpoint test fails with 404.

- [ ] **Step 3: Implement**

Create `story_templates.py`:

```python
"""
Loads genre templates from templates/*.json at startup.

A template is DATA, not code: adding genre #5 = dropping one JSON file
in templates/. Each file needs: id, name, description (user-facing),
style (prompt-injection text — stays server-side), premise_seeds
(ready-made starters the user can pick or speak over).

Malformed files fail LOUDLY at startup — same philosophy as the
missing-API-key check: better a clear crash now than a confusing 500 later.
"""
import json
import os

TEMPLATES_DIR = "templates"
REQUIRED_KEYS = {"id", "name", "description", "style", "premise_seeds"}


def load_templates(directory: str = TEMPLATES_DIR) -> dict[str, dict]:
    templates: dict[str, dict] = {}
    for filename in sorted(os.listdir(directory)):
        if not filename.endswith(".json"):
            continue
        path = os.path.join(directory, filename)
        with open(path, encoding="utf-8") as f:
            data = json.load(f)

        missing = REQUIRED_KEYS - data.keys()
        if missing:
            raise RuntimeError(f"Template {filename} is missing keys: {sorted(missing)}")
        seeds = data["premise_seeds"]
        if (
            not isinstance(seeds, list)
            or not seeds
            or not all(isinstance(s, str) for s in seeds)
        ):
            raise RuntimeError(
                f"Template {filename}: premise_seeds must be a non-empty list of strings"
            )
        if data["id"] in templates:
            raise RuntimeError(f"Duplicate template id: {data['id']}")
        templates[data["id"]] = data

    if not templates:
        raise RuntimeError(f"No templates found in {directory}/")
    return templates
```

Create `templates/fantasy.json`:

```json
{
  "id": "fantasy",
  "name": "Fantasy Adventure",
  "description": "Quests, magic, and wonder in a world where maps still have blank edges.",
  "style": "High-fantasy adventure tone. Vivid sensory detail; a sense of wonder shadowed by real danger. Magic exists but always has a cost. Accessible language, forward momentum, no modern slang or anachronisms.",
  "premise_seeds": [
    "An apprentice mapmaker discovers the kingdom's maps are deliberately wrong about one forest.",
    "A young shepherd finds a fallen star that whispers the names of people about to make terrible choices.",
    "The last dragon egg hatches in a city where magic was outlawed a century ago."
  ]
}
```

Create `templates/noir.json`:

```json
{
  "id": "noir",
  "name": "Mystery / Noir",
  "description": "Rain-slicked streets, unreliable clients, and truths nobody wants dug up.",
  "style": "Hard-boiled noir tone. First-person-adjacent grit, terse sentences, dry wit. Clues matter: reference established facts and keep continuity of suspects, motives, and lies. Atmosphere over gore.",
  "premise_seeds": [
    "A private eye takes one last case: find who is sending the mayor photographs of a crime that officially never happened.",
    "The city's best forger is found dead holding a painting everyone insists was never painted.",
    "A detective's estranged partner reappears with amnesia and a briefcase neither of them can open."
  ]
}
```

Create `templates/scifi.json`:

```json
{
  "id": "scifi",
  "name": "Sci-Fi",
  "description": "Strange futures, thinking machines, and space that doesn't care about you.",
  "style": "Grounded science fiction tone. Ideas taken seriously with concrete sensory consequences; technology has rules and costs. Wonder and unease in equal measure. Avoid technobabble that resolves plot problems by magic.",
  "premise_seeds": [
    "A cargo hauler's navigation AI starts refusing routes it insists are 'already taken by us'.",
    "The first colony ship arrives to find the planet already terraformed and one house standing.",
    "A memory-backup technician finds a recording of their own death, timestamped next week."
  ]
}
```

Create `templates/fairytale.json`:

```json
{
  "id": "fairytale",
  "name": "Fairy Tale (Bedtime)",
  "description": "Gentle, cozy stories with warmth, wonder, and a soft landing — safe for bedtime.",
  "style": "Gentle bedtime fairy-tale tone, safe for young children. Warm, cozy, wondrous. No violence, no death, no real fear — at most mild, quickly-resolved suspense. Kindness is rewarded. Always end each scene on a calm, reassuring note.",
  "premise_seeds": [
    "A small hedgehog inherits a lighthouse that only lights up when someone nearby needs a friend.",
    "The moon loses one of her silver buttons in the deep forest, and the night animals organize a search.",
    "A teapot in the village bakery starts brewing tea that tastes like your happiest memory."
  ]
}
```

In `main.py`: add `import story_templates` next to `import usage_log`, then after the `MODEL = ...` line:

```python
# Genre templates, loaded once at startup. Fail-loud on malformed files.
TEMPLATES = story_templates.load_templates()
```

Add near `parse_scenarios` (helpers section):

```python
def get_template_or_404(template_id: str) -> dict:
    """Look up a genre template; unknown ids get a clean 404 listing valid ones."""
    template = TEMPLATES.get(template_id)
    if template is None:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown template_id '{template_id}'. Valid ids: {sorted(TEMPLATES)}",
        )
    return template
```

Add the endpoint (next to the health check):

```python
@app.get("/templates")
def list_templates():
    """Genre templates the client can offer. 'style' stays server-side (prompt material)."""
    return {
        "templates": [
            {
                "id": t["id"],
                "name": t["name"],
                "description": t["description"],
                "premise_seeds": t["premise_seeds"],
            }
            for t in TEMPLATES.values()
        ]
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (8 prior + 5 loader + 1 endpoint = 14).

- [ ] **Step 5: Commit**

```bash
git add story_templates.py templates/ tests/test_templates.py tests/test_api.py main.py
git commit -m "feat: genre template system (4 genres) + GET /templates"
```

---

### Task 3: Generalize JSON parsing (`parse_model_json`)

**Files:**
- Modify: `main.py` (add `parse_model_json`; reimplement `parse_scenarios` on top of it)
- Test: `tests/test_api.py` (add 2 tests)

**Interfaces:**
- Consumes: existing `parse_scenarios` behavior (strip fences → parse → 502 on garbage).
- Produces: `parse_model_json(raw_text: str) -> dict` — strips ``` fences, parses, requires a JSON object; raises `HTTPException(502)` otherwise. `parse_scenarios(raw_text: str) -> list[str]` keeps its exact signature/behavior. Task 5's `/continue` uses `parse_model_json` directly.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_api.py`:

```python
def test_parse_model_json_strips_fences_and_returns_dict():
    raw = '```json\n{"summary": "s", "scenarios": ["a"]}\n```'
    assert main.parse_model_json(raw) == {"summary": "s", "scenarios": ["a"]}


def test_parse_model_json_rejects_non_object_with_502():
    with pytest.raises(HTTPException) as exc_info:
        main.parse_model_json('["just", "a", "list"]')
    assert exc_info.value.status_code == 502
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_api.py -v`
Expected: both new tests FAIL with `AttributeError: module 'main' has no attribute 'parse_model_json'`.

- [ ] **Step 3: Implement**

In `main.py`, replace the whole `parse_scenarios` function with:

```python
def parse_model_json(raw_text: str) -> dict:
    """
    Models sometimes wrap JSON in ```json fences or add stray text, even when
    told not to. Strip that, parse, and require a JSON object. On anything
    else, raise a clean 502 carrying the raw text (visible while developing;
    in production you'd log it instead).
    """
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        # After stripping backticks a leading "json" word can remain.
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()

    try:
        data = json.loads(cleaned)
        if not isinstance(data, dict):
            raise ValueError("top-level JSON was not an object")
        return data
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(
            status_code=502,
            detail=f"Model returned unparseable output ({e}). Raw: {raw_text[:300]}",
        )


def parse_scenarios(raw_text: str) -> list[str]:
    """Validate the /suggest shape: {"scenarios": [str, str, str]}."""
    data = parse_model_json(raw_text)
    scenarios = data.get("scenarios")
    if not isinstance(scenarios, list) or not all(
        isinstance(s, str) for s in scenarios
    ):
        raise HTTPException(
            status_code=502,
            detail=f"Model JSON missing valid 'scenarios'. Raw: {raw_text[:300]}",
        )
    return scenarios
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (16). The old `/suggest` tests prove the refactor changed nothing observable.

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_api.py
git commit -m "refactor: extract parse_model_json; parse_scenarios reuses it"
```

---

### Task 4: `/suggest` gains optional `template_id`

**Files:**
- Modify: `main.py` (`SuggestRequest`, `suggest` endpoint)
- Test: `tests/test_api.py` (add 2 tests)

**Interfaces:**
- Consumes: `TEMPLATES`, `get_template_or_404` (Task 2); `call_gemini(..., label=)` (Task 1).
- Produces: `POST /suggest` accepting `{"premise": str, "template_id": str | null}`; omitted/null → existing freeform behavior.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_api.py`:

```python
def test_suggest_with_template_injects_style(monkeypatch):
    captured = {}

    def fake_call_gemini(contents, **kwargs):
        captured["contents"] = contents
        return '{"scenarios": ["one", "two", "three"]}'

    monkeypatch.setattr(main, "call_gemini", fake_call_gemini)
    resp = client.post("/suggest", json={"premise": "a heist", "template_id": "noir"})
    assert resp.status_code == 200
    assert main.TEMPLATES["noir"]["style"] in captured["contents"]


def test_suggest_rejects_unknown_template(monkeypatch):
    monkeypatch.setattr(main, "call_gemini", lambda *a, **k: "unused")
    resp = client.post("/suggest", json={"premise": "x", "template_id": "nope"})
    assert resp.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_api.py -v`
Expected: `test_suggest_with_template_injects_style` FAILS (style not in contents — the field is silently ignored today); `test_suggest_rejects_unknown_template` FAILS (200 instead of 404).

- [ ] **Step 3: Implement**

In `main.py`, update the request model:

```python
class SuggestRequest(BaseModel):
    premise: str
    template_id: str | None = None
```

Replace the `suggest` endpoint body:

```python
@app.post("/suggest")
def suggest(req: SuggestRequest):
    """Take a premise (optionally genre-styled), return 3 scenario options."""
    style_block = ""
    if req.template_id is not None:
        template = get_template_or_404(req.template_id)
        style_block = f"\n\nGenre style:\n{template['style']}"

    # Ordering matters for future prompt caching: static SYSTEM_PROMPT first,
    # semi-static genre style second, dynamic premise last.
    text = call_gemini(
        f"{SYSTEM_PROMPT}{style_block}\n\nPremise: {req.premise}",
        max_tokens=300,
        temperature=0.9,
        label="suggest",
    )
    scenarios = parse_scenarios(text)
    return {"scenarios": scenarios}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (18).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_api.py
git commit -m "feat: /suggest accepts optional template_id for genre-styled options"
```

---

### Task 5: `POST /continue` — the two-call story turn

**Files:**
- Modify: `main.py` (`ContinueRequest`, `STORY_PROMPT`, `FOLD_PROMPT`, `continue_story` endpoint)
- Test: `tests/test_api.py` (add 4 tests)

**Interfaces:**
- Consumes: `call_gemini(..., label=)` (Task 1), `get_template_or_404` (Task 2), `parse_model_json` (Task 3).
- Produces: `POST /continue` accepting `{"template_id": str, "summary": str, "chosen_scenario": str}` → `{"scene": str, "summary": str, "scenarios": [str, str, str]}`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_api.py`:

```python
def test_continue_returns_scene_summary_and_options(monkeypatch):
    responses = iter(
        [
            "The scene prose.",
            '{"summary": "updated summary", "scenarios": ["a", "b", "c"]}',
        ]
    )
    labels = []

    def fake_call_gemini(contents, **kwargs):
        labels.append(kwargs["label"])
        return next(responses)

    monkeypatch.setattr(main, "call_gemini", fake_call_gemini)
    resp = client.post(
        "/continue",
        json={
            "template_id": "fantasy",
            "summary": "A knight seeks a dragon.",
            "chosen_scenario": "She enters the cave.",
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["scene"] == "The scene prose."
    assert data["summary"] == "updated summary"
    assert data["scenarios"] == ["a", "b", "c"]
    assert labels == ["scene", "fold"]  # creative call first, scribe second


def test_continue_rejects_unknown_template():
    resp = client.post(
        "/continue",
        json={"template_id": "nope", "summary": "s", "chosen_scenario": "c"},
    )
    assert resp.status_code == 404


def test_continue_rejects_missing_fields():
    resp = client.post("/continue", json={"template_id": "fantasy"})
    assert resp.status_code == 422


def test_continue_502_when_scribe_returns_garbage(monkeypatch):
    responses = iter(["The scene prose.", "not json at all"])
    monkeypatch.setattr(
        main, "call_gemini", lambda contents, **kw: next(responses)
    )
    resp = client.post(
        "/continue",
        json={
            "template_id": "fantasy",
            "summary": "s",
            "chosen_scenario": "c",
        },
    )
    assert resp.status_code == 502
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_api.py -v`
Expected: all four new tests FAIL — the happy-path/502 tests with 404 (route missing), `test_continue_rejects_unknown_template` gets 404-for-the-wrong-reason (route missing, not template check — it will only truly pass once the route exists), `test_continue_rejects_missing_fields` gets 404 instead of 422.

- [ ] **Step 3: Implement**

In `main.py`, add the request model next to `ExpandRequest`:

```python
class ContinueRequest(BaseModel):
    template_id: str
    summary: str
    chosen_scenario: str
```

Add the two prompts next to `EXPAND_PROMPT`:

```python
# Call 1 of /continue — the "storyteller". Writes the actual scene as pure
# prose (NO JSON): mixing creative prose into JSON is where models break
# formatting, so prose stays prose.
STORY_PROMPT = """You are the narrator of an interactive story.
Write the next scene as vivid prose, 2-3 short paragraphs.
Follow the genre style exactly. Continue naturally from the story so far, and
make the scene deliver on the chosen direction. End at a natural pause that
invites the next choice. Respond with ONLY the scene prose — no title, no
labels, no markdown."""

# Call 2 of /continue — the "scribe". Mechanical job: fold the new scene into
# a compact summary and offer the next 3 options. This is the cost-control
# contract: a 50-turn story still sends ~150 words of history, not the
# whole transcript.
FOLD_PROMPT = """You are the scribe for an interactive story. You receive the
story-so-far summary and the newest scene. Do two jobs:
1. Fold the newest scene into an updated summary of the WHOLE story so far.
   Keep it under 150 words. Preserve named characters, key facts, and
   unresolved plot threads.
2. Propose exactly 3 distinct options for what could happen next. Each option
   must be 1-2 sentences and meaningfully different from the others.

Respond with ONLY raw JSON, no markdown, no backticks, in exactly this shape:
{"summary": "updated summary", "scenarios": ["option one", "option two", "option three"]}"""
```

Add the endpoint after `expand`:

```python
@app.post("/continue")
def continue_story(req: ContinueRequest):
    """Advance the story one turn: write the scene, update the summary, offer next options."""
    template = get_template_or_404(req.template_id)

    # Call 1 — storyteller (creative): write the scene as pure prose.
    scene = call_gemini(
        f"{STORY_PROMPT}\n\nGenre style:\n{template['style']}\n\n"
        f"Story so far:\n{req.summary}\n\n"
        f"Chosen direction:\n{req.chosen_scenario}",
        max_tokens=600,
        temperature=0.9,
        label="scene",
    )

    # Call 2 — scribe (mechanical): fold scene into summary + next options.
    raw = call_gemini(
        f"{FOLD_PROMPT}\n\nStory-so-far summary:\n{req.summary}\n\nNewest scene:\n{scene}",
        max_tokens=400,
        temperature=0.7,
        label="fold",
    )
    data = parse_model_json(raw)
    summary = data.get("summary")
    scenarios = data.get("scenarios")
    if not isinstance(summary, str) or not summary.strip():
        raise HTTPException(
            status_code=502,
            detail=f"Model JSON missing valid 'summary'. Raw: {raw[:300]}",
        )
    if not isinstance(scenarios, list) or not all(
        isinstance(s, str) for s in scenarios
    ):
        raise HTTPException(
            status_code=502,
            detail=f"Model JSON missing valid 'scenarios'. Raw: {raw[:300]}",
        )
    return {"scene": scene, "summary": summary, "scenarios": scenarios}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (22).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_api.py
git commit -m "feat: POST /continue advances the story (scene + folded summary + next options)"
```

---

### Task 6: Live verification, docs touch-up, GitHub

**Files:**
- Modify: `CLAUDE.md` (What's BUILT section + git status line)
- No new tests (this task verifies the real system and ships it).

**Interfaces:**
- Consumes: everything above.
- Produces: a public GitHub repo with full history; CLAUDE.md that tells the truth.

- [ ] **Step 1: Full suite green**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (22).

- [ ] **Step 2: Live multi-turn story (real Gemini)**

Write a throwaway script in the session scratchpad (NOT the repo) that uses `TestClient` against real Gemini: `GET /templates` → pick `fantasy` + a premise seed → `POST /suggest` (with `template_id`) → pick option 1 → `POST /continue` → pick option 1 again → `POST /continue` a second time. Print scene lengths, the summary after each turn (confirm it stays compact ~<150 words and retains names), and then print the tail of `logs/usage.jsonl`.

Expected: two scenes of real prose in fantasy style; summary folds both in; `usage.jsonl` shows lines labeled `suggest`, `scene`, `fold` with non-zero token counts. Free-tier 503s may require reruns — that's the retry system working, not a failure.

- [ ] **Step 3: Update CLAUDE.md**

In "What's BUILT and WORKING": add `/continue` (two-call turn: storyteller prose + scribe JSON `{summary, scenarios}`, caps 600/0.9 and 400/0.7, ~150-word summary contract), `GET /templates` (4 genres as `templates/*.json`, loaded fail-loud by `story_templates.py`), `/suggest template_id` support, and usage logging (`usage_log.py` → `logs/usage.jsonl`, one line per call, labels: suggest/expand/scene/fold). Update the test count/coverage sentence. Change "Under git (local only, branch `master`, no remote yet)" to reference the public GitHub remote (Step 4). Remove "GitHub remote" from NEXT STEPS.

- [ ] **Step 4: Create public GitHub repo and push**

```bash
gh auth status
```

If not authenticated: STOP and ask the user to run `gh auth login` in their own terminal (it's interactive), then continue.

```bash
git add CLAUDE.md
git commit -m "docs: record Phase 1 story engine in CLAUDE.md"
gh repo create Storyteller --public --source=. --push
```

Expected: repo created under the user's GitHub account, `master` pushed, remote `origin` configured. Verify with `git remote -v` and by noting the repo URL from gh's output.

- [ ] **Step 5: Confirm**

Run: `git log --oneline -3 && git status`
Expected: clean tree, Phase 1 commits present, branch tracking `origin/master`.

---

## Self-Review

**Spec coverage:** `/continue` two-call design → Task 5. Templates as data + loader + `GET /templates` (no `style` exposed) → Task 2. `/suggest template_id` (optional, 404 on unknown) → Task 4. Cost logging in `call_gemini` with labels → Task 1. Shared JSON parse helper → Task 3. GitHub public + CLAUDE.md truth → Task 6. Out-of-scope items (streaming, persistence, quotas, caching) → correctly absent. ✓

**Placeholder scan:** All steps carry real code, real JSON content, exact commands. The one conditional stop (gh auth) has an explicit action. ✓

**Type consistency:** `call_gemini(contents, max_tokens, temperature, label="unlabeled")` defined in Task 1, used with `label=` in Tasks 4–5. `get_template_or_404(template_id) -> dict` defined Task 2, used Tasks 4–5. `parse_model_json(raw_text) -> dict` defined Task 3, used Task 5. `usage_log.log_usage(label, model, input_tokens, output_tokens)` keyword-called from `call_gemini` matching the Task 1 test's expected dict. ✓

**Known accepted quirks:** `test_continue_rejects_unknown_template` fails "for the wrong reason" before Task 5 exists (404-route vs 404-template) — acceptable because the happy-path test pins the real behavior. Existing retry test's `FakeResponse` lacks `usage_metadata` — handled by the `getattr` guard; conftest keeps stray log writes in tmp.
