# POST /expand + shared Gemini helper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /expand` (refine a chosen scenario with a plain-English instruction) and extract a shared `call_gemini` retry helper that both endpoints use.

**Architecture:** A single `call_gemini(contents, max_tokens, temperature)` helper performs every Gemini request with retry + exponential backoff. `/suggest` is refactored to use it; `/expand` is a new endpoint that uses it and returns `{ original, expanded }`. Tests use FastAPI's `TestClient` with the Gemini layer mocked, so they never hit the network or cost money.

**Tech Stack:** Python 3.14, FastAPI, google-genai SDK, pytest (new), FastAPI `TestClient` (via installed httpx).

## Global Constraints

- Platform: Windows + PowerShell. Activate venv with `venv\Scripts\activate` (NOT the Unix path).
- Run server: `uvicorn main:app --reload`. Manual test UI: `http://127.0.0.1:8000/docs`.
- The Gemini model name lives in exactly ONE constant: `MODEL = "gemini-2.5-flash-lite"`.
- The API key NEVER leaves the backend. It is read from `.env` (`GEMINI_API_KEY`), which is git-ignored.
- Cost levers stay capped: `/suggest` `max_output_tokens=300`, `/expand` `max_output_tokens=600`.
- `/expand` temperature is fixed at `0.8`; `/suggest` stays `0.9`.
- All tests mock the Gemini layer — no real API calls in the test suite.

---

### Task 1: Version control + test harness

Get the project into git and prove pytest + FastAPI `TestClient` run, before adding any logic.

**Files:**
- Modify: `requirements.txt` (add `pytest`)
- Create: `tests/__init__.py` (empty)
- Create: `tests/test_api.py`

**Interfaces:**
- Consumes: existing `main.app` (the FastAPI instance), existing `GET /`.
- Produces: a working `pytest` setup and `tests/test_api.py` importing `main` and a module-level `TestClient(main.app)` that later tasks reuse.

- [ ] **Step 1: Initialize git and make the first commit**

The existing `.gitignore` already ignores `.env`, `venv/`, `__pycache__`. Confirm the working tree, init, and commit the current code.

```bash
git init
git add .gitignore main.py requirements.txt docs/
git commit -m "chore: initial commit of existing Storyteller backend + expand spec/plan"
```

Expected: a commit is created. `.env` and `venv/` must NOT appear (they're git-ignored) — verify with `git status` showing them untracked/ignored.

- [ ] **Step 2: Add pytest to requirements and install it**

Edit `requirements.txt` to:

```
fastapi
uvicorn
python-dotenv
google-genai
pytest
```

Then (venv activated):

Run: `pip install -r requirements.txt`
Expected: pytest installs successfully.

- [ ] **Step 3: Write the failing smoke test**

Create `tests/__init__.py` (empty file).

Create `tests/test_api.py`:

```python
from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


def test_health_check():
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_api.py -v`
Expected: `test_health_check PASSED`. (It passes immediately because `GET /` already exists — this step proves the harness itself works.)

Note: importing `main` requires `GEMINI_API_KEY` to be set; your `.env` provides it via `load_dotenv()`. No real Gemini call happens here.

- [ ] **Step 5: Commit**

```bash
git add requirements.txt tests/
git commit -m "test: add pytest harness and health-check smoke test"
```

---

### Task 2: Shared `call_gemini` helper + refactor `/suggest`

Extract the Gemini call into one helper with retry/backoff, then point `/suggest` at it.

**Files:**
- Modify: `main.py` (add `import time`, add `from google.genai import errors`, add `call_gemini`, refactor `suggest`)
- Modify: `tests/test_api.py` (add three tests)

**Interfaces:**
- Consumes: `main.client`, `main.MODEL`, `parse_scenarios`, `SYSTEM_PROMPT`.
- Produces: `call_gemini(contents: str, max_tokens: int, temperature: float) -> str` — returns the model's text; raises `HTTPException(status_code=503)` after exhausting retries. Task 3 relies on this exact signature.

- [ ] **Step 1: Write the failing tests**

Add to the top imports of `tests/test_api.py`:

```python
import pytest
from fastapi import HTTPException
from google.genai import errors
```

Add these tests to `tests/test_api.py`:

```python
def test_call_gemini_retries_then_succeeds(monkeypatch):
    calls = {"n": 0}

    class FakeResponse:
        text = "hello world"

    def fake_generate(**kwargs):
        calls["n"] += 1
        if calls["n"] < 3:
            raise errors.ServerError(503, {"error": {"message": "overloaded"}})
        return FakeResponse()

    monkeypatch.setattr(main.client.models, "generate_content", fake_generate)
    monkeypatch.setattr("time.sleep", lambda *a: None)  # don't actually wait

    result = main.call_gemini("prompt", max_tokens=100, temperature=0.5)
    assert result == "hello world"
    assert calls["n"] == 3


def test_call_gemini_raises_503_after_exhausting_retries(monkeypatch):
    def always_fail(**kwargs):
        raise errors.ServerError(503, {"error": {"message": "overloaded"}})

    monkeypatch.setattr(main.client.models, "generate_content", always_fail)
    monkeypatch.setattr("time.sleep", lambda *a: None)

    with pytest.raises(HTTPException) as exc_info:
        main.call_gemini("prompt", max_tokens=100, temperature=0.5)
    assert exc_info.value.status_code == 503


def test_suggest_returns_three_scenarios(monkeypatch):
    fake_json = '{"scenarios": ["one", "two", "three"]}'
    monkeypatch.setattr(main, "call_gemini", lambda *a, **k: fake_json)

    resp = client.post("/suggest", json={"premise": "a lost dog finds a door"})
    assert resp.status_code == 200
    assert resp.json()["scenarios"] == ["one", "two", "three"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_api.py -v`
Expected: the two `call_gemini` tests FAIL with `AttributeError: module 'main' has no attribute 'call_gemini'`. (`test_suggest_returns_three_scenarios` may also fail until the refactor in Step 3.)

- [ ] **Step 3: Implement `call_gemini` and refactor `suggest`**

In `main.py`, add to the imports near the top (after `import json`):

```python
import time

from google.genai import errors
```

Add the helper after the `parse_scenarios` function (before the endpoints):

```python
def call_gemini(contents: str, max_tokens: int, temperature: float) -> str:
    """
    Make ONE Gemini request, retrying transient server errors (5xx) with
    exponential backoff (1s, 2s, 4s). Returns the model's text.

    If the model is still unavailable after all retries, raises a clean
    503 (HTTPException) instead of leaking a 500/stack trace. Both /suggest
    and /expand call this, so retry logic lives in exactly one place.
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

Replace the body of the `suggest` endpoint so it calls the helper:

```python
@app.post("/suggest")
def suggest(req: SuggestRequest):
    """Take a premise, return 3 scenario options."""
    text = call_gemini(
        f"{SYSTEM_PROMPT}\n\nPremise: {req.premise}",
        max_tokens=300,
        temperature=0.9,
    )
    scenarios = parse_scenarios(text)
    return {"scenarios": scenarios}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/test_api.py -v`
Expected: all tests PASS (health check, both `call_gemini` tests, and `test_suggest_returns_three_scenarios`).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_api.py
git commit -m "feat: extract call_gemini retry helper and refactor /suggest to use it"
```

---

### Task 3: `POST /expand` endpoint

Add the new endpoint that returns `{ original, expanded }`.

**Files:**
- Modify: `main.py` (add `ExpandRequest`, `EXPAND_PROMPT`, `expand` endpoint)
- Modify: `tests/test_api.py` (add two tests)

**Interfaces:**
- Consumes: `call_gemini(contents, max_tokens, temperature) -> str` from Task 2.
- Produces: `POST /expand` accepting `{ "scenario": str, "instruction": str }`, returning `{ "original": str, "expanded": str }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_api.py`:

```python
def test_expand_returns_original_and_expanded(monkeypatch):
    monkeypatch.setattr(
        main, "call_gemini", lambda *a, **k: "A darker version of the scene."
    )

    resp = client.post(
        "/expand",
        json={"scenario": "A bright meadow at noon.", "instruction": "make it darker"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["original"] == "A bright meadow at noon."
    assert data["expanded"] == "A darker version of the scene."
    assert len(data["expanded"]) > 0


def test_expand_rejects_missing_instruction():
    resp = client.post("/expand", json={"scenario": "only the scenario"})
    assert resp.status_code == 422  # Pydantic validation rejects missing field
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_api.py -v`
Expected: `test_expand_returns_original_and_expanded` FAILS with 404 (route not defined yet). `test_expand_rejects_missing_instruction` may also fail (404 instead of 422).

- [ ] **Step 3: Implement the endpoint**

In `main.py`, add a request model next to `SuggestRequest`:

```python
class ExpandRequest(BaseModel):
    scenario: str
    instruction: str
```

Add the static prompt near `SYSTEM_PROMPT`:

```python
# Static instruction for /expand. Front-loaded and identical every call, same
# caching-ready shape as SYSTEM_PROMPT. Unlike /suggest, the model returns plain
# prose (one rewritten scenario), so there is NO JSON to parse.
EXPAND_PROMPT = """You are a creative writing assistant for a story-building app.
You will be given a single story scenario and an instruction for changing it.
Rewrite the scenario to follow the instruction. Keep it vivid and self-contained.
Respond with ONLY the rewritten scenario as plain prose — no preamble, no labels,
no markdown, no quotes."""
```

Add the endpoint (after `suggest`):

```python
@app.post("/expand")
def expand(req: ExpandRequest):
    """Take a chosen scenario + an instruction, return the original alongside a rewrite."""
    expanded = call_gemini(
        f"{EXPAND_PROMPT}\n\nScenario: {req.scenario}\n\nInstruction: {req.instruction}",
        max_tokens=600,
        temperature=0.8,
    )
    return {"original": req.scenario, "expanded": expanded}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/test_api.py -v`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_api.py
git commit -m "feat: add POST /expand endpoint returning original + expanded"
```

- [ ] **Step 6: Manual end-to-end verification**

Run: `uvicorn main:app --reload`
In the browser, open `http://127.0.0.1:8000/docs`:
1. `POST /expand` with `{"scenario": "A bright meadow at noon.", "instruction": "make it darker"}` → expect 200 and a visibly darker rewrite in `expanded`, with `original` echoed back.
2. `POST /suggest` with `{"premise": "a lost dog finds a door"}` → expect 200 and 3 scenarios (regression check that the refactor didn't break it).

---

## Self-Review

**Spec coverage:**
- Request/response shape `{original, expanded}` → Task 3. ✓
- Shared `call_gemini` with retry/backoff + refactor `/suggest` → Task 2. ✓
- `max_output_tokens=600`, `temperature=0.8`, no JSON parsing → Task 3. ✓
- Static `EXPAND_PROMPT` front-loaded → Task 3. ✓
- Verification (TDD tests + live `/docs` + `/suggest` regression) → Tasks 2 & 3. ✓
- Out-of-scope items (no story context, no auth/quotas, no creativity dial) → not implemented, as intended. ✓
- Follow-up: git not initialized → addressed in Task 1. ✓

**Placeholder scan:** No TBD/TODO/"add error handling" placeholders; all steps contain real code and exact commands. ✓

**Type consistency:** `call_gemini(contents, max_tokens, temperature) -> str` defined in Task 2 and consumed identically in Task 3. `ExpandRequest` fields (`scenario`, `instruction`) match the endpoint and tests. ✓

**Known limitation (acceptable for v1):** Importing `main` in tests requires `GEMINI_API_KEY` in `.env`. The suite mocks the Gemini layer so no real calls occur, but a machine with no `.env` can't import `main`. Making the key lazy is a future improvement, out of scope here.
