import os

os.environ.setdefault("GEMINI_API_KEY", "test-dummy-key-not-real")

import pytest

import usage_log


@pytest.fixture(autouse=True)
def _redirect_usage_log(tmp_path, monkeypatch):
    """Every test writes usage logs to a throwaway temp dir, not logs/."""
    monkeypatch.setattr(usage_log, "LOG_DIR", str(tmp_path))
    monkeypatch.setattr(usage_log, "LOG_PATH", str(tmp_path / "usage.jsonl"))


@pytest.fixture(autouse=True)
def _block_real_gemini_calls(monkeypatch):
    """
    Structural tripwire: no test should ever reach the real Gemini API.
    Individual tests that legitimately monkeypatch generate_content (or
    call_gemini itself) override this because their setattr runs later.
    """
    import main

    def _refuse(**kwargs):
        raise AssertionError(
            "Test attempted a real Gemini API call - mock call_gemini or generate_content"
        )

    def _refuse_stream(**kwargs):
        raise AssertionError(
            "Test attempted a real Gemini streaming call - mock call_gemini_stream or generate_content_stream"
        )

    monkeypatch.setattr(main.client.models, "generate_content", _refuse)
    monkeypatch.setattr(main.client.models, "generate_content_stream", _refuse_stream)
