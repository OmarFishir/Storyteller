"""
Storyteller — backend

FastAPI server for the AI-assisted choose-your-own-adventure builder. Endpoints:
  POST /suggest          — premise -> 3 scenario options
  POST /expand           — refine one chosen scenario per a plain-English instruction
  POST /continue         — advance the story: scene + updated running summary + next options
  POST /continue/stream  — SSE twin of /continue (word-by-word scene tokens);
                            supports an env-gated mock mode for offline client work
  GET  /templates        — genre templates the client can offer

Run it locally with:
    uvicorn main:app --reload
Then it lives at http://127.0.0.1:8000
"""

import os
import json
import re
import sys
import time
from collections.abc import Iterator
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from google import genai
from google.genai import errors

import usage_log
import story_templates
import story_beats

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

# CORS lets the browser-based Expo dev loop (a different origin) call this API.
# Wide-open is a DEV-ONLY stance — must be locked down before any public
# exposure (roadmap Phase 6).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# A Pydantic "model" describes the shape of data we expect IN. FastAPI uses it
# to automatically validate the request body and reject bad input for you.
class SuggestRequest(BaseModel):
    premise: str
    template_id: str | None = None


class ExpandRequest(BaseModel):
    scenario: str
    instruction: str


class ContinueRequest(BaseModel):
    template_id: str
    summary: str
    chosen_scenario: str
    turn: int = Field(1, ge=1)
    length: Literal["short", "medium", "long"] = "short"


class DiscussionEntry(BaseModel):
    role: Literal["user", "ai"]
    text: str


class ConverseRequest(BaseModel):
    template_id: str
    utterance: str
    summary: str
    notes: str = ""
    options: list[str] = []
    discussion: list[DiscussionEntry] = []
    turn: int = Field(1, ge=1)
    length: Literal["short", "medium", "long"] = "short"


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
Each option must be 3-4 sentences, vivid, and meaningfully different from the others.

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


# Token budgets for /continue's two calls. The scene budget scales with the
# user-chosen story length (short/medium/long); the fold budget is a flat
# ceiling sized for 3 options x 3-4 sentences plus the summary. The summary
# word target ALSO scales with length — a longer story needs more room to
# retain named characters/facts without the compact-summary contract breaking.
SCENE_BUDGETS = {"short": 600, "medium": 800, "long": 1000}
FOLD_BUDGET = 800  # 3 options x 3-4 sentences + the summary
SUMMARY_WORDS = {"short": 150, "medium": 200, "long": 250}

# Call 1 of /continue — the "storyteller". Writes the actual scene as pure
# prose (NO JSON): mixing creative prose into JSON is where models break
# formatting, so prose stays prose.
STORY_PROMPT = """You are the narrator of an interactive story.
Write the next scene as vivid prose, 2-4 short paragraphs.
Follow the genre style exactly. Continue naturally from the story so far, and
make the scene deliver on the chosen direction. Ground the scene in its place
the way published fiction does: concrete sensory detail — sound, light,
weather, texture, smell — and let the setting itself carry story, not just
dialogue and plot. End at a natural pause that invites the next choice.
Respond with ONLY the scene prose — no title, no labels, no markdown."""

# Call 2 of /continue — the "scribe". Mechanical job: fold the new scene into
# a compact summary and offer the next 3 options. This is the cost-control
# contract: a 50-turn story still sends a bounded amount of history, not the
# whole transcript — the exact word limit is supplied per-request (it scales
# with story length) by build_fold_prompt, not baked into this static text.
FOLD_PROMPT = """You are the scribe for an interactive story. You receive the
story-so-far summary and the newest scene. Do two jobs:
1. Fold the newest scene into an updated summary of the WHOLE story so far.
   Keep it under the word limit given below. Preserve named characters, key
   facts, and unresolved plot threads.
2. Propose exactly 3 distinct options for what could happen next. Each option
   must be 3-4 sentences, meaningfully different from the others, and a vivid
   direction the story could take.

Respond with ONLY raw JSON, no markdown, no backticks, in exactly this shape:
{"summary": "updated summary", "scenarios": ["option one", "option two", "option three"]}"""


# --- Conversational co-creation ---------------------------------------------
# The fused router+responder call for /converse/stream. ONE cheap call decides
# what the user meant AND acts on it: the FIRST LINE of its output is a
# machine-readable verdict; only "discuss" continues with prose. When unsure it
# must choose discuss — the cheap, story-safe default (a misroute costs one
# reply, never a polluted story).
CONVERSE_PROMPT = """You are the story companion for an interactive story app.
The user just spoke. Decide what they meant and answer in EXACTLY the format below.

They might be:
- picking one of the numbered option cards -> first line: INTENT: pick N
  (N is the card number as listed, counting from 1; output NOTHING else)
- steering the story with a new direction of their own -> first line: INTENT: steer
  (output NOTHING else; the app uses their words verbatim)
- asking for different or new option ideas -> first line: INTENT: options
  then, on the following lines, ONLY raw JSON, no markdown, no backticks:
  {"scenarios": ["option one", "option two", "option three"]}
  (exactly 3 options, each 3-4 sentences, meaningfully different, informed by
  the discussion and notes below)
- discussing the story: asking about an option card, a character, the world;
  inventing backstory together; thinking aloud -> first line: INTENT: discuss
  then, starting on the next line, your conversational reply: warm,
  collaborative, 2-5 sentences, grounded ONLY in the story materials below.
  You may end with one question back to the user. Never write the next scene here.

If you are not sure which they meant, choose INTENT: discuss.
The first line must be exactly one of: "INTENT: pick N", "INTENT: steer",
"INTENT: options", "INTENT: discuss" — nothing else on that line."""

# The notes scribe — the discussion channel's counterpart of FOLD_PROMPT.
# Summary = what HAPPENED (the fold call owns it); notes = what is TRUE
# (this call owns it). Only this call ever writes notes.
NOTES_PROMPT = """You are the keeper of story notes (canon) for an interactive story.
You receive the existing notes and the newest exchange between the user and
the story companion. Fold any NEW durable facts the exchange established
(character names, backstory, relationships, world truths, decisions about
what is true) into the notes. Preserve existing facts; on conflict the newest
detail wins. If the exchange established nothing durable, return the notes
unchanged. Stay under the word limit given below.
Respond with ONLY raw JSON, no markdown, no backticks, in exactly this shape:
{"notes": "the updated notes"}"""

CONVERSE_BUDGET = 600  # covers the biggest case: 3 fresh options
NOTES_BUDGET = 200
NOTES_WORDS = 120


def build_scene_prompt(template: dict, req: ContinueRequest) -> str:
    """Assemble the storyteller prompt: static -> style -> beat -> dynamic."""
    beats = story_beats.select_beats(template.get("structure"), req.turn, req.length)
    beat_block = ""
    if beats:
        current, _ = beats
        beat_block = f"\n\nCurrent story beat: {current['name']} — {current['guidance']}"
    return (
        f"{STORY_PROMPT}\n\nGenre style:\n{template['style']}{beat_block}\n\n"
        f"Story so far:\n{req.summary}\n\n"
        f"Chosen direction:\n{req.chosen_scenario}"
    )


def build_fold_prompt(req: ContinueRequest, scene: str) -> str:
    """
    Assemble the scribe prompt; the summary word budget scales with length.

    Options proposed here are generated at turn t but CONSUMED at turn t+1 —
    so steering must target turn t+1's CURRENT beat, not the structurally-next
    beat. On short (1 turn/beat) those coincide; on medium/long, turn t+1 is
    often still inside the same beat the story is already on.
    """
    template = TEMPLATES.get(req.template_id, {})
    steer = story_beats.select_beats(template.get("structure"), req.turn + 1, req.length)
    steer_block = ""
    if steer:
        target, _ = steer
        steer_block = (
            f"\nSteer the options toward the next story beat: "
            f"{target['name']} — {target['guidance']}"
        )
    return (
        f"{FOLD_PROMPT}\n\nWord limit for the summary: "
        f"{SUMMARY_WORDS[req.length]} words.{steer_block}\n\n"
        f"Story-so-far summary:\n{req.summary}\n\nNewest scene:\n{scene}"
    )


def build_converse_prompt(template: dict, req: ConverseRequest) -> str:
    """Assemble the fused router+responder prompt: static -> style -> dynamic."""
    options_block = (
        "\n".join(f"{i + 1}. {opt}" for i, opt in enumerate(req.options))
        or "(none offered yet)"
    )
    discussion_block = (
        "\n".join(
            f"{'User' if d.role == 'user' else 'You'}: {d.text}"
            for d in req.discussion[-6:]  # belt-and-braces cap; client caps too
        )
        or "(no discussion yet)"
    )
    return (
        f"{CONVERSE_PROMPT}\n\nGenre style:\n{template['style']}\n\n"
        f"Established story notes (canon):\n{req.notes or '(none yet)'}\n\n"
        f"Story so far:\n{req.summary}\n\n"
        f"Current option cards:\n{options_block}\n\n"
        f"Recent discussion:\n{discussion_block}\n\n"
        f"The user just said:\n{req.utterance}"
    )


def build_notes_prompt(notes: str, utterance: str, reply: str) -> str:
    """Assemble the notes-scribe prompt; the word cap keeps canon bounded."""
    return (
        f"{NOTES_PROMPT}\n\nWord limit for the notes: {NOTES_WORDS} words.\n\n"
        f"Existing notes:\n{notes or '(none yet)'}\n\n"
        f"User said:\n{utterance}\n\nCompanion replied:\n{reply}"
    )


_INTENT_RE = re.compile(
    r"^\s*INTENT:\s*(discuss|steer|options|pick(?:\s+(\d+))?)\s*$", re.IGNORECASE
)


def parse_intent_line(line: str, options_count: int) -> tuple[str, int | None]:
    """
    Parse the fused call's first line. Returns (intent, index): index is
    0-BASED and set only for in-range picks (the model speaks 1-based, like
    the numbered card list it sees). An out-of-range or number-less pick
    DOWNGRADES to ("pick_invalid", None) — the endpoint answers with a fixed
    clarification bubble, never a 500 and never a blind turn. A first line
    that isn't an INTENT line at all is model garbage: clean 502.
    """
    m = _INTENT_RE.match(line)
    if m is None:
        raise HTTPException(
            status_code=502,
            detail=f"Model returned an unreadable intent line. Raw: {line[:200]}",
        )
    kind = m.group(1).lower()
    if kind.startswith("pick"):
        number = m.group(2)
        if number is None:
            return ("pick_invalid", None)
        idx = int(number) - 1
        if 0 <= idx < options_count:
            return ("pick", idx)
        return ("pick_invalid", None)
    return (kind, None)


def pick_clarification(options_count: int) -> str:
    """Fixed reply when the model picked a card that doesn't exist."""
    if options_count == 0:
        return "There are no option cards right now — ask me for some ideas!"
    return f"I only offered {options_count} ideas — which one did you mean?"


def parse_notes(raw_text: str) -> str:
    """Validate the notes scribe's shape: {"notes": str}."""
    data = parse_model_json(raw_text)
    notes = data.get("notes")
    if not isinstance(notes, str):
        raise HTTPException(
            status_code=502,
            detail=f"Model JSON missing valid 'notes'. Raw: {raw_text[:300]}",
        )
    return notes


# --- Mock mode -------------------------------------------------------------
# Streams canned scenes word-by-word with realistic pacing so the client's
# animation can be built AND the loop can be played with ZERO Gemini calls
# (free, offline, deterministic — doubles as a test fixture). Gated by
# DEV_MOCK_ENABLED so it can never exist in a production deploy.
#
# The mock is stateless like the real engine and self-advances the same way:
# its turn_complete summary carries a "(mock turn N)" marker; the client sends
# that summary back on the next turn, telling the mock which scene comes next.
# (The original single-scene mock repeated identically every turn — which,
# played live, was indistinguishable from a scene-duplication bug.)
MOCK_TURNS = [
    {
        "scene": (
            "The lantern guttered as Mira pressed her palm against the cold iron "
            "door. Somewhere beyond it, water dripped in slow, deliberate beats, "
            "like something counting.\n\nShe had been warned about the lower stacks "
            "— every apprentice was — but the map in her satchel showed a corridor "
            "that should not exist, and Mira had never once managed to leave a "
            "wrong map uncorrected."
        ),
        "summary_base": (
            "Apprentice mapmaker Mira stands before a cold iron door in the "
            "forbidden lower stacks, following a corridor missing from every map."
        ),
        "scenarios": [
            "Mira forces the iron door with her shoulder and a mapmaker's stubbornness. "
            "Inside, candlelight breathes over a great oak table. On it, a map of the "
            "kingdom is drawing itself, ink crawling like patient ants. Every line is "
            "perfect except the corridor she came by — which is being erased behind her.",
            "A voice behind the door asks her, by name, to slide the map underneath. "
            "Mira hesitates, her hand already halfway to her satchel. The voice sounds "
            "tired, almost grateful, like it has been waiting longer than she has been "
            "alive. She has to decide whether trust or caution gets to lead.",
            "The dripping stops, and footsteps begin — slow, unhurried, approaching "
            "from the corridor that shouldn't exist. Mira presses herself flat against "
            "the cold iron, counting the steps instead of breathing. Whoever it is "
            "knows exactly where she's standing. When the footsteps finally stop, they "
            "stop right outside her door.",
        ],
    },
    {
        "scene": (
            "The door swung open at a touch, as if it had only ever been waiting "
            "for manners. Inside, a round room breathed with candlelight, and on "
            "a great oak table a map of the kingdom was drawing itself — inklines "
            "crawling like patient ants toward the edge of the parchment.\n\nEvery "
            "line was perfect. Every line but one: the corridor Mira stood in was "
            "being erased, stroke by stroke, behind her."
        ),
        "summary_base": (
            "Mira has entered a hidden chart-room where maps draw themselves — "
            "and something is erasing the corridor behind her."
        ),
        "scenarios": [
            "Mira grabs the pen mid-stroke and writes the corridor back in herself. "
            "The ink fights her, curling away like it resents the correction. "
            "Candlelight flickers as the whole room seems to hold its breath. If the "
            "line holds, she'll have her way out; if it doesn't, she may be trapped "
            "here for good.",
            "She follows the vanishing line out, racing the eraser toward the exit. "
            "Behind her the corridor closes stroke by stroke, faster than she can run. "
            "Her boots skid on stone that hasn't finished drawing itself yet. She "
            "reaches the threshold just as the last inch of floor disappears beneath "
            "her heel.",
            "She asks the room, aloud, who taught the maps to lie. For a long moment "
            "only the candles answer, guttering all at once in a draft that came from "
            "nowhere. Then the ink on the table rearranges itself into words she "
            "almost recognizes. Whatever wrote them wants her to keep asking "
            "questions.",
        ],
    },
    {
        "scene": (
            "The pen was warm, like a hand recently held. When Mira touched it, "
            "every candle leaned toward her as though the room had turned to "
            "listen.\n\n\"Cartographers used to ask permission,\" said a voice from "
            "under the table — unhurried, papery, amused. A creature made entirely "
            "of folded maps unbent itself to her exact height and held out the "
            "corridor she had come by, rolled tight as a scroll. \"Yours, I "
            "believe. You dropped it when you believed in it.\""
        ),
        "summary_base": (
            "A creature of folded maps has returned the missing corridor to Mira "
            "and hinted that the kingdom's maps lie by design."
        ),
        "scenarios": [
            "Mira unrolls the corridor right there and steps into what it shows. The "
            "scroll unfurls into a hallway that smells of rain that hasn't fallen yet. "
            "Behind her, the chart-room folds itself away like it was never real. "
            "Ahead, the corridor keeps going exactly as far as her nerve does.",
            "She bargains: the corridor's secret in exchange for fixing the maps for "
            "good. The folded creature tilts its paper head, considering, papers "
            "rustling like a held breath. It says a fair trade requires a fair price, "
            "and asks what she's willing to lose. Mira realizes she hasn't actually "
            "decided yet.",
            "She pockets the scroll and pretends not to care what it means. The "
            "creature watches her with folds that might be amusement or something "
            "older. Outside, the ordinary stacks wait exactly where she left them, "
            "unchanged and unaware. But the scroll sits heavier in her satchel than "
            "paper has any right to.",
        ],
    },
]

_MOCK_MARKER = re.compile(r"\(mock turn (\d+)\)")


def _stream_mock(summary: str):
    """Stream the next canned scene, chosen by the marker in the incoming summary."""
    match = _MOCK_MARKER.search(summary)
    turn_number = int(match.group(1)) if match else 0
    mock = MOCK_TURNS[turn_number % len(MOCK_TURNS)]

    words = mock["scene"].split(" ")
    for i, word in enumerate(words):
        token = word if i == len(words) - 1 else word + " "
        yield sse_event("scene_token", {"t": token})
        time.sleep(0.03)  # realistic pacing for animation work; patched in tests
    yield sse_event(
        "turn_complete",
        {
            "summary": f"{mock['summary_base']} (mock turn {turn_number + 1})",
            "scenarios": mock["scenarios"],
        },
    )


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


def validate_turn_payload(raw_text: str) -> tuple[str, list[str]]:
    """
    Validate the scribe's JSON: {"summary": non-empty str, "scenarios": [str, ...]}.
    The ONE place this shape is checked — used by /continue and /continue/stream.
    """
    data = parse_model_json(raw_text)
    summary = data.get("summary")
    scenarios = data.get("scenarios")
    if not isinstance(summary, str) or not summary.strip():
        raise HTTPException(
            status_code=502,
            detail=f"Model JSON missing valid 'summary'. Raw: {raw_text[:300]}",
        )
    if (
        not isinstance(scenarios, list)
        or len(scenarios) == 0
        or not all(isinstance(s, str) for s in scenarios)
    ):
        raise HTTPException(
            status_code=502,
            detail=f"Model JSON missing valid 'scenarios'. Raw: {raw_text[:300]}",
        )
    return summary, scenarios


def get_template_or_404(template_id: str) -> dict:
    """Look up a genre template; unknown ids get a clean 404 listing valid ones."""
    template = TEMPLATES.get(template_id)
    if template is None:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown template_id '{template_id}'. Valid ids: {sorted(TEMPLATES)}",
        )
    return template


# User-facing detail strings shared by every place a Gemini call gives up:
# call_gemini's exhausted-retry 503, call_gemini_stream's pre-first-byte 503,
# its mid-stream 503, and both functions' 429 — one wording, one place to edit.
DETAIL_MODEL_BUSY = "The AI model is busy right now. Please try again in a moment."
DETAIL_QUOTA = "Daily AI quota reached. Please try again later."


def sse_event(event: str, data: dict) -> str:
    """One Server-Sent Events frame: 'event' names it, 'data' is one JSON line."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


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
            except Exception as e:
                # The cost meter must never break the request it measures —
                # but dying silently would hide that billing data stopped.
                print(f"WARNING: usage logging failed: {e}", file=sys.stderr)
            if not response.text:
                raise HTTPException(
                    status_code=502,
                    detail="Model returned an empty response. Try rephrasing or try again.",
                )
            return response.text
        except errors.ClientError as e:
            if getattr(e, "code", None) == 429:
                # A daily quota cap — retrying with backoff cannot fix this.
                raise HTTPException(
                    status_code=429,
                    detail=DETAIL_QUOTA,
                )
            raise
        except errors.ServerError:
            if attempt < len(delays):
                time.sleep(delays[attempt])
            # On the final attempt we fall through and raise below.

    raise HTTPException(
        status_code=503,
        detail=DETAIL_MODEL_BUSY,
    )


def call_gemini_stream(
    contents: str, max_tokens: int, temperature: float, label: str = "unlabeled"
) -> Iterator[str]:
    """
    Streaming sibling of call_gemini: yields the model's text chunk by chunk
    as it is generated (feeds the client's word-by-word animation).

    Error policy changes at the first byte: retry/backoff (5xx) and the clean
    429 apply only BEFORE the first chunk is yielded. Once text has gone out,
    failures must be handled by the caller (the SSE endpoint turns them into
    a terminal error frame) — you can't un-send half a scene.

    Usage is logged when the stream finishes; the finally block makes that
    best-effort even if the client disconnects mid-stream (whatever usage
    was seen by then, else zeros).

    NOTE: this is a generator — nothing runs until the first iteration, so
    the 429/503 HTTPExceptions surface on first next(), not at call time.
    """
    delays = [1, 2, 4]
    stream = None
    first_chunk = None
    for attempt in range(len(delays) + 1):
        try:
            stream = client.models.generate_content_stream(
                model=MODEL,
                contents=contents,
                config={
                    "max_output_tokens": max_tokens,
                    "temperature": temperature,
                },
            )
            # The SDK stream is lazy: the request actually fires here.
            first_chunk = next(stream, None)
            break
        except errors.ClientError as e:
            if getattr(e, "code", None) == 429:
                raise HTTPException(
                    status_code=429,
                    detail=DETAIL_QUOTA,
                )
            raise
        except errors.ServerError:
            if attempt < len(delays):
                time.sleep(delays[attempt])
            else:
                raise HTTPException(
                    status_code=503,
                    detail=DETAIL_MODEL_BUSY,
                )

    yielded_any = False
    last_usage = None
    try:
        chunk = first_chunk
        while chunk is not None:
            usage = getattr(chunk, "usage_metadata", None)
            if usage is not None:
                last_usage = usage
            if chunk.text:
                yielded_any = True
                yield chunk.text
            chunk = next(stream, None)
    except errors.ServerError:
        # A 5xx after the first byte: can't retry (half a scene is already
        # out), but it must still surface as a clean 503, not a raw SDK
        # error — the finally below still runs to log whatever usage we saw.
        raise HTTPException(
            status_code=503,
            detail=DETAIL_MODEL_BUSY,
        )
    finally:
        try:
            usage_log.log_usage(
                label=label,
                model=MODEL,
                input_tokens=(last_usage.prompt_token_count or 0) if last_usage else 0,
                output_tokens=(last_usage.candidates_token_count or 0) if last_usage else 0,
            )
        except Exception as e:
            # The cost meter must never break the stream it measures.
            print(f"WARNING: usage logging failed: {e}", file=sys.stderr)

    if not yielded_any:
        raise HTTPException(
            status_code=502,
            detail="Model returned an empty response. Try rephrasing or try again.",
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
        max_tokens=600,
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


@app.post("/continue")
def continue_story(req: ContinueRequest):
    """Advance the story one turn: write the scene, update the summary, offer next options."""
    template = get_template_or_404(req.template_id)

    # Call 1 — storyteller (creative): write the scene as pure prose.
    scene = call_gemini(
        build_scene_prompt(template, req),
        max_tokens=SCENE_BUDGETS[req.length],
        temperature=0.9,
        label="scene",
    )

    # Call 2 — scribe (mechanical): fold scene into summary + next options.
    raw = call_gemini(
        build_fold_prompt(req, scene),
        max_tokens=FOLD_BUDGET,
        temperature=0.7,
        label="fold",
    )
    summary, scenarios = validate_turn_payload(raw)
    return {"scene": scene, "summary": summary, "scenarios": scenarios}


def _stream_turn(req: ContinueRequest, template: dict):
    """
    The real streaming turn. Any failure after streaming has begun becomes a
    terminal SSE error frame — the client keeps every token already shown.
    """
    try:
        scene_parts: list[str] = []
        token_iter = call_gemini_stream(
            build_scene_prompt(template, req),
            max_tokens=SCENE_BUDGETS[req.length],
            temperature=0.9,
            label="scene",
        )
        for token in token_iter:
            scene_parts.append(token)
            yield sse_event("scene_token", {"t": token})

        scene = "".join(scene_parts)
        raw = call_gemini(
            build_fold_prompt(req, scene),
            max_tokens=FOLD_BUDGET,
            temperature=0.7,
            label="fold",
        )
        summary, scenarios = validate_turn_payload(raw)
        yield sse_event("turn_complete", {"summary": summary, "scenarios": scenarios})
    except HTTPException as e:
        yield sse_event("error", {"status": e.status_code, "detail": e.detail})
    except Exception as e:
        # Never leak raw exception text to the client — log it server-side
        # for debugging and send a generic, retryable message instead.
        print(f"WARNING: unexpected streaming error: {e!r}", file=sys.stderr)
        yield sse_event(
            "error",
            {"status": 500, "detail": "Something went wrong. Please retry the turn."},
        )


@app.post("/continue/stream")
def continue_story_stream(req: ContinueRequest, mock: bool = False):
    """Streaming twin of /continue: scene tokens as SSE, then the folded turn."""
    # Validation happens BEFORE streaming starts, so it's a normal HTTP error.
    template = get_template_or_404(req.template_id)

    if mock:
        if os.environ.get("DEV_MOCK_ENABLED") != "1":
            raise HTTPException(
                status_code=403,
                detail="Mock mode is disabled. Set DEV_MOCK_ENABLED=1 in .env for development.",
            )
        return StreamingResponse(_stream_mock(req.summary), media_type="text/event-stream")

    return StreamingResponse(_stream_turn(req, template), media_type="text/event-stream")


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
