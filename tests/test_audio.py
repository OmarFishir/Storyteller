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


# --- /narrate ---------------------------------------------------------------

class _FakeInline:
    def __init__(self, data, mime="audio/L16;rate=24000"):
        self.data = data
        self.mime_type = mime


class _FakePart:
    def __init__(self, data):
        self.inline_data = _FakeInline(data)


class _FakeResponse:
    def __init__(self, data, usage=None):
        self.parts = [_FakePart(data)]
        self.usage_metadata = usage


def test_pcm_to_wav_wraps_a_valid_riff_container():
    pcm = b"\x00\x01" * 240  # 10ms of fake 24kHz 16-bit mono
    wav_bytes = main.pcm_to_wav(pcm)
    with wave.open(io.BytesIO(wav_bytes)) as w:
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.getframerate() == 24000
        assert w.readframes(w.getnframes()) == pcm


def test_narrate_returns_wav_and_logs_tts(monkeypatch):
    captured = {}

    def fake_tts(text, **kwargs):
        captured["text"] = text
        return b"PCMBYTES"

    monkeypatch.setattr(main, "call_gemini_tts", fake_tts)
    resp = client.post("/narrate", json={"text": "The rain fell.", "kind": "scene"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("audio/wav")
    assert resp.content == main.pcm_to_wav(b"PCMBYTES")
    assert captured["text"] == "The rain fell."


def test_narrate_char_cap_is_413(monkeypatch):
    def tripwire(*a, **kw):
        raise AssertionError("call_gemini_tts must not be reached")

    monkeypatch.setattr(main, "call_gemini_tts", tripwire)
    resp = client.post(
        "/narrate", json={"text": "x" * (main.NARRATE_CHAR_CAP + 1), "kind": "scene"}
    )
    assert resp.status_code == 413


def test_narrate_missing_text_is_422():
    assert client.post("/narrate", json={"kind": "scene"}).status_code == 422


def test_call_gemini_tts_extracts_pcm_and_logs_usage(monkeypatch):
    calls = {}

    class FakeUsage:
        prompt_token_count = 12
        candidates_token_count = 340

    def fake_generate(model, contents, config):
        calls["model"] = model
        calls["contents"] = contents
        calls["voice"] = (
            config.speech_config.voice_config.prebuilt_voice_config.voice_name
        )
        return _FakeResponse(b"RAWPCM", usage=FakeUsage())

    monkeypatch.setattr(main.client.models, "generate_content", fake_generate)
    logged = {}
    monkeypatch.setattr(
        main.usage_log,
        "log_usage",
        lambda **kw: logged.update(kw),
    )

    pcm = main.call_gemini_tts("Hello there.")
    assert pcm == b"RAWPCM"
    assert calls["model"] == main.TTS_MODEL
    assert calls["voice"] == main.VOICE_NAME
    assert "Hello there." in calls["contents"]
    assert logged["label"] == "tts"
    assert logged["input_tokens"] == 12
    assert logged["output_tokens"] == 340


def test_call_gemini_tts_no_audio_part_is_502(monkeypatch):
    class Empty:
        parts = []
        usage_metadata = None

    monkeypatch.setattr(
        main.client.models, "generate_content", lambda **kw: Empty()
    )
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        main.call_gemini_tts("Hello")
    assert exc.value.status_code == 502


def test_call_gemini_tts_429_maps_clean(monkeypatch):
    from google.genai import errors as genai_errors

    def quota(**kw):
        e = genai_errors.ClientError.__new__(genai_errors.ClientError)
        e.code = 429
        raise e

    monkeypatch.setattr(main.client.models, "generate_content", quota)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        main.call_gemini_tts("Hello")
    assert exc.value.status_code == 429
