#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def file_exists(root: Path, relative: str | None) -> bool:
    return bool(relative) and (root / relative).exists()


def check_model3_files(story_root: Path, model_path: Path, errors: list[str]) -> None:
    model = load_json(model_path)
    refs = model.get("FileReferences") or {}

    moc = refs.get("Moc")
    if moc and not file_exists(story_root, moc):
        errors.append(f"{story_root.name}: model3 Moc missing: {moc}")

    for texture in refs.get("Textures") or []:
        if texture and not file_exists(story_root, texture):
            errors.append(f"{story_root.name}: model3 texture missing: {texture}")

    motions = refs.get("Motions") or {}
    if isinstance(motions, dict):
        for group, items in motions.items():
            for item in items or []:
                motion_file = item.get("File") if isinstance(item, dict) else None
                if motion_file and not file_exists(story_root, motion_file):
                    errors.append(f"{story_root.name}: model3 motion missing: {group}/{motion_file}")


def check_story(data_root: Path, story_entry: dict, errors: list[str], warnings: list[str]) -> None:
    story_rel = story_entry.get("path")
    if not story_rel:
        errors.append(f"index entry without path: {story_entry!r}")
        return

    story_path = data_root / story_rel
    if not story_path.exists():
        errors.append(f"{story_entry.get('id', '<unknown>')}: story file missing: {story_rel}")
        return

    story = load_json(story_path)
    story_root = story_path.parent
    sid = story.get("id") or story_root.name
    live2d = story.get("live2d") or {}
    animations = [item.get("name") for item in live2d.get("animations") or [] if item.get("name")]
    motion_items = [item for item in live2d.get("motions") or [] if item.get("name")]
    motion_keys = {normalize_key(item.get("name")) for item in motion_items}

    for motion in motion_items:
        if not file_exists(story_root, motion.get("path")):
            errors.append(f"{sid}: motion file missing: {motion.get('name')} -> {motion.get('path')}")

    missing_animations = [name for name in animations if normalize_key(name) not in motion_keys]
    for name in missing_animations:
        errors.append(f"{sid}: AnimationClip has no exported motion: {name}")

    missing_scenes = [
        name for name in animations
        if re.match(r"^scene\d+", name or "", re.I) and normalize_key(name) not in motion_keys
    ]
    for name in missing_scenes:
        errors.append(f"{sid}: scene motion missing: {name}")

    stats = story.get("stats") or {}
    if stats.get("animationCount", 0) > stats.get("motionCount", 0):
        warnings.append(
            f"{sid}: animationCount > motionCount "
            f"({stats.get('animationCount')} > {stats.get('motionCount')})"
        )

    model3 = live2d.get("model3")
    if model3:
        model_path = story_root / model3
        if not model_path.exists():
            errors.append(f"{sid}: model3 missing: {model3}")
        else:
            check_model3_files(story_root, model_path, errors)


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify extracted DotAbyss ADV player data.")
    parser.add_argument("--data-root", default="src/AdvPlayer/data_r18_all", help="Extracted player data root.")
    parser.add_argument("--min-stories", type=int, default=1, help="Minimum story count expected in index.json.")
    parser.add_argument("--json", dest="json_output", default=None, help="Optional JSON report path.")
    args = parser.parse_args()

    data_root = Path(args.data_root)
    index_path = data_root / "index.json"
    errors: list[str] = []
    warnings: list[str] = []

    if not index_path.exists():
        errors.append(f"index missing: {index_path}")
    else:
        index = load_json(index_path)
        stories = index.get("stories") or []
        if len(stories) < args.min_stories:
            errors.append(f"story count too small: {len(stories)} < {args.min_stories}")
        for story_entry in stories:
            try:
                check_story(data_root, story_entry, errors, warnings)
            except Exception as exc:
                errors.append(f"{story_entry.get('id', '<unknown>')}: verify failed: {exc!r}")

    report = {
        "dataRoot": data_root.as_posix(),
        "errorCount": len(errors),
        "warningCount": len(warnings),
        "errors": errors,
        "warnings": warnings,
    }

    if args.json_output:
        out_path = Path(args.json_output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"verify data root: {data_root}")
    print(f"errors: {len(errors)}")
    for item in errors[:50]:
        print(f"ERROR: {item}")
    if len(errors) > 50:
        print(f"ERROR: ... {len(errors) - 50} more")

    print(f"warnings: {len(warnings)}")
    for item in warnings[:20]:
        print(f"WARN: {item}")
    if len(warnings) > 20:
        print(f"WARN: ... {len(warnings) - 20} more")

    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
