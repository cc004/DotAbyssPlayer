from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parents[1]
DEFAULT_STORY_ROOTS = [
    WORKSPACE / "src" / "AdvPlayer" / "data" / "stories",
    WORKSPACE / "src" / "AdvPlayer" / "data_r18_all" / "stories",
]
DEFAULT_SE_BUNDLE_ROOT = (
    WORKSPACE
    / "workspace"
    / "bundles"
    / "android-dmm-r18"
    / "general-sound-cri"
    / "assets"
    / "assets"
    / "project"
    / "lazyassets"
    / "general"
    / "sound"
    / "cri"
    / "pc"
    / "workunit"
    / "novel"
    / "se"
)
DEFAULT_OUTPUT_ROOT = WORKSPACE / "src" / "AdvPlayer" / "data" / "audio" / "se"


def load_adv_extract_module():
    path = WORKSPACE / "tools" / "adv_extract.py"
    spec = importlib.util.spec_from_file_location("adv_extract", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def safe_name(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return text.strip("._").lower() or "unnamed"


def clean_source_path(path: Path, base: Path) -> str:
    try:
        return path.relative_to(base).as_posix()
    except ValueError:
        return path.name


def collect_se_cues(story_roots: list[Path]) -> list[str]:
    cues: set[str] = set()
    for stories_root in story_roots:
        if not stories_root.exists():
            continue
        for story_file in stories_root.glob("*/story.json"):
            story = json.loads(story_file.read_text(encoding="utf-8"))
            for script in story.get("scripts", []):
                for command in script.get("commands", []):
                    if str(command.get("command", "")).lower() not in {"seplay", "asyncseplay"}:
                        continue
                    args = command.get("args") or []
                    if len(args) >= 2 and args[1]:
                        cues.add(safe_name(str(args[1])))
    return sorted(cues)


def find_bundle(cue_name: str, bundle_root: Path) -> Path | None:
    patterns = [f"{cue_name}.acb*.bundle", f"{cue_name}.awb*.bundle", f"*{cue_name}*.bundle"]
    for pattern in patterns:
        matches = sorted(bundle_root.rglob(pattern))
        if matches:
            return matches[0]
    return None


def decode_cue(adv_extract, vgmstream: Path, cue_name: str, bundle: Path, bundle_root: Path, raw_root: Path, decoded_root: Path) -> dict:
    cue_raw_dir = raw_root / cue_name
    cue_raw_dir.mkdir(parents=True, exist_ok=True)
    payloads = adv_extract.extract_cri_payloads(bundle, cue_raw_dir)
    errors = [item for item in payloads if "error" in item]
    if errors:
        raise RuntimeError(errors[0]["error"])

    for payload in payloads:
        raw_path = payload.get("path")
        if raw_path is None:
            continue
        first = adv_extract.run_vgmstream_info(vgmstream, raw_path)
        stream_info = first.get("streamInfo") or {}
        total = int(stream_info.get("total") or 1)
        subsongs = range(1, total + 1) if total > 1 else [None]
        for subsong in subsongs:
            info = first if subsong is None else adv_extract.run_vgmstream_info(vgmstream, raw_path, subsong)
            cue = safe_name(str((info.get("streamInfo") or {}).get("name") or raw_path.stem))
            if cue != cue_name:
                continue
            out_path = decoded_root / "misc" / f"{cue_name}.wav"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            adv_extract.run_vgmstream_decode(vgmstream, raw_path, out_path, subsong)
            sample_rate = info.get("sampleRate")
            sample_count = info.get("numberOfSamples") or info.get("playSamples")
            duration = sample_count / sample_rate if sample_rate and sample_count else None
            return {
                "name": cue_name,
                "category": "se",
                "path": f"audio/se/decoded/misc/{cue_name}.wav",
                "source": clean_source_path(bundle, bundle_root),
                "raw": f"audio/se/raw/{cue_name}/{raw_path.name}",
                "subsong": subsong or 1,
                "duration": duration,
                "sampleRate": sample_rate,
                "channels": info.get("channels"),
                "encoding": info.get("encoding"),
                "bytes": out_path.stat().st_size,
            }

    raise RuntimeError("cue not found in decoded CRI payload")


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract shared novel SE cues referenced by story.json files.")
    parser.add_argument("--story-root", action="append", default=[], help="Story root directory containing <story-id>/story.json. Can be repeated.")
    parser.add_argument("--stories-root", action="append", default=[], help=argparse.SUPPRESS)
    parser.add_argument("--bundle-root", default=str(DEFAULT_SE_BUNDLE_ROOT), help="Bundle root that contains the novel SE CRI bundles.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_ROOT), help="Output directory for raw/decoded SE files and index.json.")
    parser.add_argument("--vgmstream", default=None, help="Optional path to vgmstream-cli.exe.")
    args = parser.parse_args()

    story_root_args = args.story_root + args.stories_root
    story_roots = [Path(value) for value in story_root_args] if story_root_args else DEFAULT_STORY_ROOTS
    bundle_root = Path(args.bundle_root)
    output_root = Path(args.output)
    raw_root = output_root / "raw"
    decoded_root = output_root / "decoded"

    adv_extract = load_adv_extract_module()
    vgmstream = adv_extract.find_vgmstream_cli(args.vgmstream)
    if not vgmstream:
        raise RuntimeError("vgmstream-cli.exe not found")

    if raw_root.exists():
        shutil.rmtree(raw_root)
    raw_root.mkdir(parents=True, exist_ok=True)
    decoded_root.mkdir(parents=True, exist_ok=True)

    index = {
        "generatedBy": "tools/extract_global_se_assets.py",
        "decoder": Path(vgmstream).name,
        "cues": {},
        "errors": [],
    }

    for cue_name in collect_se_cues(story_roots):
        bundle = find_bundle(cue_name, bundle_root)
        if bundle is None:
            index["errors"].append({"cue": cue_name, "error": "bundle not found"})
            print(f"missing {cue_name}")
            continue
        try:
            item = decode_cue(adv_extract, vgmstream, cue_name, bundle, bundle_root, raw_root, decoded_root)
            index["cues"][cue_name] = item
            print(f"decoded {cue_name} -> {item['path']}")
        except Exception as exc:
            index["errors"].append({"cue": cue_name, "sourceBundle": clean_source_path(bundle, bundle_root), "error": repr(exc)})
            print(f"failed {cue_name}: {exc}")

    (output_root / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"cues={len(index['cues'])} errors={len(index['errors'])}")
    return 1 if index["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
