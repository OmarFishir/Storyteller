import pytest

import story_beats
from story_beats import EPILOGUE_BEAT, select_beats

STRUCTURE = {
    "source": "https://example.test/structure",
    "beats": [
        {"name": "Beat One", "guidance": "g1"},
        {"name": "Beat Two", "guidance": "g2"},
        {"name": "Beat Three", "guidance": "g3"},
    ],
}


def test_no_structure_returns_none():
    assert select_beats(None, turn=1, length="short") is None


def test_short_maps_one_turn_per_beat():
    current, nxt = select_beats(STRUCTURE, turn=1, length="short")
    assert current["name"] == "Beat One"
    assert nxt["name"] == "Beat Two"
    current, nxt = select_beats(STRUCTURE, turn=3, length="short")
    assert current["name"] == "Beat Three"
    assert nxt == EPILOGUE_BEAT  # next after the final beat


def test_medium_spends_two_turns_per_beat():
    assert select_beats(STRUCTURE, turn=2, length="medium")[0]["name"] == "Beat One"
    assert select_beats(STRUCTURE, turn=3, length="medium")[0]["name"] == "Beat Two"


def test_long_spends_three_turns_per_beat():
    assert select_beats(STRUCTURE, turn=3, length="long")[0]["name"] == "Beat One"
    assert select_beats(STRUCTURE, turn=4, length="long")[0]["name"] == "Beat Two"


def test_past_the_end_is_epilogue_forever():
    current, nxt = select_beats(STRUCTURE, turn=4, length="short")
    assert current == EPILOGUE_BEAT and nxt == EPILOGUE_BEAT
    current, nxt = select_beats(STRUCTURE, turn=99, length="short")
    assert current == EPILOGUE_BEAT and nxt == EPILOGUE_BEAT


def test_epilogue_has_prompt_ready_fields():
    assert EPILOGUE_BEAT["name"] and EPILOGUE_BEAT["guidance"]
