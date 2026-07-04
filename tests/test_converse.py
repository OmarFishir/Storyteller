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


def test_parse_notes_blank_is_502():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        main.parse_notes('{"notes": "   "}')
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


# --- /converse/stream real path ---------------------------------------------

def test_converse_discuss_streams_reply_then_folds_notes(monkeypatch):
    def fake_stream(contents, **kwargs):
        assert kwargs["label"] == "converse"
        assert kwargs["max_tokens"] == main.CONVERSE_BUDGET
        assert kwargs["temperature"] == 0.8
        # Intent line and the reply's first words arrive in ONE chunk — the
        # endpoint must forward only what follows the newline.
        yield "INTENT: discuss\nShe is "
        yield "stubborn."

    captured = {}

    def fake_notes(contents, **kw):
        captured["label"] = kw.get("label")
        captured["max_tokens"] = kw.get("max_tokens")
        captured["temperature"] = kw.get("temperature")
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
    assert captured == {
        "label": "notes_fold",
        "max_tokens": main.NOTES_BUDGET,
        "temperature": 0.7,
    }


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
