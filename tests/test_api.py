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
