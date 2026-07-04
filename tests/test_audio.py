"""
Tests for the audio slice: /transcribe (ears) and /narrate (mouth).

parse-helpers/TestClient duplicated from test_api.py on purpose (tests aren't
a package; consolidation rides with the Phase-3 split). Gemini is never
called — conftest's tripwire enforces it.
"""

import io
import wave

import pytest
from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


def _post_audio(data: bytes, filename="clip.webm", mime="audio/webm"):
    return client.post("/transcribe", files={"audio": (filename, data, mime)})


def test_transcribe_returns_stripped_transcript(monkeypatch):
    captured = {}

    def fake_gemini(contents, **kwargs):
        captured["kwargs"] = kwargs
        captured["contents"] = contents
        return "  she walks into the rain \n"

    monkeypatch.setattr(main, "call_gemini", fake_gemini)
    resp = _post_audio(b"fake-webm-bytes")
    assert resp.status_code == 200
    assert resp.json() == {"transcript": "she walks into the rain"}
    assert captured["kwargs"]["label"] == "stt"
    assert captured["kwargs"]["max_tokens"] == main.STT_BUDGET
    assert captured["kwargs"]["temperature"] == 0.0
    # contents = [static prompt, audio part] — order pinned (static first)
    assert captured["contents"][0] == main.TRANSCRIBE_PROMPT
    part = captured["contents"][1]
    assert part.inline_data.data == b"fake-webm-bytes"
    assert part.inline_data.mime_type == "audio/webm"


def test_transcribe_passes_client_mime_through(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        main,
        "call_gemini",
        lambda contents, **kw: captured.update(part=contents[1]) or "hi",
    )
    resp = _post_audio(b"x", filename="clip.m4a", mime="audio/mp4")
    assert resp.status_code == 200
    assert captured["part"].inline_data.mime_type == "audio/mp4"


def test_transcribe_oversized_audio_is_413(monkeypatch):
    def tripwire(*a, **kw):  # oversize must be rejected BEFORE any model call
        raise AssertionError("call_gemini must not be reached")

    monkeypatch.setattr(main, "call_gemini", tripwire)
    resp = _post_audio(b"x" * (main.MAX_AUDIO_BYTES + 1))
    assert resp.status_code == 413


def test_transcribe_missing_file_is_422():
    resp = client.post("/transcribe")
    assert resp.status_code == 422


def test_transcribe_maps_gemini_errors(monkeypatch):
    from fastapi import HTTPException

    def busy(contents, **kw):
        raise HTTPException(status_code=503, detail=main.DETAIL_MODEL_BUSY)

    monkeypatch.setattr(main, "call_gemini", busy)
    resp = _post_audio(b"x")
    assert resp.status_code == 503
