"""
Tiny cost meter. One JSONL line per Gemini call.

JSONL = one JSON object per line. Trivially greppable and parseable —
the whole "dashboard" for now is opening the file. logs/ is git-ignored.
"""
import json
import os
from datetime import datetime, timezone

LOG_DIR = "logs"
LOG_PATH = os.path.join(LOG_DIR, "usage.jsonl")


def log_usage(label: str, model: str, input_tokens: int, output_tokens: int) -> None:
    os.makedirs(LOG_DIR, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "label": label,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
