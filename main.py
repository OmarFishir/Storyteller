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
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from google import genai
from google.genai import errors

import usage_log
import story_templates

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

# Genre templates, loaded once at startup. Fail-loud on malformed files.
TEMPLATES = story_templates.load_templates()

# ---------------------------------------------------------------------------
# 2. The app
# ---------------------------------------------------------------------------
app = FastAPI(title="Storyteller API")


# A Pydantic "model" describes the shape of data we expect IN. FastAPI uses it
# to automatically validate the request body and reject bad input for you.
class SuggestRequest(BaseModel):
    premise: str
    template_id: str | None = None


class ExpandRequest(BaseModel):
    scenario: str
    instruction: str


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


# Static instruction for /expand. Front-loaded and identical every call, same
# caching-ready shape as SYSTEM_PROMPT. Unlike /suggest, the model returns plain
# prose (one rewritten scenario), so there is NO JSON to parse.
EXPAND_PROMPT = """You are a creative writing assistant for a story-building app.
You will be given a single story scenario and an instruction for changing it.
Rewrite the scenario to follow the instruction. Keep it vivid and self-contained.
Respond with ONLY the rewritten scenario as plain prose — no preamble, no labels,
no markdown, no quotes."""


def parse_model_json(raw_text: str) -> dict:
    """
    Models sometimes wrap JSON in ```json fences or add stray text, even when
    told not to. Strip that, parse, and require a JSON object. On anything
    else, raise a clean 502 carrying the raw text (visible while developing;
    in production you'd log it instead).
    """
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        # After stripping backticks a leading "json" word can remain.
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()

    try:
        data = json.loads(cleaned)
        if not isinstance(data, dict):
            raise ValueError("top-level JSON was not an object")
        return data
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(
            status_code=502,
            detail=f"Model returned unparseable output ({e}). Raw: {raw_text[:300]}",
        )


def parse_scenarios(raw_text: str) -> list[str]:
    """Validate the /suggest shape: {"scenarios": [str, str, str]}."""
    data = parse_model_json(raw_text)
    scenarios = data.get("scenarios")
    if not isinstance(scenarios, list) or not all(
        isinstance(s, str) for s in scenarios
    ):
        raise HTTPException(
            status_code=502,
            detail=f"Model JSON missing valid 'scenarios'. Raw: {raw_text[:300]}",
        )
    return scenarios


def get_template_or_404(template_id: str) -> dict:
    """Look up a genre template; unknown ids get a clean 404 listing valid ones."""
    template = TEMPLATES.get(template_id)
    if template is None:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown template_id '{template_id}'. Valid ids: {sorted(TEMPLATES)}",
        )
    return template


def call_gemini(
    contents: str, max_tokens: int, temperature: float, label: str = "unlabeled"
) -> str:
    """
    Make ONE Gemini request, retrying transient server errors (5xx) with
    exponential backoff (1s, 2s, 4s). Returns the model's text.

    Logs token usage for every successful call (the cost meter lives here
    because every endpoint funnels through this one function).

    If the model is still unavailable after all retries, raises a clean
    503 (HTTPException) instead of leaking a 500/stack trace.
    """
    delays = [1, 2, 4]  # waits between attempts; 3 retries after the first try
    for attempt in range(len(delays) + 1):  # 4 attempts total
        try:
            response = client.models.generate_content(
                model=MODEL,
                contents=contents,
                config={
                    "max_output_tokens": max_tokens,
                    "temperature": temperature,
                },
            )
            usage = getattr(response, "usage_metadata", None)
            try:
                usage_log.log_usage(
                    label=label,
                    model=MODEL,
                    input_tokens=(usage.prompt_token_count or 0) if usage else 0,
                    output_tokens=(usage.candidates_token_count or 0) if usage else 0,
                )
            except Exception:
                # The cost meter must never break the request it measures.
                pass
            return response.text
        except errors.ServerError:
            if attempt < len(delays):
                time.sleep(delays[attempt])
            # On the final attempt we fall through and raise below.

    raise HTTPException(
        status_code=503,
        detail="The AI model is busy right now. Please try again in a moment.",
    )


# ---------------------------------------------------------------------------
# 4. The endpoint
# ---------------------------------------------------------------------------
@app.post("/suggest")
def suggest(req: SuggestRequest):
    """Take a premise (optionally genre-styled), return 3 scenario options."""
    style_block = ""
    if req.template_id is not None:
        template = get_template_or_404(req.template_id)
        style_block = f"\n\nGenre style:\n{template['style']}"

    # Ordering matters for future prompt caching: static SYSTEM_PROMPT first,
    # semi-static genre style second, dynamic premise last.
    text = call_gemini(
        f"{SYSTEM_PROMPT}{style_block}\n\nPremise: {req.premise}",
        max_tokens=300,
        temperature=0.9,
        label="suggest",
    )
    scenarios = parse_scenarios(text)
    return {"scenarios": scenarios}


@app.post("/expand")
def expand(req: ExpandRequest):
    """Take a chosen scenario + an instruction, return the original alongside a rewrite."""
    expanded = call_gemini(
        f"{EXPAND_PROMPT}\n\nScenario: {req.scenario}\n\nInstruction: {req.instruction}",
        max_tokens=600,
        temperature=0.8,
        label="expand",
    )
    return {"original": req.scenario, "expanded": expanded}


# A trivial health check, handy for confirming the server is up.
@app.get("/")
def root():
    return {"status": "ok", "message": "Storyteller API is running"}


@app.get("/templates")
def list_templates():
    """Genre templates the client can offer. 'style' stays server-side (prompt material)."""
    return {
        "templates": [
            {
                "id": t["id"],
                "name": t["name"],
                "description": t["description"],
                "premise_seeds": t["premise_seeds"],
            }
            for t in TEMPLATES.values()
        ]
    }
