import pytest

import usage_log


@pytest.fixture(autouse=True)
def _redirect_usage_log(tmp_path, monkeypatch):
    """Every test writes usage logs to a throwaway temp dir, not logs/."""
    monkeypatch.setattr(usage_log, "LOG_DIR", str(tmp_path))
    monkeypatch.setattr(usage_log, "LOG_PATH", str(tmp_path / "usage.jsonl"))
