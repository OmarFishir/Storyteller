import json as jsonlib
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from google.genai import errors

import main
import usage_log

client = TestClient(main.app)


def test_health_check():
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


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


def test_call_gemini_raises_429_without_retrying(monkeypatch):
    calls = {"n": 0}

    def always_quota(**kwargs):
        calls["n"] += 1
        raise errors.ClientError(429, {"error": {"message": "quota exceeded"}})

    monkeypatch.setattr(main.client.models, "generate_content", always_quota)
    monkeypatch.setattr("time.sleep", lambda *a: None)

    with pytest.raises(HTTPException) as exc_info:
        main.call_gemini("prompt", max_tokens=100, temperature=0.5)
    assert exc_info.value.status_code == 429
    assert calls["n"] == 1  # no retries — backoff cannot fix a daily cap


def test_call_gemini_reraises_other_client_errors(monkeypatch):
    def bad_request(**kwargs):
        raise errors.ClientError(400, {"error": {"message": "bad request"}})

    monkeypatch.setattr(main.client.models, "generate_content", bad_request)
    monkeypatch.setattr("time.sleep", lambda *a: None)

    with pytest.raises(errors.ClientError):
        main.call_gemini("prompt", max_tokens=100, temperature=0.5)


def test_call_gemini_502s_on_empty_response(monkeypatch):
    class FakeResponse:
        text = None

    monkeypatch.setattr(
        main.client.models, "generate_content", lambda **k: FakeResponse()
    )

    with pytest.raises(HTTPException) as exc_info:
        main.call_gemini("prompt", max_tokens=100, temperature=0.5)
    assert exc_info.value.status_code == 502


def test_suggest_returns_three_scenarios(monkeypatch):
    fake_json = '{"scenarios": ["one", "two", "three"]}'
    monkeypatch.setattr(main, "call_gemini", lambda *a, **k: fake_json)

    resp = client.post("/suggest", json={"premise": "a lost dog finds a door"})
    assert resp.status_code == 200
    assert resp.json()["scenarios"] == ["one", "two", "three"]


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


def test_call_gemini_survives_logging_failure(monkeypatch):
    def boom(**kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(main.usage_log, "log_usage", boom)

    class FakeResponse:
        text = "still works"

    monkeypatch.setattr(
        main.client.models, "generate_content", lambda **k: FakeResponse()
    )

    assert main.call_gemini("p", max_tokens=10, temperature=0.1) == "still works"


def test_call_gemini_warns_on_logging_failure(monkeypatch, capsys):
    def boom(**kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(main.usage_log, "log_usage", boom)

    class FakeResponse:
        text = "still works"

    monkeypatch.setattr(
        main.client.models, "generate_content", lambda **k: FakeResponse()
    )

    result = main.call_gemini("p", max_tokens=10, temperature=0.1)
    assert result == "still works"
    captured = capsys.readouterr()
    assert "usage logging failed" in captured.err


def test_templates_endpoint_lists_genres_without_style():
    resp = client.get("/templates")
    assert resp.status_code == 200
    templates = resp.json()["templates"]
    ids = {t["id"] for t in templates}
    assert {"fantasy", "noir", "scifi", "fairytale"} <= ids
    for t in templates:
        assert "style" not in t  # prompt material stays server-side
        assert isinstance(t["premise_seeds"], list) and t["premise_seeds"]


def test_parse_model_json_strips_fences_and_returns_dict():
    raw = '```json\n{"summary": "s", "scenarios": ["a"]}\n```'
    assert main.parse_model_json(raw) == {"summary": "s", "scenarios": ["a"]}


def test_parse_model_json_rejects_non_object_with_502():
    with pytest.raises(HTTPException) as exc_info:
        main.parse_model_json('["just", "a", "list"]')
    assert exc_info.value.status_code == 502


def test_suggest_with_template_injects_style(monkeypatch):
    captured = {}

    def fake_call_gemini(contents, **kwargs):
        captured["contents"] = contents
        return '{"scenarios": ["one", "two", "three"]}'

    monkeypatch.setattr(main, "call_gemini", fake_call_gemini)
    resp = client.post("/suggest", json={"premise": "a heist", "template_id": "noir"})
    assert resp.status_code == 200
    contents = captured["contents"]
    style = main.TEMPLATES["noir"]["style"]
    assert style in contents
    # Ordering matters for future prompt caching: static SYSTEM_PROMPT first,
    # semi-static genre style second, dynamic premise last.
    assert (
        contents.index(main.SYSTEM_PROMPT[:40])
        < contents.index(style)
        < contents.index("Premise:")
    )


def test_suggest_rejects_unknown_template(monkeypatch):
    monkeypatch.setattr(main, "call_gemini", lambda *a, **k: "unused")
    resp = client.post("/suggest", json={"premise": "x", "template_id": "nope"})
    assert resp.status_code == 404


def test_continue_returns_scene_summary_and_options(monkeypatch):
    responses = iter(
        [
            "The scene prose.",
            '{"summary": "updated summary", "scenarios": ["a", "b", "c"]}',
        ]
    )
    labels = []
    call_params = []

    def fake_call_gemini(contents, **kwargs):
        labels.append(kwargs["label"])
        call_params.append((kwargs["max_tokens"], kwargs["temperature"]))
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
    # Pin the token/temperature budget per call: storyteller call is more
    # expensive and more creative; scribe call is cheaper and more mechanical.
    assert call_params == [(600, 0.9), (800, 0.7)]


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


def test_continue_502_when_scribe_json_missing_summary(monkeypatch):
    responses = iter(["The scene prose.", '{"scenarios": ["a", "b", "c"]}'])
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


def test_continue_502_when_scribe_scenarios_not_a_list(monkeypatch):
    responses = iter(
        ["The scene prose.", '{"summary": "ok", "scenarios": "not a list"}']
    )
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


# ============================================================================
# call_gemini_stream tests
# ============================================================================

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


def test_call_gemini_stream_midstream_server_error_maps_to_503(monkeypatch):
    def chunks():
        yield FakeChunk(text="First ")
        raise errors.ServerError(503, {"error": {"message": "overloaded"}})

    monkeypatch.setattr(
        main.client.models, "generate_content_stream", lambda **k: chunks()
    )

    gen = main.call_gemini_stream("p", max_tokens=10, temperature=0.5, label="scene")
    assert next(gen) == "First "
    with pytest.raises(HTTPException) as exc_info:
        next(gen)
    assert exc_info.value.status_code == 503


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


# ============================================================================
# SSE streaming and CORS tests
# ============================================================================

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
    "template_id": "noir",
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
    # Reassembling every token yields exactly the first canned scene.
    scene = "".join(e["data"]["t"] for e in events if e["event"] == "scene_token")
    assert scene == main.MOCK_TURNS[0]["scene"]
    # The returned summary carries the turn marker that drives progression.
    assert "(mock turn 1)" in events[-1]["data"]["summary"]
    assert len(events[-1]["data"]["scenarios"]) == 3


def test_mock_stream_advances_through_scenes(monkeypatch):
    """Playing the mock loop must tell a PROGRESSING story, not repeat one scene.

    The mock is stateless like the real engine: its turn_complete summary
    carries a '(mock turn N)' marker, and the next request's summary tells it
    which scene comes next. Live-play bug: the original single-scene mock made
    every turn identical, which looked exactly like a duplication bug.
    """
    monkeypatch.setenv("DEV_MOCK_ENABLED", "1")
    monkeypatch.setattr("time.sleep", lambda *a: None)

    # Turn 1: fresh premise, no marker.
    first = parse_sse(client.post("/continue/stream?mock=true", json=CONTINUE_BODY).text)
    first_scene = "".join(e["data"]["t"] for e in first if e["event"] == "scene_token")
    first_summary = first[-1]["data"]["summary"]

    # Turn 2: client passes the returned summary back, exactly like the real loop.
    body2 = dict(CONTINUE_BODY, summary=first_summary)
    second = parse_sse(client.post("/continue/stream?mock=true", json=body2).text)
    second_scene = "".join(e["data"]["t"] for e in second if e["event"] == "scene_token")

    assert first_scene == main.MOCK_TURNS[0]["scene"]
    assert second_scene == main.MOCK_TURNS[1]["scene"]
    assert second_scene != first_scene
    assert "(mock turn 2)" in second[-1]["data"]["summary"]
    # Options differ per scene too — tapping shouldn't feel like Groundhog Day.
    assert second[-1]["data"]["scenarios"] != first[-1]["data"]["scenarios"]


def test_mock_stream_cycles_past_the_last_scene(monkeypatch):
    monkeypatch.setenv("DEV_MOCK_ENABLED", "1")
    monkeypatch.setattr("time.sleep", lambda *a: None)

    n = len(main.MOCK_TURNS)
    body = dict(CONTINUE_BODY, summary=f"whatever came before (mock turn {n})")
    events = parse_sse(client.post("/continue/stream?mock=true", json=body).text)
    scene = "".join(e["data"]["t"] for e in events if e["event"] == "scene_token")
    assert scene == main.MOCK_TURNS[0]["scene"]  # wraps around, never crashes


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


def test_stream_unexpected_error_sanitized_and_logged(monkeypatch, capsys):
    def dies_after_one(contents, **kwargs):
        yield "First words "
        raise RuntimeError("secret internals")

    monkeypatch.setattr(main, "call_gemini_stream", dies_after_one)

    resp = client.post("/continue/stream", json=CONTINUE_BODY)
    events = parse_sse(resp.text)
    assert events[0] == {"event": "scene_token", "data": {"t": "First words "}}
    assert events[-1]["event"] == "error"
    assert events[-1]["data"]["status"] == 500
    assert "secret internals" not in events[-1]["data"]["detail"]
    assert "retry" in events[-1]["data"]["detail"].lower()

    captured = capsys.readouterr()
    assert "secret internals" in captured.err
    assert "unexpected streaming error" in captured.err


def test_continue_502_when_scenarios_empty(monkeypatch):
    responses = iter(["The scene prose.", '{"summary": "ok", "scenarios": []}'])
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
    assert resp.status_code == 502  # zero options is a dead end delivered as success


def test_continue_still_validates_after_refactor(monkeypatch):
    responses = iter(["scene", '{"summary": "", "scenarios": ["a", "b", "c"]}'])
    monkeypatch.setattr(main, "call_gemini", lambda c, **kw: next(responses))

    resp = client.post("/continue", json=CONTINUE_BODY)
    assert resp.status_code == 502  # empty summary still rejected via shared helper


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
