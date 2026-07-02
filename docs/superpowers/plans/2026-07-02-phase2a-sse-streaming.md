# Phase 2 Slice A: SSE Streaming + Mock Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /continue/stream` — a Server-Sent Events endpoint that streams the scene word-by-word, plus a zero-cost mock mode the Expo app will be built against, plus CORS for the browser dev loop.

**Architecture:** A new `call_gemini_stream` generator (sibling of `call_gemini`) yields text chunks from Gemini's streaming API, with retry/429 handling applied only BEFORE the first chunk and usage logged at stream end. The endpoint wraps it in an SSE event protocol (`scene_token*` → `turn_complete` | `error`); after the scene streams, the existing non-streaming scribe call produces `{summary, scenarios}`. Mock mode streams a canned scene, gated by the `DEV_MOCK_ENABLED` env var. The existing `/continue` stays untouched as the `/docs`-testable reference.

**Tech Stack:** FastAPI `StreamingResponse` (sync generators), google-genai `generate_content_stream` (verified in installed SDK: same kwargs as `generate_content`, returns `Iterator[GenerateContentResponse]`, lazy — the HTTP request fires on first `next()`), pytest + `TestClient` (reads the full SSE body via `resp.text`; tests parse it).

## Global Constraints

- SSE event contract, verbatim from the spec (client builds against this):
  - `event: scene_token` `data: {"t": "<text chunk>"}` (many)
  - `event: turn_complete` `data: {"summary": "...", "scenarios": ["...","...","..."]}`
  - `event: error` `data: {"status": <int>, "detail": "..."}` (terminal)
- Cost caps unchanged: scene call `max_tokens=600, temperature=0.9, label="scene"`; scribe `max_tokens=400, temperature=0.7, label="fold"`.
- Retry/backoff (1s, 2s, 4s) and 429-no-retry apply only BEFORE the first streamed chunk. After bytes flow, failures become a terminal `error` frame; text already sent is never retracted.
- Usage logging at stream end (Gemini reports `usage_metadata` on the final chunk); a client disconnect mid-stream must still log what was seen (generator `finally`).
- Mock mode: `?mock=true` works only when env var `DEV_MOCK_ENABLED=1`; otherwise 403. Mock makes ZERO Gemini calls.
- Unknown `template_id` → plain HTTP 404 (raised before streaming starts — no bytes sent yet).
- All tests mock the Gemini layer. Extend the conftest tripwire to also cover `generate_content_stream`.
- CORS: wide-open (`allow_origins=["*"]`) is a deliberate DEV-ONLY stance; must be revisited before Phase 6 public exposure (say so in a comment).
- Windows; run tests: `venv/Scripts/python.exe -m pytest tests/ -v` from repo root. Commits: conventional style + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Current suite: 29 tests passing. `main.py` already has: `call_gemini(contents, max_tokens, temperature, label="unlabeled")` (429→HTTPException 429; empty text→502; ServerError retry→503; logs usage guarded by try/except-with-stderr-warning), `ContinueRequest`, `STORY_PROMPT`, `FOLD_PROMPT`, `parse_model_json`, `get_template_or_404`, `TEMPLATES`.

---

### Task 1: `call_gemini_stream` generator + tripwire extension

**Files:**
- Modify: `main.py` (add `call_gemini_stream` after `call_gemini`)
- Modify: `tests/conftest.py` (tripwire also stubs `generate_content_stream`)
- Test: `tests/test_api.py` (add 5 tests)

**Interfaces:**
- Consumes: `client`, `MODEL`, `errors`, `usage_log`, `time`, `sys`, `HTTPException` — all already imported in `main.py`.
- Produces: `call_gemini_stream(contents: str, max_tokens: int, temperature: float, label: str = "unlabeled")` — a GENERATOR yielding `str` chunks. Raises `HTTPException` 429/503 (only reachable on first iteration, since generators are lazy) and 502 if the stream ends having yielded no text. Task 3's endpoint consumes it.

- [ ] **Step 1: Write the failing tests**

In `tests/conftest.py`, extend the existing tripwire fixture — add a second `monkeypatch.setattr` beside the `generate_content` one, stubbing `main.client.models.generate_content_stream` the same way:

```python
    monkeypatch.setattr(
        main.client.models,
        "generate_content_stream",
        lambda **k: (_ for _ in ()).throw(
            AssertionError(
                "Test attempted a real Gemini streaming call - mock call_gemini_stream or generate_content_stream"
            )
        ),
    )
```

(Adapt to the fixture's existing shape — if it stubs with a named function, add a sibling named function. The behavior that matters: any un-mocked streaming call fails loudly.)

Add to `tests/test_api.py`:

```python
class FakeChunk:
    def __init__(self, text=None, usage=None):
        self.text = text
        self.usage_metadata = usage


class FakeStreamUsage:
    prompt_token_count = 50
    candidates_token_count = 70


def test_call_gemini_stream_yields_chunks_and_logs_usage(monkeypatch):
    logged = []
    monkeypatch.setattr(main.usage_log, "log_usage", lambda **kw: logged.append(kw))
    chunks = [
        FakeChunk(text="Once "),
        FakeChunk(text="upon a time."),
        FakeChunk(text=None, usage=FakeStreamUsage()),  # final chunk: no text, has usage
    ]
    monkeypatch.setattr(
        main.client.models, "generate_content_stream", lambda **k: iter(chunks)
    )

    out = list(main.call_gemini_stream("p", max_tokens=600, temperature=0.9, label="scene"))
    assert out == ["Once ", "upon a time."]
    assert logged == [
        {"label": "scene", "model": main.MODEL, "input_tokens": 50, "output_tokens": 70}
    ]


def test_call_gemini_stream_retries_server_error_before_first_chunk(monkeypatch):
    calls = {"n": 0}

    def flaky(**kwargs):
        calls["n"] += 1
        if calls["n"] < 3:
            raise errors.ServerError(503, {"error": {"message": "overloaded"}})
        return iter([FakeChunk(text="ok")])

    monkeypatch.setattr(main.client.models, "generate_content_stream", flaky)
    monkeypatch.setattr("time.sleep", lambda *a: None)

    assert list(main.call_gemini_stream("p", max_tokens=10, temperature=0.5)) == ["ok"]
    assert calls["n"] == 3


def test_call_gemini_stream_429_no_retry(monkeypatch):
    calls = {"n": 0}

    def quota(**kwargs):
        calls["n"] += 1
        raise errors.ClientError(429, {"error": {"message": "quota exceeded"}})

    monkeypatch.setattr(main.client.models, "generate_content_stream", quota)

    with pytest.raises(HTTPException) as exc_info:
        list(main.call_gemini_stream("p", max_tokens=10, temperature=0.5))
    assert exc_info.value.status_code == 429
    assert calls["n"] == 1


def test_call_gemini_stream_empty_stream_502(monkeypatch):
    monkeypatch.setattr(
        main.client.models,
        "generate_content_stream",
        lambda **k: iter([FakeChunk(text=None)]),
    )
    with pytest.raises(HTTPException) as exc_info:
        list(main.call_gemini_stream("p", max_tokens=10, temperature=0.5))
    assert exc_info.value.status_code == 502


def test_call_gemini_stream_logs_on_early_close(monkeypatch):
    logged = []
    monkeypatch.setattr(main.usage_log, "log_usage", lambda **kw: logged.append(kw))
    chunks = [FakeChunk(text="Once "), FakeChunk(text="upon"), FakeChunk(text=" a time")]
    monkeypatch.setattr(
        main.client.models, "generate_content_stream", lambda **k: iter(chunks)
    )

    gen = main.call_gemini_stream("p", max_tokens=10, temperature=0.5, label="scene")
    assert next(gen) == "Once "
    gen.close()  # simulates client disconnect mid-stream
    assert len(logged) == 1  # best-effort log still happened (zero counts: no usage seen)
    assert logged[0]["label"] == "scene"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_api.py -v`
Expected: the 5 new tests FAIL with `AttributeError: module 'main' has no attribute 'call_gemini_stream'`. All 29 existing tests still pass.

- [ ] **Step 3: Implement**

In `main.py`, add directly after the `call_gemini` function:

```python
def call_gemini_stream(
    contents: str, max_tokens: int, temperature: float, label: str = "unlabeled"
):
    """
    Streaming sibling of call_gemini: yields the model's text chunk by chunk
    as it is generated (feeds the client's word-by-word animation).

    Error policy changes at the first byte: retry/backoff (5xx) and the clean
    429 apply only BEFORE the first chunk is yielded. Once text has gone out,
    failures must be handled by the caller (the SSE endpoint turns them into
    a terminal error frame) — you can't un-send half a scene.

    Usage is logged when the stream finishes; the finally block makes that
    best-effort even if the client disconnects mid-stream (whatever usage
    was seen by then, else zeros).

    NOTE: this is a generator — nothing runs until the first iteration, so
    the 429/503 HTTPExceptions surface on first next(), not at call time.
    """
    delays = [1, 2, 4]
    stream = None
    first_chunk = None
    for attempt in range(len(delays) + 1):
        try:
            stream = client.models.generate_content_stream(
                model=MODEL,
                contents=contents,
                config={
                    "max_output_tokens": max_tokens,
                    "temperature": temperature,
                },
            )
            # The SDK stream is lazy: the request actually fires here.
            first_chunk = next(stream, None)
            break
        except errors.ClientError as e:
            if getattr(e, "code", None) == 429:
                raise HTTPException(
                    status_code=429,
                    detail="Daily AI quota reached. Please try again later.",
                )
            raise
        except errors.ServerError:
            if attempt < len(delays):
                time.sleep(delays[attempt])
            else:
                raise HTTPException(
                    status_code=503,
                    detail="The AI model is busy right now. Please try again in a moment.",
                )

    yielded_any = False
    last_usage = None
    try:
        chunk = first_chunk
        while chunk is not None:
            usage = getattr(chunk, "usage_metadata", None)
            if usage is not None:
                last_usage = usage
            if chunk.text:
                yielded_any = True
                yield chunk.text
            chunk = next(stream, None)
    finally:
        try:
            usage_log.log_usage(
                label=label,
                model=MODEL,
                input_tokens=(last_usage.prompt_token_count or 0) if last_usage else 0,
                output_tokens=(last_usage.candidates_token_count or 0) if last_usage else 0,
            )
        except Exception as e:
            # The cost meter must never break the stream it measures.
            print(f"WARNING: usage logging failed: {e}", file=sys.stderr)

    if not yielded_any:
        raise HTTPException(
            status_code=502,
            detail="Model returned an empty response. Try rephrasing or try again.",
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (34).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_api.py tests/conftest.py
git commit -m "feat: call_gemini_stream generator (retry before first byte, usage at stream end)"
```

---

### Task 2: SSE framing, CORS, and the mock stream

**Files:**
- Modify: `main.py` (CORS middleware; `sse_event` helper; mock constants + generator; `/continue/stream` endpoint with mock path, non-mock returns 501 until Task 3)
- Modify: `.env.example` (document `DEV_MOCK_ENABLED`)
- Test: `tests/test_api.py` (add SSE parse helper + 4 tests)

**Interfaces:**
- Consumes: `get_template_or_404`, `ContinueRequest` (existing).
- Produces: `sse_event(event: str, data: dict) -> str`; `MOCK_SCENE: str`, `MOCK_TURN: dict`; route `POST /continue/stream` (body `ContinueRequest`, query `mock: bool = False`). Task 3 replaces only the non-mock branch. Tests produce `parse_sse(body: str) -> list[dict]` reused in Task 3.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_api.py`:

```python
def parse_sse(body: str) -> list[dict]:
    """Parse an SSE body into [{'event': ..., 'data': <parsed json>}, ...]."""
    events = []
    for block in body.strip().split("\n\n"):
        ev = {"event": None, "data": None}
        for line in block.split("\n"):
            if line.startswith("event: "):
                ev["event"] = line[len("event: "):]
            elif line.startswith("data: "):
                ev["data"] = jsonlib.loads(line[len("data: "):])
        events.append(ev)
    return events


CONTINUE_BODY = {
    "template_id": "fantasy",
    "summary": "A knight seeks a dragon.",
    "chosen_scenario": "She enters the cave.",
}


def test_mock_stream_requires_env_gate(monkeypatch):
    monkeypatch.delenv("DEV_MOCK_ENABLED", raising=False)
    resp = client.post("/continue/stream?mock=true", json=CONTINUE_BODY)
    assert resp.status_code == 403


def test_mock_stream_streams_canned_scene(monkeypatch):
    monkeypatch.setenv("DEV_MOCK_ENABLED", "1")
    monkeypatch.setattr("time.sleep", lambda *a: None)  # no real pacing in tests

    resp = client.post("/continue/stream?mock=true", json=CONTINUE_BODY)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    events = parse_sse(resp.text)
    assert events[0]["event"] == "scene_token"
    assert events[-1]["event"] == "turn_complete"
    # Reassembling every token yields exactly the canned scene.
    scene = "".join(e["data"]["t"] for e in events if e["event"] == "scene_token")
    assert scene == main.MOCK_SCENE
    assert events[-1]["data"]["summary"] == main.MOCK_TURN["summary"]
    assert len(events[-1]["data"]["scenarios"]) == 3


def test_mock_stream_unknown_template_404(monkeypatch):
    monkeypatch.setenv("DEV_MOCK_ENABLED", "1")
    resp = client.post(
        "/continue/stream?mock=true",
        json={"template_id": "nope", "summary": "s", "chosen_scenario": "c"},
    )
    assert resp.status_code == 404


def test_cors_headers_present():
    resp = client.get("/templates", headers={"Origin": "http://localhost:8081"})
    assert resp.headers.get("access-control-allow-origin") in ("*", "http://localhost:8081")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_api.py -v`
Expected: the 3 stream tests FAIL with 404 (route missing); the CORS test FAILS (no header). 34 existing tests still pass.

- [ ] **Step 3: Implement**

In `main.py`, add to imports: `from fastapi.responses import StreamingResponse` and `from fastapi.middleware.cors import CORSMiddleware`.

Directly after `app = FastAPI(title="Storyteller API")`:

```python
# CORS lets the browser-based Expo dev loop (a different origin) call this API.
# Wide-open is a DEV-ONLY stance — must be locked down before any public
# exposure (roadmap Phase 6).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Add near the other helpers:

```python
def sse_event(event: str, data: dict) -> str:
    """One Server-Sent Events frame: 'event' names it, 'data' is one JSON line."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"
```

Add near the prompts:

```python
# --- Mock mode -------------------------------------------------------------
# Streams a canned scene word-by-word with realistic pacing so the client's
# animation can be built with ZERO Gemini calls (free, offline, deterministic
# — it doubles as a test fixture). Gated by DEV_MOCK_ENABLED so it can never
# exist in a production deploy.
MOCK_SCENE = (
    "The lantern guttered as Mira pressed her palm against the cold iron door. "
    "Somewhere beyond it, water dripped in slow, deliberate beats, like something "
    "counting.\n\nShe had been warned about the lower stacks — every apprentice "
    "was — but the map in her satchel showed a corridor that should not exist, "
    "and Mira had never once managed to leave a wrong map uncorrected."
)

MOCK_TURN = {
    "summary": (
        "Apprentice mapmaker Mira, investigating a corridor missing from the "
        "kingdom's maps, stands before a cold iron door in the forbidden lower "
        "stacks, drawn by her compulsion to correct wrong maps."
    ),
    "scenarios": [
        "Mira forces the iron door and finds a room where maps draw themselves.",
        "A voice behind the door asks her, by name, to slide the map underneath.",
        "The dripping stops — and footsteps begin, approaching from the corridor that shouldn't exist.",
    ],
}


def _stream_mock():
    """Yield the canned scene word-by-word, then the canned turn_complete."""
    words = MOCK_SCENE.split(" ")
    for i, word in enumerate(words):
        token = word if i == len(words) - 1 else word + " "
        yield sse_event("scene_token", {"t": token})
        time.sleep(0.03)  # realistic pacing for animation work; patched in tests
    yield sse_event("turn_complete", MOCK_TURN)
```

Add the endpoint after `continue_story`:

```python
@app.post("/continue/stream")
def continue_story_stream(req: ContinueRequest, mock: bool = False):
    """Streaming twin of /continue: scene tokens as SSE, then the folded turn."""
    # Validation happens BEFORE streaming starts, so it's a normal HTTP error.
    get_template_or_404(req.template_id)

    if mock:
        if os.environ.get("DEV_MOCK_ENABLED") != "1":
            raise HTTPException(
                status_code=403,
                detail="Mock mode is disabled. Set DEV_MOCK_ENABLED=1 in .env for development.",
            )
        return StreamingResponse(_stream_mock(), media_type="text/event-stream")

    raise HTTPException(status_code=501, detail="Real streaming lands in the next task.")
    # ^ deliberate one-task placeholder: Task 3 replaces this line with the
    #   real streaming path. Kept explicit so the increment is honest.
```

Append to `.env.example`:

```
# Set to 1 during development to enable /continue/stream?mock=true
# (streams a canned scene with zero Gemini calls). Leave unset in production.
DEV_MOCK_ENABLED=1
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (38).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_api.py .env.example
git commit -m "feat: /continue/stream mock mode (SSE, env-gated) + CORS for browser dev"
```

---

### Task 3: The real streaming path + error frames + shared validation

**Files:**
- Modify: `main.py` (add `validate_turn_payload`; refactor `continue_story` to use it; add `_stream_turn`; replace Task 2's 501 line)
- Test: `tests/test_api.py` (add 4 tests)

**Interfaces:**
- Consumes: `call_gemini_stream` (Task 1), `sse_event` (Task 2), `call_gemini`, `parse_model_json`, `STORY_PROMPT`, `FOLD_PROMPT` (existing).
- Produces: `validate_turn_payload(raw_text: str) -> tuple[str, list[str]]` (returns `(summary, scenarios)`, raises `HTTPException(502)`) — now the ONE place the scribe's output shape is checked, used by both `/continue` and `/continue/stream`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_api.py`:

```python
def test_stream_real_path_emits_tokens_then_turn_complete(monkeypatch):
    def fake_stream(contents, **kwargs):
        assert kwargs["label"] == "scene"
        yield "Once "
        yield "upon a time."

    monkeypatch.setattr(main, "call_gemini_stream", fake_stream)
    monkeypatch.setattr(
        main,
        "call_gemini",
        lambda contents, **kw: '{"summary": "updated", "scenarios": ["a", "b", "c"]}',
    )

    resp = client.post("/continue/stream", json=CONTINUE_BODY)
    assert resp.status_code == 200
    events = parse_sse(resp.text)
    assert [e["event"] for e in events] == ["scene_token", "scene_token", "turn_complete"]
    assert "".join(e["data"]["t"] for e in events[:2]) == "Once upon a time."
    assert events[-1]["data"] == {"summary": "updated", "scenarios": ["a", "b", "c"]}


def test_stream_scribe_garbage_becomes_error_frame(monkeypatch):
    monkeypatch.setattr(main, "call_gemini_stream", lambda c, **kw: iter(["scene text"]))
    monkeypatch.setattr(main, "call_gemini", lambda c, **kw: "not json at all")

    resp = client.post("/continue/stream", json=CONTINUE_BODY)
    assert resp.status_code == 200  # stream already started; error travels IN the stream
    events = parse_sse(resp.text)
    assert events[0]["event"] == "scene_token"
    assert events[-1]["event"] == "error"
    assert events[-1]["data"]["status"] == 502


def test_stream_midstream_failure_keeps_sent_tokens(monkeypatch):
    def dies_after_one(contents, **kwargs):
        yield "First words "
        raise HTTPException(status_code=503, detail="model went away")

    monkeypatch.setattr(main, "call_gemini_stream", dies_after_one)

    resp = client.post("/continue/stream", json=CONTINUE_BODY)
    events = parse_sse(resp.text)
    assert events[0] == {"event": "scene_token", "data": {"t": "First words "}}
    assert events[-1]["event"] == "error"
    assert events[-1]["data"]["status"] == 503


def test_continue_still_validates_after_refactor(monkeypatch):
    responses = iter(["scene", '{"summary": "", "scenarios": ["a", "b", "c"]}'])
    monkeypatch.setattr(main, "call_gemini", lambda c, **kw: next(responses))

    resp = client.post("/continue", json=CONTINUE_BODY)
    assert resp.status_code == 502  # empty summary still rejected via shared helper
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_api.py -v`
Expected: the 3 stream tests FAIL (non-mock path returns 501, so status 501 ≠ 200); the refactor test PASSES already (it pins current behavior — it's the regression net for the refactor). All prior tests still pass.

- [ ] **Step 3: Implement**

In `main.py`, add after `parse_scenarios`:

```python
def validate_turn_payload(raw_text: str) -> tuple[str, list[str]]:
    """
    Validate the scribe's JSON: {"summary": non-empty str, "scenarios": [str, ...]}.
    The ONE place this shape is checked — used by /continue and /continue/stream.
    """
    data = parse_model_json(raw_text)
    summary = data.get("summary")
    scenarios = data.get("scenarios")
    if not isinstance(summary, str) or not summary.strip():
        raise HTTPException(
            status_code=502,
            detail=f"Model JSON missing valid 'summary'. Raw: {raw_text[:300]}",
        )
    if not isinstance(scenarios, list) or not all(
        isinstance(s, str) for s in scenarios
    ):
        raise HTTPException(
            status_code=502,
            detail=f"Model JSON missing valid 'scenarios'. Raw: {raw_text[:300]}",
        )
    return summary, scenarios
```

Refactor `continue_story`'s validation block: replace everything from `data = parse_model_json(raw)` through the second `raise HTTPException(...)` with:

```python
    summary, scenarios = validate_turn_payload(raw)
```

(The `return {"scene": scene, "summary": summary, "scenarios": scenarios}` line stays.)

Add `_stream_turn` before the `/continue/stream` endpoint:

```python
def _stream_turn(req: ContinueRequest, template: dict):
    """
    The real streaming turn. Any failure after streaming has begun becomes a
    terminal SSE error frame — the client keeps every token already shown.
    """
    try:
        scene_parts: list[str] = []
        token_iter = call_gemini_stream(
            f"{STORY_PROMPT}\n\nGenre style:\n{template['style']}\n\n"
            f"Story so far:\n{req.summary}\n\n"
            f"Chosen direction:\n{req.chosen_scenario}",
            max_tokens=600,
            temperature=0.9,
            label="scene",
        )
        for token in token_iter:
            scene_parts.append(token)
            yield sse_event("scene_token", {"t": token})

        scene = "".join(scene_parts)
        raw = call_gemini(
            f"{FOLD_PROMPT}\n\nStory-so-far summary:\n{req.summary}\n\nNewest scene:\n{scene}",
            max_tokens=400,
            temperature=0.7,
            label="fold",
        )
        summary, scenarios = validate_turn_payload(raw)
        yield sse_event("turn_complete", {"summary": summary, "scenarios": scenarios})
    except HTTPException as e:
        yield sse_event("error", {"status": e.status_code, "detail": e.detail})
    except Exception as e:
        yield sse_event("error", {"status": 500, "detail": f"Unexpected error: {e}"})
```

In `continue_story_stream`, replace the 501 `raise` (and its explanatory comment) with:

```python
    return StreamingResponse(_stream_turn(req, get_template_or_404(req.template_id)), media_type="text/event-stream")
```

(Note the endpoint already called `get_template_or_404` once for validation; passing the template again is a second lookup — instead, capture it: change the endpoint's first line to `template = get_template_or_404(req.template_id)` and use `_stream_turn(req, template)`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (42).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_api.py
git commit -m "feat: real /continue/stream path with SSE error frames; shared validate_turn_payload"
```

---

### Task 4: Live verification, docs, ship

**Files:**
- Modify: `CLAUDE.md` ("What's BUILT" + test count)
- No repo test changes.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full suite green**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (42).

- [ ] **Step 2: Live mock verification (zero quota)**

Add `DEV_MOCK_ENABLED=1` to the real `.env` (it's git-ignored). Then with a scratchpad script (session scratchpad, NOT the repo) using `TestClient` — or by running uvicorn and curling — hit `POST /continue/stream?mock=true` with a fantasy body and verify: 200, `text/event-stream`, many `scene_token` frames reassembling to `MOCK_SCENE`, one final `turn_complete`. This costs nothing and can run all day.

- [ ] **Step 3: Live real-Gemini streamed turn (2 quota requests — may be quota-blocked)**

Attempt ONE real `POST /continue/stream` (no mock). Expected: `scene_token` frames arriving incrementally, then `turn_complete`, and `usage.jsonl` gaining `scene` + `fold` lines. **If the daily free-tier quota is exhausted** (likely — Phase 1's live run spent most of today's 20): the expected result is a clean `error` frame with status 429 — that outcome VERIFIES the 429-inside-stream path and counts as today's live check; note in the report that the happy-path live run should be repeated on a fresh-quota day before slice B's end-to-end test.

- [ ] **Step 4: Update CLAUDE.md and ship**

In "What's BUILT and WORKING": add `POST /continue/stream` (SSE twin of /continue: `scene_token*` → `turn_complete` | terminal `error` frame; retry only before first byte; mock mode `?mock=true` gated by `DEV_MOCK_ENABLED=1`, zero Gemini calls, the client-animation fixture), `call_gemini_stream` (streaming sibling, usage logged at stream end), CORS (dev-only wide-open, lock down before Phase 6), and the new test count (42). Then:

```bash
git add CLAUDE.md
git commit -m "docs: record slice A streaming endpoint in CLAUDE.md"
git push
```

- [ ] **Step 5: Confirm**

Run: `git status -sb`
Expected: clean, up to date with origin/master.

---

## Self-Review

**Spec coverage:** SSE contract (3 event types, exact shapes) → Tasks 2–3. Streaming scene call via `generate_content_stream` w/ retry-before-first-byte → Task 1. Scribe stays non-streaming, runs after scene, `turn_complete` → Task 3. Usage at stream end + disconnect best-effort → Task 1 (finally block + early-close test). Mock mode env-gated, zero Gemini, realistic pacing → Task 2. CORS → Task 2. 404 before stream → Task 2 test. `/continue` untouched in behavior (validation refactored to shared helper, pinned by regression test) → Task 3. Live verification incl. quota-blocked contingency → Task 4. ✓

**Placeholder scan:** Task 2's 501 line is a deliberate, tested, one-task increment explicitly replaced in Task 3 — labeled as such in code and plan. No TBDs. ✓

**Type consistency:** `call_gemini_stream(contents, max_tokens, temperature, label="unlabeled")` yields `str` (Task 1) — consumed with `label="scene"` (Task 3). `sse_event(event, data) -> str` (Task 2) used in Task 3. `validate_turn_payload(raw) -> (summary, scenarios)` defined and consumed in Task 3. `parse_sse` + `CONTINUE_BODY` defined Task 2, reused Task 3. Test-count arithmetic: 29 → 34 → 38 → 42. ✓

**Known accepted quirks:** `time.sleep` is patched via the string form `"time.sleep"` in mock tests (module-global patch) — consistent with existing retry tests. TestClient buffers the whole SSE body (`resp.text`); incremental-arrival behavior is verified live in Task 4 rather than in unit tests.
