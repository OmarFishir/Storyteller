import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from google.genai import errors

import main

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
