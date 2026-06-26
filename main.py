"""
Storyteller — v1 backend
A tiny FastAPI server with ONE endpoint: POST /suggest

What it does:
  You send a story premise (a sentence or two).
  It returns 3 short scenario options the writer can pick from.

This is the *core loop* of the whole app. Everything else (expand,
summary, the mobile UI) gets built on top of this once it works.

Run it locally with:
    uvicorn main:app --reload
Then it lives at http://127.0.0.1:8000
"""

import os
import json

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from google import genai

# ---------------------------------------------------------------------------
# 1. Load secrets
# ---------------------------------------------------------------------------
# load_dotenv() reads a file called ".env" sitting next to this one and loads
# its KEY=value lines into the environment. We keep the API key there (NOT in
# this file) so it never ends up in git or anywhere shippable. The mobile app
# will never see this key — only this server holds it.
load_dotenv()

API_KEY = os.environ.get("GEMINI_API_KEY")
if not API_KEY:
    # Fail loudly at startup rather than mysteriously at the first request.
    raise RuntimeError(
        "GEMINI_API_KEY is missing. Create a .env file with:\n"
        "GEMINI_API_KEY=your_key_here"
    )

# The client is the object that actually talks to Gemini. We create it once
# and reuse it for every request.
client = genai.Client(api_key=API_KEY)

# Flash-Lite = the cheapest tier. Plenty good for short scenario suggestions.
# Keeping the model name in one constant means you swap providers/models in
# exactly one place later — that's the "provider-agnostic" habit.
MODEL = "gemini-2.5-flash-lite"

# ---------------------------------------------------------------------------
# 2. The app
# ---------------------------------------------------------------------------
app = FastAPI(title="Storyteller API")


# A Pydantic "model" describes the shape of data we expect IN. FastAPI uses it
# to automatically validate the request body and reject bad input for you.
class SuggestRequest(BaseModel):
    premise: str


# ---------------------------------------------------------------------------
# 3. The prompt
# ---------------------------------------------------------------------------
# This is the static instruction we send every time. Because it's identical on
# every call, it's exactly the kind of text you'd later put behind context
# caching to cut cost. For now, plain is fine.
#
# The single most important line is the JSON instruction: we FORCE the model to
# answer only with JSON so our code can parse it reliably instead of trying to
# read prose.
SYSTEM_PROMPT = """You are a creative writing assistant for a story-building app.
Given a story premise, propose exactly 3 distinct next-scenario options.
Each option must be 1-2 sentences, vivid, and meaningfully different from the others.

Respond with ONLY raw JSON, no markdown, no backticks, in exactly this shape:
{"scenarios": ["option one", "option two", "option three"]}"""


def parse_scenarios(raw_text: str) -> list[str]:
    """
    Models sometimes wrap JSON in ```json fences or add stray text, even when
    told not to. This cleans that up, then parses. If anything is still wrong,
    we raise a clear error instead of crashing or returning garbage.
    """
    cleaned = raw_text.strip()
    # Strip code fences if the model added them anyway.
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        # After stripping backticks a leading "json" word can remain.
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()

    try:
        data = json.loads(cleaned)
        scenarios = data["scenarios"]
        # Basic sanity checks: it must be a list of strings.
        if not isinstance(scenarios, list) or not all(
            isinstance(s, str) for s in scenarios
        ):
            raise ValueError("scenarios was not a list of strings")
        return scenarios
    except (json.JSONDecodeError, KeyError, ValueError) as e:
        # We surface the raw model text so YOU can see what went wrong while
        # developing. In production you'd log this, not return it.
        raise HTTPException(
            status_code=502,
            detail=f"Model returned unparseable output ({e}). Raw: {raw_text[:300]}",
        )


# ---------------------------------------------------------------------------
# 4. The endpoint
# ---------------------------------------------------------------------------
@app.post("/suggest")
def suggest(req: SuggestRequest):
    """Take a premise, return 3 scenario options."""
    response = client.models.generate_content(
        model=MODEL,
        contents=f"{SYSTEM_PROMPT}\n\nPremise: {req.premise}",
        config={
            # max_output_tokens caps how long the answer can be. This is your
            # biggest cost lever, because output tokens are the expensive ones.
            "max_output_tokens": 300,
            "temperature": 0.9,  # higher = more creative/varied
        },
    )

    scenarios = parse_scenarios(response.text)
    return {"scenarios": scenarios}


# A trivial health check, handy for confirming the server is up.
@app.get("/")
def root():
    return {"status": "ok", "message": "Storyteller API is running"}
