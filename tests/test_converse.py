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
