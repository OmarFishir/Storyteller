"""
Loads genre templates from templates/*.json at startup.

A template is DATA, not code: adding genre #5 = dropping one JSON file
in templates/. Each file needs: id, name, description (user-facing),
style (prompt-injection text — stays server-side), premise_seeds
(ready-made starters the user can pick or speak over).

Malformed files fail LOUDLY at startup — same philosophy as the
missing-API-key check: better a clear crash now than a confusing 500 later.
"""
import json
import os

TEMPLATES_DIR = "templates"
REQUIRED_KEYS = {"id", "name", "description", "style", "premise_seeds"}


def load_templates(directory: str = TEMPLATES_DIR) -> dict[str, dict]:
    templates: dict[str, dict] = {}
    for filename in sorted(os.listdir(directory)):
        if not filename.endswith(".json"):
            continue
        path = os.path.join(directory, filename)
        with open(path, encoding="utf-8") as f:
            data = json.load(f)

        missing = REQUIRED_KEYS - data.keys()
        if missing:
            raise RuntimeError(f"Template {filename} is missing keys: {sorted(missing)}")
        seeds = data["premise_seeds"]
        if (
            not isinstance(seeds, list)
            or not seeds
            or not all(isinstance(s, str) for s in seeds)
        ):
            raise RuntimeError(
                f"Template {filename}: premise_seeds must be a non-empty list of strings"
            )
        structure = data.get("structure")
        if structure is not None:
            if not isinstance(structure, dict) or not isinstance(
                structure.get("source"), str
            ) or not structure.get("source"):
                raise RuntimeError(
                    f"Template {filename}: structure needs a non-empty string 'source'"
                )
            beats = structure.get("beats")
            if not isinstance(beats, list) or not beats:
                raise RuntimeError(
                    f"Template {filename}: structure needs a non-empty 'beats' list"
                )
            for beat in beats:
                if (
                    not isinstance(beat, dict)
                    or not isinstance(beat.get("name"), str)
                    or not beat["name"]
                    or not isinstance(beat.get("guidance"), str)
                    or not beat["guidance"]
                ):
                    raise RuntimeError(
                        f"Template {filename}: every structure beat needs non-empty "
                        "string 'name' and 'guidance'"
                    )
        if data["id"] in templates:
            raise RuntimeError(f"Duplicate template id: {data['id']}")
        templates[data["id"]] = data

    if not templates:
        raise RuntimeError(f"No templates found in {directory}/")
    return templates
