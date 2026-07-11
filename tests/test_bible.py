"""POST /bible — the story-bible extraction behind the client's
Characters / Environment / History & Places pages. Gemini is mocked at the
call_gemini seam (conftest's tripwire guards the rest)."""

import json

import pytest
from fastapi.testclient import TestClient

import main

client = TestClient(main.app)

GOOD_BIBLE = json.dumps(
    {
        "characters": [
            {"name": "Samuel", "description": "A quiet archivist with a debt."}
        ],
        "places": [
            {"name": "The lower stacks", "description": "Forbidden library depths."}
        ],
        "environment": "A candlelit library-city where maps misbehave.",
    }
)


def test_bible_happy_path(monkeypatch):
    captured = {}

    def fake_call(contents, max_tokens, temperature, label):
        captured.update(
            contents=contents, max_tokens=max_tokens, temperature=temperature, label=label
        )
        return GOOD_BIBLE

    monkeypatch.setattr(main, "call_gemini", fake_call)
    res = client.post("/bible", json={"summary": "Samuel guards a map.", "notes": "Maps are alive."})
    assert res.status_code == 200
    body = res.json()
    assert body["characters"] == [
        {"name": "Samuel", "description": "A quiet archivist with a debt."}
    ]
    assert body["places"][0]["name"] == "The lower stacks"
    assert body["environment"].startswith("A candlelit")
    # Cost caps + label pinned like every other call.
    assert captured["max_tokens"] == main.BIBLE_BUDGET
    assert captured["temperature"] == 0.4
    assert captured["label"] == "bible"
    # Caching-order convention: static prompt first, then the material.
    assert captured["contents"].startswith(main.BIBLE_PROMPT)
    assert "Samuel guards a map." in captured["contents"]
    assert "Maps are alive." in captured["contents"]


def test_bible_empty_notes_get_placeholder(monkeypatch):
    captured = {}

    def fake_call(contents, **kwargs):
        captured["contents"] = contents
        return GOOD_BIBLE

    monkeypatch.setattr(main, "call_gemini", fake_call)
    res = client.post("/bible", json={"summary": "A story."})
    assert res.status_code == 200
    assert "(none yet)" in captured["contents"]


def test_bible_empty_lists_are_valid(monkeypatch):
    thin = json.dumps({"characters": [], "places": [], "environment": ""})
    monkeypatch.setattr(main, "call_gemini", lambda *a, **k: thin)
    res = client.post("/bible", json={"summary": "Barely begun."})
    assert res.status_code == 200
    assert res.json() == {"characters": [], "places": [], "environment": ""}


@pytest.mark.parametrize(
    "bad",
    [
        "not json at all",
        json.dumps({"characters": "nope", "places": [], "environment": ""}),
        json.dumps({"characters": [{"name": "X"}], "places": [], "environment": ""}),
        json.dumps({"characters": [], "places": [], "environment": 7}),
        json.dumps({"characters": [{"name": " ", "description": "d"}], "places": [], "environment": ""}),
    ],
)
def test_bible_garbage_becomes_502(monkeypatch, bad):
    monkeypatch.setattr(main, "call_gemini", lambda *a, **k: bad)
    res = client.post("/bible", json={"summary": "A story."})
    assert res.status_code == 502


def test_bible_missing_summary_is_422():
    res = client.post("/bible", json={"notes": "only notes"})
    assert res.status_code == 422
