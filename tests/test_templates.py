import json

import pytest

import story_templates

VALID = {
    "id": "test",
    "name": "Test",
    "description": "d",
    "style": "s",
    "premise_seeds": ["p1", "p2"],
}


def _write(tmp_path, name, data):
    (tmp_path / name).write_text(json.dumps(data), encoding="utf-8")


def test_loads_valid_templates(tmp_path):
    _write(tmp_path, "test.json", VALID)
    templates = story_templates.load_templates(str(tmp_path))
    assert templates["test"]["name"] == "Test"


def test_rejects_missing_keys(tmp_path):
    bad = dict(VALID)
    del bad["style"]
    _write(tmp_path, "bad.json", bad)
    with pytest.raises(RuntimeError, match="missing keys"):
        story_templates.load_templates(str(tmp_path))


def test_rejects_duplicate_ids(tmp_path):
    _write(tmp_path, "a.json", VALID)
    _write(tmp_path, "b.json", VALID)
    with pytest.raises(RuntimeError, match="Duplicate"):
        story_templates.load_templates(str(tmp_path))


def test_rejects_empty_dir(tmp_path):
    with pytest.raises(RuntimeError, match="No templates"):
        story_templates.load_templates(str(tmp_path))


def test_real_templates_dir_loads_all_four():
    templates = story_templates.load_templates()
    assert {"fantasy", "noir", "scifi", "fairytale"} <= set(templates)


def test_structure_is_optional(tmp_path):
    _write(tmp_path, "test.json", VALID)  # VALID has no structure key
    templates = story_templates.load_templates(str(tmp_path))
    assert "structure" not in templates["test"]


def test_valid_structure_loads(tmp_path):
    good = dict(VALID)
    good["structure"] = {
        "source": "https://example.test",
        "beats": [{"name": "One", "guidance": "g"}],
    }
    _write(tmp_path, "test.json", good)
    templates = story_templates.load_templates(str(tmp_path))
    assert templates["test"]["structure"]["beats"][0]["name"] == "One"


@pytest.mark.parametrize(
    "structure",
    [
        {"beats": [{"name": "One", "guidance": "g"}]},          # missing source
        {"source": "https://x", "beats": []},                    # empty beats
        {"source": "https://x", "beats": [{"name": "One"}]},     # beat missing guidance
        {"source": "https://x", "beats": [{"name": "", "guidance": "g"}]},  # empty name
        {"source": "https://x"},                                 # missing beats
    ],
)
def test_bad_structure_fails_loud(tmp_path, structure):
    bad = dict(VALID)
    bad["structure"] = structure
    _write(tmp_path, "bad.json", bad)
    with pytest.raises(RuntimeError, match="structure"):
        story_templates.load_templates(str(tmp_path))


def test_all_shipped_templates_have_sourced_structures():
    templates = story_templates.load_templates()
    for tid in ("fantasy", "noir", "scifi", "fairytale"):
        structure = templates[tid]["structure"]
        assert structure["source"].startswith("http")
        assert len(structure["beats"]) >= 8
        for beat in structure["beats"]:
            assert beat["name"] and beat["guidance"]
