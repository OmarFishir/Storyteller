"""
Beat selection for structured stories.

A template's structure is an ordered list of narrative beats (data, not code —
see templates/*.json). The story's position is derived STATELESSLY from the
turn number the client carries (same pattern as the running summary): the
chosen length stretches the arc by spending more scenes inside each beat.
Past the final beat the story never hard-stops — it enters an epilogue that
leans toward closure for as long as the reader keeps choosing.
"""

TURNS_PER_BEAT = {"short": 1, "medium": 2, "long": 3}

EPILOGUE_BEAT = {
    "name": "Epilogue",
    "guidance": (
        "The story's arc is complete. Wind down gracefully: resolve remaining "
        "threads, honor the consequences of the journey, and lean toward "
        "closure — while leaving room to continue if the reader keeps going."
    ),
}


def select_beats(structure: dict | None, turn: int, length: str) -> tuple[dict, dict] | None:
    """Return (current_beat, next_beat) for this turn, or None if unstructured."""
    if structure is None:
        return None
    beats = structure["beats"]
    index = (turn - 1) // TURNS_PER_BEAT[length]
    if index >= len(beats):
        return (EPILOGUE_BEAT, EPILOGUE_BEAT)
    current = beats[index]
    nxt = beats[index + 1] if index + 1 < len(beats) else EPILOGUE_BEAT
    return (current, nxt)
