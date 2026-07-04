# Conversational Co-Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Talk WITH the storyteller, not just at it — a `/converse/stream` channel that silently routes each utterance (pick / steer / discuss / options), streams discussion replies as chat bubbles, and folds agreed canon into carry-it-yourself story notes that future scenes honor.

**Architecture:** Two channels, tiered routing (spec Approach 1). Tier 0: client-side guarded ORDINALS only (`matchCard` loses its word-overlap tier — overlap can't tell "do the iron door one" from "tell me more about the iron door one"). Tier 1: `POST /converse/stream`, ONE fused cheap-model call that emits an `INTENT:` line first, then (discuss only) the reply prose; a second tiny notes-scribe call updates canon. `/continue/stream` stays the only scene writer and gains one additive `notes` field. The Story screen becomes a typed feed (scenes + bubbles + cards); the slice C confirm bar and 1.5s window are REMOVED (owner decision: no confirmation) and a stop control (abort plumbing) becomes the brake.

**Tech Stack:** Existing FastAPI backend (`main.py`, Gemini `gemini-2.5-flash-lite`) + existing Expo SDK 57 client (`client/`). Zero new dependencies.

## Global Constraints

- Spec governs: `docs/superpowers/specs/2026-07-04-conversational-co-creation-design.md`. Owner decisions in it are binding: no confirmation step; unsure → `discuss`; steer passes the utterance VERBATIM (never paraphrased); discussion never advances the turn/beat clock; canonical story = `scenes` array only — bubbles can never enter it.
- Commands: backend `venv/Scripts/python.exe -m pytest tests/ -v` (69 tests now); client (run in `client/`) `npx jest --watchAll=false` (62 tests now) and `npx tsc --noEmit`.
- HARD-WON CLIENT FACTS: `@testing-library/react-native` pinned EXACT `13.3.3` + `react-test-renderer` EXACT `19.2.3` — never change; `client/.npmrc` has legacy-peer-deps; jest-setup Reanimated mock covers ONLY `Animated.Text`/`Animated.View` + `FadeInDown.duration()` — plain RN components for new UI EXCEPT reusing the existing `StreamingText` component; jest `restoreMocks: true` (module-factory `jest.fn()`s persist — clear them in `beforeEach`); mock-factory variables must be `mock`-prefixed (`mockVoiceFake` pattern).
- Deliberate abort stays silent (slice C contract): `streamTurn`/`converse` yield NOTHING on AbortError. A user-tapped stop is never an error.
- SSE conventions (slice A contract): error frames ride HTTP 200 as terminal `error` events; retry/backoff + clean 429 only BEFORE the first forwarded byte; tokens already sent are kept. `sse_event()` frames; user-facing strings via `DETAIL_*` constants.
- Prompt assembly is caching-ordered: static text first, dynamic last. Scene prompt: `STORY_PROMPT` → style → beat → **notes** → summary → direction. Converse prompt: `CONVERSE_PROMPT` → style → notes → summary → options → discussion → utterance. Tests pin ORDER.
- Cost meter: every new Gemini call logs usage — labels `converse` and `notes_fold`. Budgets: `CONVERSE_BUDGET = 600`, `NOTES_BUDGET = 200`, `NOTES_WORDS = 120` (word cap inside the notes prompt).
- Mock modes are gated by `DEV_MOCK_ENABLED=1` (403 otherwise) and make ZERO Gemini calls (conftest tripwire enforces).
- Commits: conventional style + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Push at Task 8.
- SDD ledger: `.superpowers/sdd/progress.md` (append per-task status as established).

---

### Task 1: Converse request model, prompts, and intent-line parsing (pure pieces)

**Files:**
- Modify: `main.py` (new model + constants + 4 pure functions; no endpoint yet)
- Create: `tests/test_converse.py`

**Interfaces:**
- Produces (Task 2 consumes): `ConverseRequest` (pydantic: `template_id, utterance, summary, notes="", options=[], discussion=[], turn=1, length="short"`); `build_converse_prompt(template: dict, req: ConverseRequest) -> str`; `build_notes_prompt(notes: str, utterance: str, reply: str) -> str`; `parse_intent_line(line: str, options_count: int) -> tuple[str, int | None]` returning `("discuss"|"steer"|"options"|"pick"|"pick_invalid", index)` where `index` is 0-based and set only for in-range picks; `pick_clarification(options_count: int) -> str`; `parse_notes(raw_text: str) -> str`; constants `CONVERSE_PROMPT`, `NOTES_PROMPT`, `CONVERSE_BUDGET = 600`, `NOTES_BUDGET = 200`, `NOTES_WORDS = 120`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_converse.py`:

```python
"""
Tests for the /converse/stream channel (conversational co-creation).

parse_sse and the TestClient are duplicated from tests/test_api.py on purpose
(tests aren't a package; sharing via conftest is a Phase-3-split cleanup that
rides). Gemini is never called — conftest's tripwire enforces it.
"""

import json

import pytest
from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


def parse_sse(text: str) -> list[dict]:
    """Split an SSE body into [{'event': name, 'data': parsed_json}, ...]."""
    events = []
    for block in text.strip().split("\n\n"):
        event, data = "", "{}"
        for line in block.split("\n"):
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = line[6:]
        events.append({"event": event, "data": json.loads(data)})
    return events


CONVERSE_BODY = {
    "template_id": "fantasy",
    "utterance": "tell me more about her",
    "summary": "Mira stands at the iron door.",
    "notes": "",
    "options": ["Force the door", "Ask the voice", "Run away"],
    "discussion": [],
}


# --- parse_intent_line -------------------------------------------------------

def test_intent_discuss():
    assert main.parse_intent_line("INTENT: discuss", 3) == ("discuss", None)


def test_intent_steer():
    assert main.parse_intent_line("INTENT: steer", 3) == ("steer", None)


def test_intent_options():
    assert main.parse_intent_line("INTENT: options", 3) == ("options", None)


def test_intent_pick_is_one_based_in_zero_based_out():
    assert main.parse_intent_line("INTENT: pick 2", 3) == ("pick", 1)


def test_intent_pick_tolerates_case_and_whitespace():
    assert main.parse_intent_line("  intent: PICK 3 ", 3) == ("pick", 2)


def test_intent_pick_out_of_range_downgrades():
    assert main.parse_intent_line("INTENT: pick 5", 3) == ("pick_invalid", None)


def test_intent_pick_missing_number_downgrades():
    assert main.parse_intent_line("INTENT: pick", 3) == ("pick_invalid", None)


def test_intent_garbage_raises_502():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        main.parse_intent_line("Once upon a time", 3)
    assert exc.value.status_code == 502


# --- pick_clarification ------------------------------------------------------

def test_pick_clarification_counts_the_cards():
    assert "3" in main.pick_clarification(3)


def test_pick_clarification_handles_no_cards():
    msg = main.pick_clarification(0)
    assert "no option cards" in msg.lower()


# --- parse_notes -------------------------------------------------------------

def test_parse_notes_happy_path():
    assert main.parse_notes('{"notes": "Mira is stubborn."}') == "Mira is stubborn."


def test_parse_notes_missing_key_is_502():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        main.parse_notes('{"wrong": "shape"}')
    assert exc.value.status_code == 502


# --- prompt builders ---------------------------------------------------------

def test_converse_prompt_order_static_style_notes_summary_options_discussion_utterance():
    req = main.ConverseRequest(
        **dict(
            CONVERSE_BODY,
            notes="Mira fears fire.",
            discussion=[
                {"role": "user", "text": "who is she?"},
                {"role": "ai", "text": "A mapmaker."},
            ],
        )
    )
    template = main.TEMPLATES["fantasy"]
    prompt = main.build_converse_prompt(template, req)

    i_static = prompt.index(main.CONVERSE_PROMPT[:40])
    i_style = prompt.index(template["style"][:40])
    i_notes = prompt.index("Mira fears fire.")
    i_summary = prompt.index("Mira stands at the iron door.")
    i_options = prompt.index("1. Force the door")
    i_discussion = prompt.index("who is she?")
    i_utterance = prompt.index("tell me more about her")
    assert i_static < i_style < i_notes < i_summary < i_options < i_discussion < i_utterance
    assert "2. Ask the voice" in prompt and "3. Run away" in prompt


def test_converse_prompt_placeholders_for_empty_context():
    req = main.ConverseRequest(**dict(CONVERSE_BODY, options=[], discussion=[]))
    prompt = main.build_converse_prompt(main.TEMPLATES["fantasy"], req)
    assert "(none offered yet)" in prompt
    assert "(no discussion yet)" in prompt


def test_notes_prompt_carries_word_limit_and_pieces():
    prompt = main.build_notes_prompt("Old fact.", "who is she?", "A stubborn mapmaker.")
    assert prompt.index(main.NOTES_PROMPT[:40]) == 0
    assert f"{main.NOTES_WORDS} words" in prompt
    assert "Old fact." in prompt
    assert "who is she?" in prompt
    assert "A stubborn mapmaker." in prompt
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_converse.py -v`
Expected: FAIL — `AttributeError: module 'main' has no attribute 'parse_intent_line'` (etc.).

- [ ] **Step 3: Implement**

In `main.py`, add after the `ContinueRequest` class:

```python
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
```

Add after `FOLD_PROMPT` (constants + prompts):

```python
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
```

Add after `build_fold_prompt` (builders + parsers):

```python
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
```

- [ ] **Step 4: Run tests + full suite**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (69 + 16 = 85), no existing test disturbed.

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_converse.py
git commit -m "feat: converse request model, fused-router prompts, intent-line parsing"
```

---

### Task 2: `POST /converse/stream` — the real path

**Files:**
- Modify: `main.py` (`_stream_converse` generator + endpoint)
- Test: `tests/test_converse.py`

**Interfaces:**
- Consumes: everything Task 1 produced; `call_gemini_stream`, `call_gemini`, `sse_event`, `parse_scenarios`, `get_template_or_404`.
- Produces (client Tasks 5/7 rely on these frames): `reply_token` `{"t": str}` → `discussion_complete` `{"notes": str}` for discuss; single `route` frame `{"intent": "pick", "index": int(0-based)}` / `{"intent": "steer"}` / `{"intent": "options", "scenarios": [str, str, str]}`; terminal `error` `{"status": int, "detail": str}` on any failure. Usage labels `converse` / `notes_fold`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_converse.py`:

```python
# --- /converse/stream real path ---------------------------------------------

def test_converse_discuss_streams_reply_then_folds_notes(monkeypatch):
    def fake_stream(contents, **kwargs):
        assert kwargs["label"] == "converse"
        assert kwargs["max_tokens"] == main.CONVERSE_BUDGET
        # Intent line and the reply's first words arrive in ONE chunk — the
        # endpoint must forward only what follows the newline.
        yield "INTENT: discuss\nShe is "
        yield "stubborn."

    captured = {}

    def fake_notes(contents, **kw):
        captured["label"] = kw.get("label")
        captured["max_tokens"] = kw.get("max_tokens")
        assert "She is stubborn." in contents  # the reply reaches the scribe
        assert "tell me more about her" in contents  # so does the utterance
        return '{"notes": "Mira is stubborn."}'

    monkeypatch.setattr(main, "call_gemini_stream", fake_stream)
    monkeypatch.setattr(main, "call_gemini", fake_notes)

    resp = client.post("/converse/stream", json=CONVERSE_BODY)
    assert resp.status_code == 200
    events = parse_sse(resp.text)
    assert [e["event"] for e in events] == [
        "reply_token",
        "reply_token",
        "discussion_complete",
    ]
    assert "".join(e["data"]["t"] for e in events[:2]) == "She is stubborn."
    assert events[-1]["data"] == {"notes": "Mira is stubborn."}
    assert captured == {"label": "notes_fold", "max_tokens": main.NOTES_BUDGET}


def test_converse_pick_routes_zero_based(monkeypatch):
    monkeypatch.setattr(
        main, "call_gemini_stream", lambda c, **kw: iter(["INTENT: pick 2\n"])
    )
    resp = client.post("/converse/stream", json=CONVERSE_BODY)
    events = parse_sse(resp.text)
    assert events == [{"event": "route", "data": {"intent": "pick", "index": 1}}]


def test_converse_steer_routes(monkeypatch):
    monkeypatch.setattr(
        main, "call_gemini_stream", lambda c, **kw: iter(["INTENT: steer"])
    )
    resp = client.post("/converse/stream", json=CONVERSE_BODY)
    events = parse_sse(resp.text)
    assert events == [{"event": "route", "data": {"intent": "steer"}}]


def test_converse_options_routes_fresh_scenarios(monkeypatch):
    def fake_stream(contents, **kwargs):
        yield "INTENT: options\n"
        yield '{"scenarios": ["New A", '
        yield '"New B", "New C"]}'

    monkeypatch.setattr(main, "call_gemini_stream", fake_stream)
    resp = client.post("/converse/stream", json=CONVERSE_BODY)
    events = parse_sse(resp.text)
    assert events == [
        {
            "event": "route",
            "data": {"intent": "options", "scenarios": ["New A", "New B", "New C"]},
        }
    ]


def test_converse_options_empty_scenarios_is_error_frame(monkeypatch):
    monkeypatch.setattr(
        main,
        "call_gemini_stream",
        lambda c, **kw: iter(['INTENT: options\n{"scenarios": []}']),
    )
    resp = client.post("/converse/stream", json=CONVERSE_BODY)
    events = parse_sse(resp.text)
    assert events[-1]["event"] == "error"
    assert events[-1]["data"]["status"] == 502


def test_converse_invalid_pick_gets_fixed_clarification(monkeypatch):
    monkeypatch.setattr(
        main, "call_gemini_stream", lambda c, **kw: iter(["INTENT: pick 7\n"])
    )
    resp = client.post("/converse/stream", json=CONVERSE_BODY)
    events = parse_sse(resp.text)
    assert [e["event"] for e in events] == ["reply_token", "discussion_complete"]
    assert events[0]["data"]["t"] == main.pick_clarification(3)
    # Notes unchanged, no scribe call was needed (call_gemini is unmocked:
    # the conftest tripwire proves it was never reached).
    assert events[-1]["data"] == {"notes": CONVERSE_BODY["notes"]}


def test_converse_garbage_intent_line_is_error_frame(monkeypatch):
    monkeypatch.setattr(
        main, "call_gemini_stream", lambda c, **kw: iter(["Once upon a time\nmore"])
    )
    resp = client.post("/converse/stream", json=CONVERSE_BODY)
    events = parse_sse(resp.text)
    assert events[-1]["event"] == "error"
    assert events[-1]["data"]["status"] == 502


def test_converse_notes_scribe_garbage_keeps_reply_tokens(monkeypatch):
    monkeypatch.setattr(
        main,
        "call_gemini_stream",
        lambda c, **kw: iter(["INTENT: discuss\nHere is a reply."]),
    )
    monkeypatch.setattr(main, "call_gemini", lambda c, **kw: "not json")
    resp = client.post("/converse/stream", json=CONVERSE_BODY)
    events = parse_sse(resp.text)
    assert events[0] == {"event": "reply_token", "data": {"t": "Here is a reply."}}
    assert events[-1]["event"] == "error"
    assert events[-1]["data"]["status"] == 502


def test_converse_midstream_failure_becomes_error_frame(monkeypatch):
    from fastapi import HTTPException

    def dies_mid_reply(contents, **kwargs):
        yield "INTENT: discuss\nFirst words "
        raise HTTPException(status_code=503, detail="model went away")

    monkeypatch.setattr(main, "call_gemini_stream", dies_mid_reply)
    resp = client.post("/converse/stream", json=CONVERSE_BODY)
    events = parse_sse(resp.text)
    assert events[0] == {"event": "reply_token", "data": {"t": "First words "}}
    assert events[-1]["event"] == "error"
    assert events[-1]["data"]["status"] == 503


def test_converse_unknown_template_is_404_before_streaming():
    resp = client.post(
        "/converse/stream", json=dict(CONVERSE_BODY, template_id="nope")
    )
    assert resp.status_code == 404


def test_converse_missing_utterance_is_422():
    body = dict(CONVERSE_BODY)
    del body["utterance"]
    resp = client.post("/converse/stream", json=body)
    assert resp.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_converse.py -v`
Expected: the new tests FAIL with 404 (route `/converse/stream` doesn't exist).

- [ ] **Step 3: Implement**

In `main.py`, add after `_stream_turn` (before `/continue/stream`):

```python
def _stream_converse(req: ConverseRequest, template: dict):
    """
    The conversational channel. ONE fused call: first line = intent verdict,
    then (discuss only) the reply prose. Same failure contract as
    _stream_turn: anything after streaming begins becomes a terminal error
    frame; tokens already forwarded are kept.
    """
    try:
        token_iter = call_gemini_stream(
            build_converse_prompt(template, req),
            max_tokens=CONVERSE_BUDGET,
            temperature=0.8,
            label="converse",
        )

        # Consume until the first newline: that's the whole intent line.
        # (pick/steer outputs may be a single line with no newline at all.)
        buffer = ""
        for token in token_iter:
            buffer += token
            if "\n" in buffer:
                break
        if "\n" in buffer:
            first_line, rest = buffer.split("\n", 1)
        else:
            first_line, rest = buffer, ""

        intent, index = parse_intent_line(first_line, len(req.options))

        if intent == "pick":
            yield sse_event("route", {"intent": "pick", "index": index})
            return
        if intent == "steer":
            yield sse_event("route", {"intent": "steer"})
            return
        if intent == "options":
            remainder = rest + "".join(token_iter)
            scenarios = parse_scenarios(remainder)
            if not scenarios:
                raise HTTPException(
                    status_code=502,
                    detail="Model returned zero fresh options. Please retry.",
                )
            yield sse_event("route", {"intent": "options", "scenarios": scenarios})
            return
        if intent == "pick_invalid":
            # Fixed clarification: deterministic, no extra model call, notes
            # unchanged — never a 500 and never a blind turn (spec).
            yield sse_event("reply_token", {"t": pick_clarification(len(req.options))})
            yield sse_event("discussion_complete", {"notes": req.notes})
            return

        # discuss: forward the reply as it streams, then fold the notes.
        reply_parts: list[str] = []
        if rest:
            reply_parts.append(rest)
            yield sse_event("reply_token", {"t": rest})
        for token in token_iter:
            reply_parts.append(token)
            yield sse_event("reply_token", {"t": token})

        reply = "".join(reply_parts).strip()
        raw = call_gemini(
            build_notes_prompt(req.notes, req.utterance, reply),
            max_tokens=NOTES_BUDGET,
            temperature=0.7,
            label="notes_fold",
        )
        yield sse_event("discussion_complete", {"notes": parse_notes(raw)})
    except HTTPException as e:
        yield sse_event("error", {"status": e.status_code, "detail": e.detail})
    except Exception as e:
        print(f"WARNING: unexpected converse streaming error: {e!r}", file=sys.stderr)
        yield sse_event(
            "error",
            {"status": 500, "detail": "Something went wrong. Please retry."},
        )


@app.post("/converse/stream")
def converse_stream(req: ConverseRequest, mock: bool = False):
    """The discussion channel: route the utterance, stream the reply. Never writes scenes."""
    template = get_template_or_404(req.template_id)

    if mock:
        if os.environ.get("DEV_MOCK_ENABLED") != "1":
            raise HTTPException(
                status_code=403,
                detail="Mock mode is disabled. Set DEV_MOCK_ENABLED=1 in .env for development.",
            )
        return StreamingResponse(
            _stream_converse_mock(req), media_type="text/event-stream"
        )

    return StreamingResponse(
        _stream_converse(req, template), media_type="text/event-stream"
    )
```

For THIS task only, add a stub so the module imports (Task 3 replaces it):

```python
def _stream_converse_mock(req: ConverseRequest):
    """Task 3 implements the canned mock; until then mock mode yields an error frame."""
    yield sse_event("error", {"status": 500, "detail": "Mock not implemented yet."})
```

- [ ] **Step 4: Run the full backend suite**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (85 + 11 = 96).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_converse.py
git commit -m "feat: /converse/stream - fused intent routing, streamed replies, notes scribe"
```

---

### Task 3: `/converse/stream` mock mode

**Files:**
- Modify: `main.py` (replace the `_stream_converse_mock` stub)
- Test: `tests/test_converse.py`

**Interfaces:**
- Produces: deterministic, utterance-triggered canned behavior for client dev — "idea"/"option" in the utterance → `route options` (reuses `MOCK_TURNS[0]["scenarios"]`); utterance starting with `she `/`he `/`they ` → `route steer`; anything else → a canned discuss reply streamed word-by-word + `discussion_complete` with canned notes. Zero Gemini calls.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_converse.py`:

```python
# --- /converse/stream mock mode ----------------------------------------------

def test_converse_mock_403_when_env_unset(monkeypatch):
    monkeypatch.delenv("DEV_MOCK_ENABLED", raising=False)
    resp = client.post("/converse/stream?mock=true", json=CONVERSE_BODY)
    assert resp.status_code == 403


def test_converse_mock_discuss_streams_canned_reply(monkeypatch):
    monkeypatch.setenv("DEV_MOCK_ENABLED", "1")
    monkeypatch.setattr(main.time, "sleep", lambda s: None)
    resp = client.post("/converse/stream?mock=true", json=CONVERSE_BODY)
    events = parse_sse(resp.text)
    assert events[-1]["event"] == "discussion_complete"
    reply = "".join(e["data"]["t"] for e in events[:-1])
    assert reply == main.MOCK_CONVERSE_REPLY
    assert events[-1]["data"] == {"notes": main.MOCK_CONVERSE_NOTES}


def test_converse_mock_options_trigger(monkeypatch):
    monkeypatch.setenv("DEV_MOCK_ENABLED", "1")
    resp = client.post(
        "/converse/stream?mock=true",
        json=dict(CONVERSE_BODY, utterance="give me different ideas"),
    )
    events = parse_sse(resp.text)
    assert events == [
        {
            "event": "route",
            "data": {
                "intent": "options",
                "scenarios": main.MOCK_TURNS[0]["scenarios"],
            },
        }
    ]


def test_converse_mock_steer_trigger(monkeypatch):
    monkeypatch.setenv("DEV_MOCK_ENABLED", "1")
    resp = client.post(
        "/converse/stream?mock=true",
        json=dict(CONVERSE_BODY, utterance="she burns the letter and runs"),
    )
    events = parse_sse(resp.text)
    assert events == [{"event": "route", "data": {"intent": "steer"}}]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_converse.py -v`
Expected: the mock tests FAIL (stub yields an error frame; constants missing).

- [ ] **Step 3: Implement**

In `main.py`, replace the Task 2 stub with (placed next to the existing mock block, after `_stream_mock`):

```python
# Canned converse behavior, utterance-triggered so every client path is
# demoable offline: "idea"/"option" -> fresh options; a third-person sentence
# ("she/he/they ...") -> steer; anything else -> a canned discussion reply.
# Deterministic, zero Gemini calls (the conftest tripwire enforces it).
MOCK_CONVERSE_REPLY = (
    "Mira is stubborn the way lighthouse keepers are stubborn — she trusts "
    "her own light first. We could decide what she lost the year she started "
    "correcting maps. What feels true to you?"
)
MOCK_CONVERSE_NOTES = (
    "Mira is a stubborn apprentice mapmaker who trusts her own judgment and "
    "compulsively corrects wrong maps."
)


def _stream_converse_mock(req: ConverseRequest):
    """Canned converse turn, chosen by simple utterance triggers (see above)."""
    lowered = req.utterance.lower()
    if "idea" in lowered or "option" in lowered:
        yield sse_event(
            "route",
            {"intent": "options", "scenarios": MOCK_TURNS[0]["scenarios"]},
        )
        return
    if lowered.startswith(("she ", "he ", "they ")):
        yield sse_event("route", {"intent": "steer"})
        return

    words = MOCK_CONVERSE_REPLY.split(" ")
    for i, word in enumerate(words):
        token = word if i == len(words) - 1 else word + " "
        yield sse_event("reply_token", {"t": token})
        time.sleep(0.03)  # realistic pacing for animation work; patched in tests
    yield sse_event("discussion_complete", {"notes": MOCK_CONVERSE_NOTES})
```

(Delete the Task 2 stub version of `_stream_converse_mock` entirely.)

- [ ] **Step 4: Run the full backend suite**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (96 + 4 = 100).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_converse.py
git commit -m "feat: converse mock mode - canned discuss/options/steer, zero Gemini calls"
```

---

### Task 4: `notes` rides into the scene prompt (`/continue` + `/continue/stream`)

**Files:**
- Modify: `main.py` (`ContinueRequest` + `build_scene_prompt`)
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ContinueRequest.notes: str = ""` (additive; old callers unchanged). Scene prompt order becomes `STORY_PROMPT` → style → beat → notes → summary → direction; empty notes → byte-identical prompt to today. Client Task 5 adds `notes` to `TurnRequest`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_api.py` (near the existing `build_scene_prompt` tests):

```python
def test_scene_prompt_slots_notes_between_beat_and_summary():
    req = main.ContinueRequest(
        template_id="noir",
        summary="The detective has the envelope.",
        chosen_scenario="Open it now.",
        turn=1,
        length="short",
        notes="The mayor's aide is secretly his sister.",
    )
    template = main.TEMPLATES["noir"]
    prompt = main.build_scene_prompt(template, req)

    i_notes = prompt.index("The mayor's aide is secretly his sister.")
    i_summary = prompt.index("The detective has the envelope.")
    i_beat = prompt.index("Current story beat:")
    assert i_beat < i_notes < i_summary
    assert "Established story notes (canon):" in prompt


def test_scene_prompt_without_notes_is_unchanged_from_today():
    kwargs = dict(
        template_id="noir",
        summary="s",
        chosen_scenario="c",
        turn=1,
        length="short",
    )
    template = main.TEMPLATES["noir"]
    with_default = main.build_scene_prompt(template, main.ContinueRequest(**kwargs))
    explicit_empty = main.build_scene_prompt(
        template, main.ContinueRequest(**kwargs, notes="")
    )
    assert with_default == explicit_empty
    assert "story notes" not in with_default  # no empty block injected


def test_stream_turn_accepts_and_uses_notes(monkeypatch):
    captured = {}

    def fake_stream(contents, **kwargs):
        captured["prompt"] = contents
        yield "scene text"

    monkeypatch.setattr(main, "call_gemini_stream", fake_stream)
    monkeypatch.setattr(
        main,
        "call_gemini",
        lambda contents, **kw: '{"summary": "s", "scenarios": ["a", "b", "c"]}',
    )

    resp = client.post(
        "/continue/stream", json=dict(CONTINUE_BODY, notes="Mira fears fire.")
    )
    assert resp.status_code == 200
    assert "Mira fears fire." in captured["prompt"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_api.py -v`
Expected: FAIL — `ContinueRequest` has no field `notes` (validation error / TypeError).

- [ ] **Step 3: Implement**

In `main.py`, add the field to `ContinueRequest`:

```python
class ContinueRequest(BaseModel):
    template_id: str
    summary: str
    chosen_scenario: str
    turn: int = Field(1, ge=1)
    length: Literal["short", "medium", "long"] = "short"
    notes: str = ""  # canon from the discussion channel; empty = pre-converse behavior
```

Change `build_scene_prompt` to:

```python
def build_scene_prompt(template: dict, req: ContinueRequest) -> str:
    """Assemble the storyteller prompt: static -> style -> beat -> notes -> dynamic."""
    beats = story_beats.select_beats(template.get("structure"), req.turn, req.length)
    beat_block = ""
    if beats:
        current, _ = beats
        beat_block = f"\n\nCurrent story beat: {current['name']} — {current['guidance']}"
    notes_block = (
        f"\n\nEstablished story notes (canon):\n{req.notes}" if req.notes else ""
    )
    return (
        f"{STORY_PROMPT}\n\nGenre style:\n{template['style']}{beat_block}{notes_block}\n\n"
        f"Story so far:\n{req.summary}\n\n"
        f"Chosen direction:\n{req.chosen_scenario}"
    )
```

- [ ] **Step 4: Run the full backend suite**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (100 + 3 = 103). Every pre-existing prompt/order test still green (empty notes injects nothing).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_api.py
git commit -m "feat: scene prompt honors story notes (canon) - additive, back-compatible"
```

---

### Task 5: Client streaming bridge — new SSE events + `converse()`

**Files:**
- Modify: `client/lib/sse.ts` (StreamEvent union + parseBlock)
- Modify: `client/lib/api.ts` (shared `streamPost` + `converse()` + types)
- Test: `client/lib/__tests__/sse.test.ts`, `client/lib/__tests__/api.test.ts`

**Interfaces:**
- Produces (Task 7 consumes):

```ts
// sse.ts additions to the StreamEvent union:
export type StreamEvent =
  | { type: "token"; t: string }
  | { type: "turn_complete"; summary: string; scenarios: string[] }
  | { type: "reply_token"; t: string }
  | { type: "discussion_complete"; notes: string }
  | { type: "route"; intent: "pick"; index: number }
  | { type: "route"; intent: "steer" }
  | { type: "route"; intent: "options"; scenarios: string[] }
  | { type: "stream_error"; status: number; detail: string };

// api.ts:
export type DiscussionEntry = { role: "user" | "ai"; text: string };
export type ConverseRequest = {
  template_id: string;
  utterance: string;
  summary: string;
  notes: string;
  options: string[];
  discussion: DiscussionEntry[];
  turn: number;
  length: StoryLength;
};
export type TurnRequest = { /* existing fields */; notes?: string };
export function converse(body: ConverseRequest, opts?: { signal?: AbortSignal }): AsyncGenerator<StreamEvent>;
// streamTurn signature unchanged; both now delegate to one private streamPost().
```

- [ ] **Step 1: Write the failing tests**

Add to `client/lib/__tests__/sse.test.ts`:

```ts
describe("converse frames", () => {
  it("parses reply_token", () => {
    const p = new SSEParser();
    expect(p.feed('event: reply_token\ndata: {"t": "She is "}\n\n')).toEqual([
      { type: "reply_token", t: "She is " },
    ]);
  });

  it("parses discussion_complete", () => {
    const p = new SSEParser();
    expect(
      p.feed('event: discussion_complete\ndata: {"notes": "Mira is stubborn."}\n\n')
    ).toEqual([{ type: "discussion_complete", notes: "Mira is stubborn." }]);
  });

  it("parses the three route intents", () => {
    const p = new SSEParser();
    expect(
      p.feed('event: route\ndata: {"intent": "pick", "index": 1}\n\n')
    ).toEqual([{ type: "route", intent: "pick", index: 1 }]);
    expect(p.feed('event: route\ndata: {"intent": "steer"}\n\n')).toEqual([
      { type: "route", intent: "steer" },
    ]);
    expect(
      p.feed('event: route\ndata: {"intent": "options", "scenarios": ["A", "B"]}\n\n')
    ).toEqual([{ type: "route", intent: "options", scenarios: ["A", "B"] }]);
  });

  it("unknown route intent becomes a stream_error, not a silent ignore", () => {
    const p = new SSEParser();
    expect(p.feed('event: route\ndata: {"intent": "dance"}\n\n')).toEqual([
      { type: "stream_error", status: 500, detail: "Malformed stream frame." },
    ]);
  });
});
```

Add to `client/lib/__tests__/api.test.ts` (reusing its existing fake-response helpers/patterns):

```ts
describe("converse", () => {
  const CONVERSE_REQ = {
    template_id: "fantasy",
    utterance: "tell me more",
    summary: "s",
    notes: "",
    options: ["A", "B", "C"],
    discussion: [],
    turn: 2,
    length: "short" as const,
  };

  it("POSTs to /converse/stream and yields parsed frames", async () => {
    const body =
      'event: reply_token\ndata: {"t": "Hi."}\n\n' +
      'event: discussion_complete\ndata: {"notes": "n1"}\n\n';
    const fakeRes = {
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: () => {
              if (done) return Promise.resolve({ done: true, value: undefined });
              done = true;
              return Promise.resolve({
                done: false,
                value: new TextEncoder().encode(body),
              });
            },
            cancel: jest.fn(() => Promise.resolve()),
          };
        },
      },
    } as unknown as Response;
    const spy = jest
      .spyOn(require("../fetch"), "streamingFetch")
      .mockResolvedValue(fakeRes);

    const events = [];
    for await (const ev of converse(CONVERSE_REQ)) events.push(ev);
    expect(events).toEqual([
      { type: "reply_token", t: "Hi." },
      { type: "discussion_complete", notes: "n1" },
    ]);
    expect(String(spy.mock.calls[0][0])).toContain("/converse/stream");
    expect(JSON.parse(spy.mock.calls[0][1].body as string)).toEqual(CONVERSE_REQ);
  });

  it("shares streamTurn's single error channel (network failure -> status 0)", async () => {
    jest
      .spyOn(require("../fetch"), "streamingFetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const events = [];
    for await (const ev of converse(CONVERSE_REQ)) events.push(ev);
    expect(events).toEqual([
      {
        type: "stream_error",
        status: 0,
        detail: "Can't reach the storyteller. Is the backend running?",
      },
    ]);
  });

  it("ends silently on a deliberate abort", async () => {
    const abortErr = new Error("Aborted");
    abortErr.name = "AbortError";
    jest.spyOn(require("../fetch"), "streamingFetch").mockRejectedValue(abortErr);
    const events = [];
    for await (const ev of converse(CONVERSE_REQ)) events.push(ev);
    expect(events).toEqual([]);
  });
});
```

(`converse` must be added to the file's imports from `../api`.)

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false`
Expected: FAIL — sse.test on the new frame shapes; api.test with `converse is not a function`.

- [ ] **Step 3: Implement**

`client/lib/sse.ts` — replace the `StreamEvent` type with the union in **Interfaces** above, and add to `parseBlock` before the `return null`:

```ts
  if (event === "reply_token")
    return { type: "reply_token", t: String(payload.t ?? "") };
  if (event === "discussion_complete")
    return { type: "discussion_complete", notes: String(payload.notes ?? "") };
  if (event === "route") {
    if (payload.intent === "pick")
      return { type: "route", intent: "pick", index: Number(payload.index ?? -1) };
    if (payload.intent === "steer") return { type: "route", intent: "steer" };
    if (payload.intent === "options")
      return {
        type: "route",
        intent: "options",
        scenarios: Array.isArray(payload.scenarios)
          ? payload.scenarios.map(String)
          : [],
      };
    // A route frame we can't act on is a broken contract, not forward-compat.
    return { type: "stream_error", status: 500, detail: "Malformed stream frame." };
  }
```

`client/lib/api.ts` — add types (`DiscussionEntry`, `ConverseRequest` per **Interfaces**; add `notes?: string` to `TurnRequest`), then refactor `streamTurn`'s body into a shared private generator and add `converse`:

```ts
async function* streamPost(
  url: string,
  body: unknown,
  opts?: { signal?: AbortSignal }
): AsyncGenerator<StreamEvent> {
  // ... the ENTIRE current body of streamTurn, verbatim, with its
  // hardcoded `url` line removed (url is now the parameter) ...
}

export function streamTurn(
  body: TurnRequest,
  opts?: { signal?: AbortSignal }
): AsyncGenerator<StreamEvent> {
  return streamPost(
    `${API_URL}/continue/stream${USE_MOCK ? "?mock=true" : ""}`,
    body,
    opts
  );
}

export function converse(
  body: ConverseRequest,
  opts?: { signal?: AbortSignal }
): AsyncGenerator<StreamEvent> {
  return streamPost(
    `${API_URL}/converse/stream${USE_MOCK ? "?mock=true" : ""}`,
    body,
    opts
  );
}
```

The refactor is mechanical: `streamTurn`'s current implementation moves into `streamPost` unchanged (same abort semantics, same error channel, same `reader?.cancel()?.catch?.()` release); the two exported functions are thin URL binders. Every existing `streamTurn` test must pass unmodified — they pin the shared behavior.

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: ALL PASS (62 + 7 = 69), types clean.

- [ ] **Step 5: Commit**

```bash
git add client/lib
git commit -m "feat(client): converse() stream + reply/route/discussion SSE frames"
```

---

### Task 6: `matchCard` slims to guarded ordinals only

**Files:**
- Modify: `client/lib/matchCard.ts`
- Test: `client/lib/__tests__/matchCard.test.ts`

**Interfaces:**
- Produces: `matchCard(utterance: string, cards: string[]): number | null` — same signature, ordinals-only semantics. Content-referencing utterances now return `null` (they route to `/converse`, which can pick, steer, or discuss them with actual understanding).

- [ ] **Step 1: Update the tests first**

In `client/lib/__tests__/matchCard.test.ts`: DELETE the entire `describe("matchCard - word overlap", ...)` block, and add in its place:

```ts
describe("matchCard - content references are not fast-path picks", () => {
  it.each([
    ["she forces the iron door open"],
    ["tell me more about the iron door one"],
    ["follow the footsteps in the corridor"],
    ["the door"],
    ["blorp fizzle"],
    [""],
    ["   "],
  ])("%s -> null (routes to /converse)", (utterance) => {
    expect(matchCard(utterance, CARDS)).toBeNull();
  });
});
```

Keep the ordinal describe block (all its cases, including "the last one", out-of-bounds, empty-cards "last", and the guard counterexamples) unchanged.

- [ ] **Step 2: Run tests to verify the new expectations fail**

Run (in `client/`): `npx jest --watchAll=false lib/__tests__/matchCard.test.ts`
Expected: `"she forces the iron door open"` and `"follow the footsteps in the corridor"` FAIL (the overlap tier still matches them).

- [ ] **Step 3: Implement**

Replace `client/lib/matchCard.ts` with:

```ts
/**
 * matchCard — the FREE fast-path of utterance routing: does this utterance
 * unambiguously pick a card by ordinal? ("the second one", "option 3",
 * "the last one"). Anything else returns null and routes to /converse,
 * where a model decides pick / steer / discuss / options with context.
 *
 * The old word-overlap tier was retired when the discussion channel arrived:
 * overlap can't tell "do the iron door one" (a pick) from "tell me more
 * about the iron door one" (a question), and auto-picking a question is the
 * exact rigidity the conversational redesign removes.
 *
 * Ordinals only fire when the utterance looks like a pick — short (<= 4
 * words) OR containing a pick-verb/noun — because bare words like "first"
 * and "two" appear constantly in narrative sentences. Checked
 * most-specific-first: "the second one" must hit "second", not "one".
 */

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(fourth|four|4)\b/, 3],
  [/\b(third|three|3)\b/, 2],
  [/\b(second|two|2)\b/, 1],
  [/\b(first|one|1)\b/, 0],
];

const PICK_WORDS = /\b(pick|take|choose|select|option|number|card|go with)\b/;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function matchCard(utterance: string, cards: string[]): number | null {
  const text = normalize(utterance);
  if (!text) return null;

  const wordCount = text.split(" ").length;
  const looksLikeAPick = wordCount <= 4 || PICK_WORDS.test(text);
  if (!looksLikeAPick) return null;

  if (/\blast\b/.test(text)) return cards.length > 0 ? cards.length - 1 : null;
  for (const [re, idx] of ORDINALS) {
    if (re.test(text)) {
      return idx < cards.length ? idx : null;
    }
  }
  return null;
}
```

(`STOPWORDS`, `contentWords`, and the scoring loop are deleted with the tier.)

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: ALL PASS. Count change: the overlap describe removed 4 tests, the new null-routing block adds 7 → 69 + 3 = 72... run and report the actual total; the requirement is every remaining test green. Story tests are unaffected (their free-form fixture "she sets fire to the archive and flees north" already returned null under the overlap tier).

- [ ] **Step 5: Commit**

```bash
git add client/lib
git commit -m "refactor(client): matchCard slims to guarded ordinals - content refs route to converse"
```

---

### Task 7: The Story screen becomes a conversation (feed + bubbles + routing)

**Files:**
- Modify: `client/app/story.tsx` (feed model, converse wiring, confirm-bar REMOVAL, stop control)
- Test: `client/app/__tests__/story.test.tsx`

**Interfaces:**
- Consumes: `converse`/`ConverseRequest`/`DiscussionEntry` and `TurnRequest.notes` (Task 5), ordinals-only `matchCard` (Task 6), backend frames (Task 2), `PushToTalk` (unchanged), `StreamingText` (unchanged).
- Produces: the shipped UX. No component API changes for other files.

**Binding behavior:**
- `FeedItem` union: `{kind:"scene",text}` | `{kind:"user_bubble",text}` | `{kind:"ai_bubble",text}` | `{kind:"cards",options}`. Feed renders in order; `scenes: string[]` REMAINS the canonical story and the turn clock (`scenes.length + 1`) — updated together with the feed on `turn_complete`.
- Confirm bar, `ConfirmPending`, `confirmTimeoutRef`, `cancelConfirm`, the 1.5s window: DELETED. `handleUtterance` becomes: ordinal match → `handleChoose(options[idx])` immediately; else → `runConverse(utterance)`.
- `runConverse`: shares the `streamingRef` guard + `abortRef` + `isStreaming` with `runTurn` (one busy flag). Appends a `user_bubble` + pushes `{role:"user"}` onto the discussion tail immediately. Streams `reply_token` into a bubble-styled `StreamingText`; on `discussion_complete` archives the `ai_bubble`, pushes `{role:"ai"}` onto the tail (tail capped at 6 entries with `.slice(-6)`), stores `notes`. A `route` frame is captured and acted on AFTER the loop + guard release: pick → `handleChoose(options[index])`; steer → `handleChoose(utterance)` (verbatim); options → replace the trailing cards feed item + `setOptions`. `stream_error` → the existing error banner.
- On abort mid-reply (stop button/unmount): archive the partial bubble in the `finally` (if non-empty); notes unchanged; NO error.
- `runTurn` changes: request gains `notes`; on start it REMOVES any `cards` item from the feed (an offer is consumed by the next turn) — `setFeed(f => f.filter(i => i.kind !== "cards"))`; on `turn_complete` appends `{kind:"scene"}` + `{kind:"cards"}` to the feed alongside the existing `scenes`/`options` updates. If the turn was aborted by the stop button before `turn_complete`, set `stopped` state → render a neutral "Stopped — tap to continue the scene" pressable wired to `handleRetry` (NOT error styling; a deliberate stop is not a failure).
- Stop control: while `isStreaming`, the PTT area shows a `testID="stop-button"` Pressable ("■ Stop") that calls `abortRef.current?.abort()`.
- PTT `disabled={isStreaming}` only.

- [ ] **Step 1: Rewrite the affected tests first**

In `client/app/__tests__/story.test.tsx`:

DELETE these tests (behavior removed with the confirm bar): `"spoken ordinal picks a card after the confirm window"`, `"unmatched speech steers the story free-form"`, `"cancel inside the confirm window discards the utterance"`, `"a card tap during the confirm window discards the pending spoken utterance"` (exact names may differ slightly — delete the confirm-window/cancel/card-tap-during-confirm PTT tests).

UPDATE the two exact-object call-shape assertions (`"streams the opening scene..."` and `"tapping an option runs the next turn..."`): each expected request object gains `notes: ""`.

ADD (inside the existing `describe("push-to-talk")`, reusing `mockVoiceFake`, `fixtureStream`, `happyTurn`):

```tsx
  it("spoken ordinal picks a card immediately - no confirm window, no converse", async () => {
    const turnSpy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());
    const converseSpy = jest.spyOn(api, "converse");

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("the second one"));

    await waitFor(() =>
      expect(turnSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ chosen_scenario: "Ask the voice its name" }),
        expect.anything()
      )
    );
    expect(converseSpy).not.toHaveBeenCalled();
  });

  it("non-ordinal speech goes to converse with notes, options, and tail", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const converseSpy = jest.spyOn(api, "converse").mockReturnValueOnce(
      fixtureStream([
        { type: "reply_token", t: "She is " },
        { type: "reply_token", t: "stubborn." },
        { type: "discussion_complete", notes: "Mira is stubborn." },
      ])
    );

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("tell me more about the voice"));

    await waitFor(() => getByText(/She is stubborn./)); // AI bubble streamed
    expect(getByText(/tell me more about the voice/)).toBeTruthy(); // user bubble
    expect(converseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: "tell me more about the voice",
        notes: "",
        options: [
          "Force the iron door open now",
          "Ask the voice its name",
          "Run from the footsteps",
        ],
        discussion: [{ role: "user", text: "tell me more about the voice" }],
        template_id: "fantasy",
      }),
      expect.anything()
    );
  });

  it("notes and the discussion tail carry into the NEXT converse call", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const converseSpy = jest
      .spyOn(api, "converse")
      .mockReturnValueOnce(
        fixtureStream([
          { type: "reply_token", t: "A stubborn mapmaker." },
          { type: "discussion_complete", notes: "Mira is stubborn." },
        ])
      )
      .mockReturnValueOnce(
        fixtureStream([
          { type: "reply_token", t: "Fire, when she was nine." },
          { type: "discussion_complete", notes: "Mira is stubborn; fears fire." },
        ])
      );

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    const speak = (text: string) => {
      fireEvent(getByTestId("ptt-button"), "pressIn");
      const calls = mockVoiceFake.start.mock.calls;
      const cb = calls[calls.length - 1][0];
      fireEvent(getByTestId("ptt-button"), "pressOut");
      act(() => cb.onFinal(text));
    };

    speak("who is she really");
    await waitFor(() => getByText(/A stubborn mapmaker./));
    speak("what is she afraid of");
    await waitFor(() => getByText(/Fire, when she was nine./));

    expect(converseSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notes: "Mira is stubborn.",
        discussion: [
          { role: "user", text: "who is she really" },
          { role: "ai", text: "A stubborn mapmaker." },
          { role: "user", text: "what is she afraid of" },
        ],
      }),
      expect.anything()
    );
  });

  it("route steer fires the turn with the utterance verbatim", async () => {
    const turnSpy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());
    jest
      .spyOn(api, "converse")
      .mockReturnValueOnce(fixtureStream([{ type: "route", intent: "steer" }]));

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("she burns the letter and runs north"));

    await waitFor(() =>
      expect(turnSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chosen_scenario: "she burns the letter and runs north",
        }),
        expect.anything()
      )
    );
  });

  it("route pick fires the turn with the picked card", async () => {
    const turnSpy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());
    jest
      .spyOn(api, "converse")
      .mockReturnValueOnce(
        fixtureStream([{ type: "route", intent: "pick", index: 2 }])
      );

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("the one where someone is coming"));

    await waitFor(() =>
      expect(turnSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ chosen_scenario: "Run from the footsteps" }),
        expect.anything()
      )
    );
  });

  it("route options replaces the cards without running a turn", async () => {
    const turnSpy = jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    jest.spyOn(api, "converse").mockReturnValueOnce(
      fixtureStream([
        {
          type: "route",
          intent: "options",
          scenarios: ["Fresh idea one", "Fresh idea two", "Fresh idea three"],
        },
      ])
    );

    const { getByText, getByTestId, queryByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("give me some different ideas"));

    await waitFor(() => getByText("Fresh idea one"));
    expect(queryByText(/Force the iron door/)).toBeNull(); // old cards replaced
    expect(turnSpy).toHaveBeenCalledTimes(1); // opening turn only
  });

  it("stop aborts a streaming reply silently and keeps the partial bubble", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    let capturedSignal: AbortSignal | undefined;
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    jest.spyOn(api, "converse").mockImplementation(function (
      _req: unknown,
      opts?: { signal?: AbortSignal }
    ) {
      capturedSignal = opts?.signal;
      return (async function* () {
        yield { type: "reply_token", t: "Partial thought " } as const;
        await gate; // reply never finishes on its own
      })() as never;
    });

    const { getByText, getByTestId, queryByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("tell me about the dripping water"));

    await waitFor(() => getByText(/Partial thought/));
    fireEvent.press(getByTestId("stop-button"));
    expect(capturedSignal?.aborted).toBe(true);
    await act(async () => release!());
    await waitFor(() => expect(queryByText(/tap to retry/i)).toBeNull()); // no error painted
    expect(getByText(/Partial thought/)).toBeTruthy(); // partial bubble kept
  });

  it("consumed cards disappear when the next turn starts", async () => {
    jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Next scene." },
          { type: "turn_complete", summary: "s2", scenarios: ["Only new option"] },
        ])
      );

    const { getByText, queryByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));
    fireEvent.press(getByText("Ask the voice its name"));
    await waitFor(() => getByText("Only new option"));
    expect(queryByText(/Force the iron door/)).toBeNull();
  });
```

Also UPDATE the existing `"PTT is disabled while a turn is streaming"` test if it references confirm state — the disabled condition is now `isStreaming` only (assertion itself unchanged).

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false app/__tests__/story.test.tsx`
Expected: new tests FAIL (no converse wiring, no stop-button testID, confirm bar still intervening); deleted tests gone.

- [ ] **Step 3: Implement**

Rewrite `client/app/story.tsx` per **Binding behavior**. Skeleton of the new pieces (styling: match the existing StyleSheet; bubbles get rounded corners, `user_bubble` right-aligned `#1a2333`-ish, `ai_bubble` left-aligned `#1e1e1e`-ish; reuse existing card/scene styles):

```tsx
type FeedItem =
  | { kind: "scene"; text: string }
  | { kind: "user_bubble"; text: string }
  | { kind: "ai_bubble"; text: string }
  | { kind: "cards"; options: string[] };

// state (replacing options-at-bottom + confirm state):
const [feed, setFeed] = useState<FeedItem[]>([]);
const [scenes, setScenes] = useState<string[]>([]); // canonical + turn clock (unchanged)
const [options, setOptions] = useState<string[]>([]); // current offer, mirrors trailing cards item
const [notes, setNotes] = useState("");
const [discussion, setDiscussion] = useState<DiscussionEntry[]>([]);
const [currentReply, setCurrentReply] = useState("");
const [stopped, setStopped] = useState(false);
const [replyCount, setReplyCount] = useState(0); // keying StreamingText per reply

// runTurn: add to the request: notes,
// at start: setStopped(false); setFeed(f => f.filter(i => i.kind !== "cards")); setOptions([]);
// on turn_complete: setFeed(f => [...f, { kind: "scene", text: sceneText },
//                                  { kind: "cards", options: ev.scenarios }]);
//                   (scenes/summary/options updates as today)
// after the loop: if (controller.signal.aborted && !gotTurnComplete && !gotError) setStopped(true);

const handleUtterance = (utterance: string) => {
  const idx = matchCard(utterance, options);
  if (idx !== null) {
    handleChoose(options[idx]);
    return;
  }
  runConverse(utterance);
};

async function runConverse(utterance: string) {
  if (streamingRef.current) return;
  streamingRef.current = true;
  setIsStreaming(true);
  setStopped(false);
  const controller = new AbortController();
  abortRef.current = controller;

  setFeed((f) => [...f, { kind: "user_bubble", text: utterance }]);
  setDiscussion((d) => [...d, { role: "user", text: utterance }].slice(-6));
  setError(null);
  setCurrentReply("");
  setReplyCount((n) => n + 1);

  let routed:
    | { intent: "pick"; index: number }
    | { intent: "steer" }
    | { intent: "options"; scenarios: string[] }
    | null = null;
  let replyText = "";
  let completed = false;

  try {
    for await (const ev of converse(
      {
        template_id: templateId,
        utterance,
        summary,
        notes,
        options,
        discussion: [...discussion, { role: "user", text: utterance }].slice(-6),
        turn: scenes.length + 1,
        length: storyLength,
      },
      { signal: controller.signal }
    )) {
      if (ev.type === "reply_token") {
        replyText += ev.t;
        setCurrentReply(replyText);
      } else if (ev.type === "discussion_complete") {
        completed = true;
        setNotes(ev.notes);
        if (replyText.trim()) {
          setFeed((f) => [...f, { kind: "ai_bubble", text: replyText }]);
          setDiscussion((d) => [...d, { role: "ai", text: replyText }].slice(-6));
        }
        setCurrentReply("");
      } else if (ev.type === "route") {
        routed = ev;
      } else if (ev.type === "stream_error") {
        setError({ status: ev.status, detail: ev.detail });
      }
    }
  } finally {
    // An aborted or failed reply keeps whatever streamed (you can't un-say it),
    // but notes stay unchanged — canon only updates through discussion_complete.
    if (!completed && replyText.trim()) {
      setFeed((f) => [...f, { kind: "ai_bubble", text: replyText }]);
      setDiscussion((d) => [...d, { role: "ai", text: replyText }].slice(-6));
      setCurrentReply("");
    }
    streamingRef.current = false;
    setIsStreaming(false);
    abortRef.current = null;
  }

  if (routed) {
    if (routed.intent === "pick") handleChoose(options[routed.index]);
    else if (routed.intent === "steer") handleChoose(utterance);
    else if (routed.intent === "options") {
      setOptions(routed.scenarios);
      setFeed((f) => [
        ...f.filter((i) => i.kind !== "cards"),
        { kind: "cards", options: routed.scenarios },
      ]);
    }
  }
}
```

Rendering (inside the ScrollView): map `feed` — `scene` → existing scene `Text`; `user_bubble`/`ai_bubble` → styled `View`+`Text`; `cards` → the existing option-card Pressables (`onPress={() => handleChoose(option)}`, no highlight state — the confirm bar is gone). Below the feed: streaming scene (`StreamingText key={turnCount}`) and streaming reply (`<View style={styles.aiBubble}><StreamingText key={`reply-${replyCount}`} text={currentReply} /></View>` when `currentReply` non-empty). Error banner unchanged. `stopped && pendingTurn` → neutral pressable (own style, NOT `retry` error styling): `"Stopped — tap to continue the scene"` → `handleRetry`. PTT area: `{isStreaming && <Pressable testID="stop-button" onPress={() => abortRef.current?.abort()} style={styles.stopButton}><Text style={styles.stopButtonText}>■ Stop</Text></Pressable>}` above `<PushToTalk disabled={isStreaming} onUtterance={handleUtterance} />`.

Guard note: `routed` pick uses `options` captured BEFORE the converse call mutated anything (options only change via `turn_complete`/`options` route, neither of which fires on a pick/steer converse) — index validity was enforced server-side.

Delete: `ConfirmPending` type, `confirmPending` state, `confirmTimeoutRef`, `cancelConfirm`, the confirm-bar JSX + its styles, and `cancelConfirm()` inside `runTurn` (nothing arms timers anymore).

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: ALL PASS (72 − 4 deleted + 8 new = 76 — report the actual count), types clean, no act() warnings.

- [ ] **Step 5: Commit**

```bash
git add client
git commit -m "feat(client): conversational story feed - bubbles, silent routing, stop control, confirm bar removed"
```

---

### Task 8: Docs, full verification, ship

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full suites** — backend `venv/Scripts/python.exe -m pytest tests/ -v` (~103); client `npx jest --watchAll=false && npx tsc --noEmit` (~76); `npx expo export --platform web` builds clean. Report exact counts.

- [ ] **Step 2: CLAUDE.md** — new backend bullet for `/converse/stream` (fused intent routing, the four intents + unsure→discuss, notes scribe, pick-invalid clarification, budgets/labels, mock triggers); `/continue` bullet gains the `notes` field + new prompt order; client section: feed model (canonical `scenes` invariant intact), bubbles, ordinals-only `matchCard` (overlap retired — and why), converse wiring, confirm bar REMOVED (owner decision) + stop control replacing it, notes/discussion-tail carrying. Update both test counts. NEXT STEPS: conversational co-creation shipped (browser); slice D narration designs against the feed model; native build still parked on the phone-OS answer.

- [ ] **Step 3: Commit + push**

```bash
git add CLAUDE.md
git commit -m "docs: record conversational co-creation in CLAUDE.md"
git push
```

- [ ] **Step 4: Hand the demo to the human** — backend up (`DEV_MOCK_ENABLED=1`), `cd client && npx expo start --web`, Chrome + mic. Mock-mode script: say "the second one" → instant pick; say "tell me more about her" → chat bubble reply streams (canned); say "give me different ideas" → cards swap; say "she burns the letter and runs" → routes to steer → next canned scene; tap ■ Stop mid-reply → reply halts, no error. Real-mode (quota permitting): same script against live Gemini; check `logs/usage.jsonl` shows `converse`/`notes_fold` rows.

---

## Self-Review

**Spec coverage:** Two-channel architecture + tiered routing → Tasks 2/5/6/7. Fused call with intent-first output, unsure→discuss, verbatim steer → Task 1 prompt + Task 2. Notes canon (scribe call, cap, only-writer rule) → Tasks 1/2; scene prompt honoring notes with pinned order + byte-identical back-compat → Task 4. Out-of-range pick → fixed clarification, never 500/blind turn → Tasks 1/2. Options intent conversation-informed replacement → Tasks 2/7. Mock mode env-gated, zero Gemini → Task 3. Feed + bubbles + canonical-scenes invariant + StreamingText reuse for replies → Task 7. Confirm-bar removal + immediate ordinal fast-path + stop control (abortable, silent) → Tasks 6/7. Cost meter labels/budgets → Tasks 1/2 (pinned in tests). Error contract parity → Task 2 tests. Discussion tail cap 6 both sides → Task 1 (server) + Task 7 (client). ✓

**Placeholder scan:** Task 5's `streamPost` says "current body verbatim" — deliberate: the exact code exists in `client/lib/api.ts:36-97` and duplicating it here risks drift; the step names the mechanical move precisely. Task 7 Step 3 gives state, control flow, and JSX responsibilities with binding tests (the slice C Task 4 pattern). No TBDs. ✓

**Type consistency:** `parse_intent_line -> (str, int|None)` consumed in Task 2's `_stream_converse`; `ConverseRequest` field names identical across backend model (Task 1), client type (Task 5), and Story's call site (Task 7); frame names `reply_token`/`discussion_complete`/`route` identical in Task 2 emitters, Task 5 parser, Task 7 handlers; `TurnRequest.notes?` (Task 5) matches backend default-"" (Task 4); `matchCard` signature unchanged (Task 6). ✓

**Known context for the executing session:** run with subagent-driven-development; per-task briefs via `scripts/task-brief`; ledger `.superpowers/sdd/progress.md`. Backend test counts assume the current 69; client counts assume 62 — verify at Task 1/5 start and adjust arithmetic, not scope.
