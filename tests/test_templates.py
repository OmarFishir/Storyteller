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
