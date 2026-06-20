#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import shutil
import subprocess
import sys
import zlib
from collections import Counter, defaultdict
from io import StringIO
from pathlib import Path

import UnityPy
from UnityPy.enums import ClassIDType


COMMAND_INFO = {
    ":label": {
        "category": "flow",
        "title": "标签",
        "args": ["label"],
        "description": "NovelScriptCommands uses ':' lines as jump targets.",
    },
    "adultui": {
        "category": "ui",
        "title": "成人 UI 开关",
        "args": ["on/off"],
        "description": "NovelCmdAdultUI toggles the adult-scene overlay state.",
    },
    "uivisible": {
        "category": "ui",
        "title": "UI 可见性",
        "args": ["on/off"],
        "description": "NovelCmdUIVisible toggles the common UI layer.",
    },
    "window": {
        "category": "ui",
        "title": "文本窗口",
        "args": ["on/off", "fade_seconds"],
        "description": "NovelCmdWindow changes the message window visibility/fade.",
    },
    "fade": {
        "category": "screen",
        "title": "画面淡入淡出",
        "args": ["In/Out", "color", "seconds"],
        "description": "NovelCmdFade drives the screen fade model.",
    },
    "message": {
        "category": "text",
        "title": "旁白/普通文本",
        "args": ["speaker", "message", "voice?"],
        "description": "NovelCmdMessage writes to NovelModelMessage and may play voice.",
    },
    "l2dmessage": {
        "category": "text",
        "title": "Live2D 台词",
        "args": ["speaker", "message", "face_or_empty", "voice_id"],
        "description": "NovelCmdL2dMessage derives from NovelCmdMessage and ties speech to Live2D/lip sync.",
    },
    "l2dshow": {
        "category": "live2d",
        "title": "显示 Live2D",
        "args": ["model_object"],
        "description": "NovelCmdL2dShow loads and draws a NovelModelLive2D object.",
    },
    "l2dhide": {
        "category": "live2d",
        "title": "隐藏 Live2D",
        "args": [],
        "description": "NovelCmdL2dHide releases the active Live2D model.",
    },
    "l2dmotion": {
        "category": "live2d",
        "title": "Live2D 动作",
        "args": ["motion_trigger"],
        "description": "NovelCmdL2dMotion calls NovelModelLive2D.PlayMotion.",
    },
    "asyncl2dmotion": {
        "category": "live2d",
        "title": "延迟 Live2D 动作",
        "args": ["motion_trigger", "bool", "async_code", "delay_seconds"],
        "description": "Async wrapper schedules PlayMotion and finishes according to STOP/async code.",
    },
    "bgmplay": {
        "category": "audio",
        "title": "播放 BGM",
        "args": ["tag", "cue", "fade_seconds"],
        "description": "NovelCmdBGMPlay starts a CRI cue by tag.",
    },
    "bgmstop": {
        "category": "audio",
        "title": "停止 BGM",
        "args": ["tag", "fade_seconds"],
        "description": "NovelCmdBGMStop fades/stops a CRI cue by tag.",
    },
    "bgvplay": {
        "category": "audio",
        "title": "播放背景语音/环境声",
        "args": ["tag", "cue", "volume", "loop"],
        "description": "NovelCmdBGVPlay starts a CRI background-voice cue.",
    },
    "bgvstop": {
        "category": "audio",
        "title": "停止背景语音/环境声",
        "args": ["tag", "fade_seconds", "volume?"],
        "description": "NovelCmdBGVStop fades/stops a CRI background-voice cue.",
    },
    "charaload": {
        "category": "character",
        "title": "加载角色",
        "args": ["tag", "character_id", "display_name"],
        "description": "NovelCmdCharaLoad registers a character resource/name.",
    },
    "wait": {
        "category": "flow",
        "title": "等待",
        "args": ["seconds"],
        "description": "NovelCmdWait blocks script playback for the given seconds.",
    },
    "cleanall": {
        "category": "screen",
        "title": "清空场景",
        "args": ["target"],
        "description": "NovelCmdCleanAll clears visible scene objects/layers.",
    },
}


def command_category(command: str):
    low = (command or "").lower()
    if low.startswith(":") or "wait" in low or "jump" in low or "label" in low or "section" in low or low in ("initend", "title"):
        return "flow"
    if "message" in low or low in ("talk", "telop"):
        return "text"
    if "bgm" in low or "bgv" in low or "seplay" in low or "sestop" in low or "sefade" in low or low.startswith("se") or "voice" in low:
        return "audio"
    if low.startswith("l2d") or "live2d" in low:
        return "live2d"
    if "fade" in low or "blur" in low or "shake" in low or "clean" in low or "linework" in low:
        return "screen"
    if "chara" in low or "silhouette" in low or "emodelete" in low or low == "priority":
        return "character"
    if "bg" in low or "camera" in low or "move" in low or "scale" in low or "rotate" in low:
        return "stage"
    if "still" in low or "image" in low or "prefab" in low or "object" in low or "asset" in low:
        return "asset"
    if "ui" in low or "window" in low or "popup" in low:
        return "ui"
    return "unknown"


def load_command_analysis_info(base_dir: Path):
    analysis_path = base_dir / "novel_command_analysis.json"
    if not analysis_path.exists():
        return
    try:
        analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
    except Exception:
        return
    for item in analysis:
        cmd = (item.get("command") or "").lower()
        if not cmd:
            continue
        args = []
        for param in item.get("params") or []:
            types = "/".join(param.get("types") or [])
            default = ", ".join(param.get("defaults") or [])
            args.append(f"arg{param.get('index')}:{types or '?'} default={default or '-'}")
        existing = COMMAND_INFO.get(cmd, {})
        COMMAND_INFO[cmd] = {
            "category": existing.get("category") or command_category(cmd),
            "title": existing.get("title") or item.get("class") or cmd,
            "args": existing.get("args") or args,
            "description": existing.get("description")
            or f"IDA: {item.get('class')} / {item.get('logicClass') or '-'}",
            "class": item.get("class"),
            "logicClass": item.get("logicClass"),
            "idaParams": item.get("params") or [],
        }


def configure_stdout():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


def safe_name(value: str, fallback: str = "asset") -> str:
    value = value or fallback
    value = re.sub(r"[^\w.\-]+", "_", value, flags=re.UNICODE).strip("._")
    return value or fallback


def unity_object_name(data, fallback: str = "asset") -> str:
    for attr in ("name", "m_Name"):
        value = getattr(data, attr, None)
        if value:
            return str(value)
    return fallback


def unity_text_asset_script(data):
    for attr in ("script", "m_Script"):
        if hasattr(data, attr):
            return getattr(data, attr)
    return b""


def unwrap_offset_ptr(value):
    return getattr(value, "data", value)


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def write_bytes(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def decode_text_asset(script) -> str:
    if isinstance(script, memoryview):
        script = script.tobytes()
    if isinstance(script, bytes):
        for enc in ("utf-8-sig", "utf-8", "cp932", "shift_jis"):
            try:
                return script.decode(enc)
            except UnicodeDecodeError:
                continue
        return script.decode("utf-8", errors="replace")
    return str(script)


def csv_rows(text: str):
    reader = csv.reader(StringIO(text))
    for line_no, row in enumerate(reader, 1):
        if not row or not any(cell.strip() for cell in row):
            continue
        yield line_no, row


def normalize_command(row):
    cmd = row[0].lstrip("\ufeff").strip()
    if cmd.startswith(":"):
        return ":label"
    return cmd.lower()


def is_text_command(cmd: str):
    return cmd in {
        "message",
        "l2dmessage",
        "dotmessage",
        "asyncdotmessage",
        "messagetextcenter",
        "messagetextunder",
    }


def parse_script(text: str):
    commands = []
    counts = Counter()
    messages = []
    audio_ids = set()
    motions = []
    labels = []

    index = 0
    for line_no, row in csv_rows(text):
        raw = row[0].strip()
        if raw.startswith("//"):
            continue
        cmd = normalize_command(row)
        args = row[1:]
        info = COMMAND_INFO.get(cmd, {
            "category": "unknown",
            "title": raw or "unknown",
            "args": [],
            "description": "No local mapping yet; raw arguments are preserved.",
        })
        counts[cmd] += 1
        item = {
            "index": index,
            "line": line_no,
            "command": cmd,
            "rawCommand": raw,
            "args": args,
            "category": info["category"],
            "title": info["title"],
        }

        if cmd == ":label":
            item["label"] = row[0].strip()[1:]
            labels.append(item["label"])
        elif is_text_command(cmd):
            speaker = args[0].strip() if len(args) > 0 else ""
            message = args[1] if len(args) > 1 else ""
            voice = ""
            for candidate in reversed(args[2:]):
                candidate = candidate.strip()
                if re.match(r"^(?:m?cv|vc|bgv|bgm|se)_?", candidate, re.IGNORECASE):
                    voice = candidate
                    break
            item.update({"speaker": speaker, "message": message, "voice": voice})
            if voice:
                audio_ids.add(voice)
            messages.append(item)
        elif cmd in ("l2dmotion", "asyncl2dmotion"):
            motion = args[0].strip() if args else ""
            item["motion"] = motion
            if len(args) > 3:
                item["delay"] = parse_float(args[3])
            if motion:
                motions.append(motion)
        elif cmd == "l2dshow":
            item["model"] = args[0].strip() if args else ""
        elif cmd in ("bgmplay", "bgvplay"):
            cue = args[1].strip() if len(args) > 1 else ""
            item["cue"] = cue
            if cue:
                audio_ids.add(cue)
        elif cmd in ("bgmstop", "bgvstop"):
            item["tag"] = args[0].strip() if args else ""
        elif cmd == "wait":
            item["seconds"] = parse_float(args[0]) if args else 0
        elif cmd == "fade":
            item["direction"] = args[0].strip() if args else ""
            item["color"] = args[1].strip() if len(args) > 1 else ""
            item["seconds"] = parse_float(args[2]) if len(args) > 2 else 0
        elif cmd in ("waitorclick", "asyncskipwait"):
            item["seconds"] = parse_float(args[0]) if args else 0
        elif cmd in ("asyncfade", "asynctransitionfade", "transitionfade"):
            item["direction"] = args[0].strip() if args else ""
            item["color"] = args[1].strip() if len(args) > 1 else ""
            item["seconds"] = parse_float(args[2]) if len(args) > 2 else 0

        commands.append(item)
        index += 1

    return {
        "commands": commands,
        "messages": messages,
        "labels": labels,
        "audioIds": sorted(audio_ids),
        "motions": sorted(set(motions)),
        "commandCounts": dict(sorted(counts.items())),
    }


def parse_float(value, default=0.0):
    try:
        return float(str(value).strip())
    except Exception:
        return default


def pptr_path_id(pptr):
    try:
        return pptr.path_id
    except Exception:
        return 0


def pptr_reader(pptr):
    if pptr is None:
        return None
    reader = getattr(pptr, "object_reader", None)
    if reader is not None:
        return reader
    try:
        obj = pptr.read()
    except Exception:
        return None
    return getattr(obj, "reader", None)


def motion_name_from_fade(name: str, tree: dict):
    motion_name = tree.get("MotionName") or ""
    base = Path(str(motion_name).replace("\\", "/")).name
    lower = base.lower()
    if lower.endswith(".motion3.json"):
        base = base[: -len(".motion3.json")]
    elif lower.endswith(".json"):
        base = Path(base).stem
    if not base:
        base = name or "motion"
    if base.lower().endswith(".fade"):
        base = base[: -len(".fade")]
    return safe_name(base, "motion")


def motion_group_for_name(name: str, bundle: str):
    low = (name or "").lower()
    path_low = (bundle or "").lower()
    if low.startswith("scene") or "/animations/" in path_low.replace("\\", "/"):
        return "Scene"
    for prefix in (
        "EyeOpen",
        "EyeEmotion",
        "EyebrowEmotion",
        "MouthEmotion",
        "FaceAngle",
        "BodyAngle",
        "Body",
        "Arm",
        "Hand",
        "Breath",
    ):
        if name.startswith(prefix):
            return prefix
    match = re.match(r"^([A-Za-z]+)", name or "")
    return match.group(1) if match else "Additive"


def curve_keyframes(curve):
    if isinstance(curve, dict):
        keys = curve.get("m_Curve") or curve.get("keys") or []
    else:
        keys = []
    out = []
    for key in keys:
        if not isinstance(key, dict):
            continue
        time = parse_float(key.get("time"), 0.0)
        value = parse_float(key.get("value"), 0.0)
        out.append((time, value))
    out.sort(key=lambda x: x[0])
    return out


def crc32_path_hash(path: str) -> int:
    return zlib.crc32(path.encode("utf-8")) & 0xFFFFFFFF


def unity_transform_paths(env) -> dict[int, str]:
    game_names: dict[int, str] = {}
    transform_to_go: dict[int, int] = {}
    go_to_transform: dict[int, int] = {}
    parent_transform: dict[int, int] = {}

    for obj in env.objects:
        if obj.type.name == "GameObject":
            data = obj.read()
            game_names[obj.path_id] = unity_object_name(data, f"GameObject_{obj.path_id}")
            for component in getattr(data, "m_Components", []) or []:
                reader = pptr_reader(component)
                if reader is not None and reader.type.name == "Transform":
                    go_to_transform[obj.path_id] = reader.path_id
                    transform_to_go[reader.path_id] = obj.path_id
                    break
        elif obj.type.name == "Transform":
            data = obj.read()
            go_id = pptr_path_id(data.m_GameObject)
            transform_to_go[obj.path_id] = go_id
            go_to_transform[go_id] = obj.path_id
            parent_transform[obj.path_id] = pptr_path_id(data.m_Father)

    def full_path(transform_id: int) -> str:
        parts = []
        seen = set()
        current = transform_id
        while current and current not in seen:
            seen.add(current)
            go_id = transform_to_go.get(current)
            parts.append(game_names.get(go_id, f"GameObject_{go_id}"))
            current = parent_transform.get(current, 0)
        return "/".join(reversed(parts))

    paths = {}
    for go_id, transform_id in go_to_transform.items():
        paths[go_id] = full_path(transform_id)
    return paths


def live2d_parameter_hashes(env) -> dict[int, str]:
    hashes: dict[int, str] = {}
    for path in unity_transform_paths(env).values():
        parts = path.split("/", 1)
        relative = parts[1] if len(parts) > 1 else parts[0]
        if not relative.startswith("Parameters/"):
            continue
        parameter_id = relative.rsplit("/", 1)[-1]
        if parameter_id:
            hashes[crc32_path_hash(relative)] = parameter_id
    return hashes


def finite_time(value, default=0.0) -> float:
    number = parse_float(value, default)
    if not math.isfinite(number) or number < -1.0e20:
        return default
    return max(0.0, number)


def animation_clip_duration(clip) -> float:
    muscle = getattr(clip, "m_MuscleClip", None)
    start = finite_time(getattr(muscle, "m_StartTime", 0.0), 0.0) if muscle else 0.0
    stop = finite_time(getattr(muscle, "m_StopTime", 0.0), 0.0) if muscle else 0.0
    duration = max(0.0, stop - start)
    if duration > 0:
        return duration
    return 0.001


def add_motion_key(keys: dict[str, list[dict]], parameter_id: str, time: float, value: float, out_slope=0.0, in_slope=0.0):
    keys.setdefault(parameter_id, []).append({
        "time": finite_time(time, 0.0),
        "value": parse_float(value, 0.0),
        "outSlope": parse_float(out_slope, 0.0),
        "inSlope": parse_float(in_slope, 0.0),
    })


def motion_segments_from_keys(raw_keys: list[dict], duration: float):
    by_time: dict[float, dict] = {}
    for key in raw_keys:
        time = finite_time(key.get("time"), 0.0)
        by_time[time] = {**key, "time": time}
    keys = sorted(by_time.values(), key=lambda item: item["time"])
    if not keys:
        return None, 0, 0
    if keys[0]["time"] > 0.0:
        keys.insert(0, {**keys[0], "time": 0.0})
    if len(keys) == 1:
        end_time = max(duration, keys[0]["time"] + 0.001)
        keys.append({**keys[0], "time": end_time})
    duration = max(duration, keys[-1]["time"])

    segments = [keys[0]["time"], keys[0]["value"]]
    segment_count = 0
    for previous, current in zip(keys, keys[1:]):
        start_time = previous["time"]
        end_time = current["time"]
        if end_time <= start_time:
            continue
        out_slope = parse_float(previous.get("outSlope"), 0.0)
        in_slope = parse_float(current.get("inSlope"), 0.0)
        if math.isfinite(out_slope) and math.isfinite(in_slope) and (abs(out_slope) > 1.0e-5 or abs(in_slope) > 1.0e-5):
            delta = end_time - start_time
            segments.extend([
                1,
                start_time + delta / 3.0,
                previous["value"] + out_slope * delta / 3.0,
                start_time + delta * 2.0 / 3.0,
                current["value"] - in_slope * delta / 3.0,
                end_time,
                current["value"],
            ])
        else:
            segments.extend([0, end_time, current["value"]])
        segment_count += 1
    return segments, segment_count, len(keys)


def motion3_from_animation_clip(clip, bundle: str, parameter_hashes: dict[int, str]):
    if not parameter_hashes:
        return None

    motion_name = safe_name(str(getattr(clip, "name", "") or getattr(clip, "m_Name", "") or "animation"), "motion")
    duration = animation_clip_duration(clip)
    binding_constant = getattr(clip, "m_ClipBindingConstant", None)
    if binding_constant is None:
        return None

    bindings = getattr(binding_constant, "genericBindings", []) or []
    keys: dict[str, list[dict]] = {}
    clip_data = unwrap_offset_ptr(getattr(getattr(clip, "m_MuscleClip", None), "m_Clip", None))
    streamed = getattr(clip_data, "m_StreamedClip", None)
    streamed_count = int(getattr(streamed, "curveCount", 0) or 0)

    if streamed is not None and streamed_count > 0:
        try:
            frames = streamed.ReadData()
        except Exception:
            frames = []
        for frame in frames:
            time = finite_time(getattr(frame, "time", 0.0), 0.0)
            for curve_key in getattr(frame, "keyList", []) or []:
                binding = binding_constant.FindBinding(curve_key.index)
                if binding is None or binding.typeID != ClassIDType.MonoBehaviour:
                    continue
                parameter_id = parameter_hashes.get(binding.path)
                if not parameter_id:
                    continue
                add_motion_key(
                    keys,
                    parameter_id,
                    time,
                    getattr(curve_key, "value", 0.0),
                    getattr(curve_key, "outSlope", 0.0),
                    getattr(curve_key, "inSlope", 0.0),
                )

    constant = getattr(clip_data, "m_ConstantClip", None)
    constant_values = list(getattr(constant, "data", []) or [])
    for offset, value in enumerate(constant_values):
        binding_index = streamed_count + offset
        if binding_index >= len(bindings):
            continue
        binding = bindings[binding_index]
        if binding.typeID != ClassIDType.MonoBehaviour:
            continue
        parameter_id = parameter_hashes.get(binding.path)
        if not parameter_id or parameter_id in keys:
            continue
        add_motion_key(keys, parameter_id, 0.0, value)
        add_motion_key(keys, parameter_id, duration, value)

    dense = getattr(clip_data, "m_DenseClip", None)
    dense_curve_count = int(getattr(dense, "m_CurveCount", 0) or 0) if dense is not None else 0
    dense_frame_count = int(getattr(dense, "m_FrameCount", 0) or 0) if dense is not None else 0
    dense_samples = list(getattr(dense, "m_SampleArray", []) or []) if dense is not None else []
    dense_rate = parse_float(getattr(dense, "m_SampleRate", 30.0), 30.0) if dense is not None else 30.0
    if dense_curve_count > 0 and dense_frame_count > 0 and dense_samples:
        start_index = streamed_count + len(constant_values)
        for curve_offset in range(dense_curve_count):
            binding_index = start_index + curve_offset
            if binding_index >= len(bindings):
                continue
            binding = bindings[binding_index]
            if binding.typeID != ClassIDType.MonoBehaviour:
                continue
            parameter_id = parameter_hashes.get(binding.path)
            if not parameter_id:
                continue
            for frame_index in range(dense_frame_count):
                sample_index = frame_index * dense_curve_count + curve_offset
                if sample_index >= len(dense_samples):
                    break
                add_motion_key(keys, parameter_id, frame_index / max(0.001, dense_rate), dense_samples[sample_index])

    curves = []
    total_segments = 0
    total_points = 0
    for parameter_id in sorted(keys):
        segments, segment_count, point_count = motion_segments_from_keys(keys[parameter_id], duration)
        if not segments:
            continue
        curves.append({
            "Target": "Parameter",
            "Id": parameter_id,
            "Segments": segments,
        })
        total_segments += segment_count
        total_points += point_count
        duration = max(duration, parse_float(segments[-2], duration) if len(segments) >= 3 else duration)

    if not curves:
        return None

    loop = motion_name.lower().endswith("_loop")
    motion3 = {
        "Version": 3,
        "Meta": {
            "Duration": duration,
            "Fps": parse_float(getattr(clip, "m_SampleRate", 30.0), 30.0),
            "Loop": loop,
            "AreBeziersRestricted": True,
            "CurveCount": len(curves),
            "TotalSegmentCount": total_segments,
            "TotalPointCount": total_points,
            "UserDataCount": 0,
            "TotalUserDataSize": 0,
        },
        "Curves": curves,
    }
    return {
        "name": motion_name,
        "group": motion_group_for_name(motion_name, bundle),
        "duration": duration,
        "loop": loop,
        "fadeInTime": -1.0,
        "fadeOutTime": -1.0,
        "motion3": motion3,
    }


def motion3_from_fade_tree(name: str, bundle: str, tree: dict):
    parameter_ids = tree.get("ParameterIds")
    parameter_curves = tree.get("ParameterCurves")
    if not isinstance(parameter_ids, list) or not isinstance(parameter_curves, list):
        return None
    if not parameter_ids or len(parameter_ids) != len(parameter_curves):
        return None

    duration = max(parse_float(tree.get("MotionLength"), 0.0), 0.0)
    fade_in = parse_float(tree.get("FadeInTime"), -1.0)
    fade_out = parse_float(tree.get("FadeOutTime"), -1.0)
    fade_ins = tree.get("ParameterFadeInTimes") or []
    fade_outs = tree.get("ParameterFadeOutTimes") or []
    curves = []
    total_segments = 0
    total_points = 0

    for index, param_id in enumerate(parameter_ids):
        keys = curve_keyframes(parameter_curves[index])
        if not keys:
            continue
        if len(keys) == 1:
            end_time = duration if duration > keys[0][0] else keys[0][0] + 0.001
            keys.append((end_time, keys[0][1]))
        duration = max(duration, keys[-1][0])
        segments = [keys[0][0], keys[0][1]]
        for time, value in keys[1:]:
            segments.extend([0, time, value])
        curve = {
            "Target": "Parameter",
            "Id": str(param_id),
            "Segments": segments,
        }
        param_fade_in = parse_float(fade_ins[index], fade_in) if index < len(fade_ins) else fade_in
        param_fade_out = parse_float(fade_outs[index], fade_out) if index < len(fade_outs) else fade_out
        if param_fade_in >= 0:
            curve["FadeInTime"] = param_fade_in
        if param_fade_out >= 0:
            curve["FadeOutTime"] = param_fade_out
        curves.append(curve)
        total_segments += max(0, len(keys) - 1)
        total_points += len(keys)

    if not curves:
        return None

    motion_name = motion_name_from_fade(name, tree)
    loop = motion_name.lower().endswith("_loop") or "/loop." in bundle.replace("\\", "/").lower()
    motion3 = {
        "Version": 3,
        "Meta": {
            "Duration": duration,
            "Fps": 30.0,
            "Loop": loop,
            "AreBeziersRestricted": True,
            "CurveCount": len(curves),
            "TotalSegmentCount": total_segments,
            "TotalPointCount": total_points,
            "UserDataCount": 0,
            "TotalUserDataSize": 0,
        },
        "Curves": curves,
    }
    return {
        "name": motion_name,
        "group": motion_group_for_name(motion_name, bundle),
        "duration": duration,
        "loop": loop,
        "fadeInTime": fade_in,
        "fadeOutTime": fade_out,
        "motion3": motion3,
    }


def looks_like_script(text: str) -> bool:
    for _, row in csv_rows(text):
        cmd = normalize_command(row)
        return cmd in COMMAND_INFO or cmd == ":label"
    return False


def story_id_from_path(path: Path, fallback: str) -> str:
    parts = list(path.parts)
    for part in reversed(parts):
        if re.fullmatch(r"\d{8,}", part):
            return part
    m = re.search(r"(\d{8,})", fallback)
    return m.group(1) if m else safe_name(fallback)


def discover_story_roots(bundle_root: Path, limit: int = 0, prefix: str = ""):
    script_bundles = sorted(bundle_root.glob("**/*.txt_*.bundle"))
    roots = []
    seen = set()
    for bundle in script_bundles:
        if "novel" not in str(bundle).lower():
            continue
        story_id = story_id_from_path(bundle.parent, bundle.name)
        if prefix and not story_id.startswith(prefix):
            continue
        root = None
        for parent in [bundle.parent, *bundle.parents]:
            if parent.name == story_id:
                root = parent
                break
        root = root or bundle.parent
        key = str(root.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        roots.append(root)
        if limit and len(roots) >= limit:
            break
    return roots


def collect_manifest(manifest_path: Path, story_id: str, audio_ids):
    if not manifest_path or not manifest_path.exists():
        return {"entries": [], "audio": []}
    entries = []
    audio = []
    ids = [story_id] + list(audio_ids)
    with manifest_path.open("r", encoding="utf-8", errors="ignore") as f:
        header = f.readline().rstrip("\n").split("\t")
        for line in f:
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 2:
                continue
            row = dict(zip(header, cols))
            hay = "\t".join(cols)
            if story_id and story_id in hay:
                entries.append(row)
            if any(token and token in hay for token in ids) and "sound" in hay.lower():
                audio.append(row)
    return {"entries": entries[:300], "audio": audio[:100]}


def find_vgmstream_cli(explicit: str = None):
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    local = Path(__file__).resolve().parent / "bin" / "vgmstream" / "vgmstream-cli.exe"
    candidates.append(local)
    path_hit = shutil.which("vgmstream-cli") or shutil.which("vgmstream-cli.exe")
    if path_hit:
        candidates.append(Path(path_hit))
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate.resolve()
    return None


def manifest_row_path(row, bundle_root: Path):
    for key in ("outputRelativePath", "LocalPath", "localPath", "path"):
        value = row.get(key)
        if value:
            path = Path(value)
            return path if path.is_absolute() else bundle_root / path
    return None


def add_unique_path(paths, seen, path: Path):
    if not path:
        return
    try:
        resolved = path.resolve()
    except Exception:
        resolved = path
    key = str(resolved).lower()
    if key not in seen and path.exists():
        paths.append(path)
        seen.add(key)


def find_audio_candidates(manifest, story_id: str, audio_ids, bundle_root: Path, audio_roots):
    paths = []
    seen = set()

    for row in manifest.get("audio", []):
        add_unique_path(paths, seen, manifest_row_path(row, bundle_root))

    if not paths and bundle_root.exists():
        patterns = [
            f"*{story_id}*.acb*.bundle",
            f"*{story_id}*.awb*.bundle",
            f"*{story_id}*.bundle",
        ]
        for pattern in patterns:
            for path in bundle_root.rglob(pattern):
                if "sound" in str(path).lower():
                    add_unique_path(paths, seen, path)

    bgm_ids = sorted({aid for aid in audio_ids if re.match(r"^bgm\d+", aid or "", re.IGNORECASE)})
    for root in audio_roots:
        root = Path(root)
        if not root.exists():
            continue
        for bgm_id in bgm_ids:
            for pattern in (f"*{bgm_id}.awb*", f"*{bgm_id}.acb*"):
                for path in root.rglob(pattern):
                    if "sound" in str(path).lower():
                        add_unique_path(paths, seen, path)

    return paths


def cri_bundle_name(path: Path, fallback: str = "audio"):
    name = path.name
    match = re.search(r"([^\\/]+?\.(?:acb|awb))(?:_[0-9a-f]{8,})?\.bundle$", name, re.IGNORECASE)
    if match:
        return safe_name(match.group(1))
    lower = name.lower()
    for ext in (".acb", ".awb"):
        index = lower.find(ext)
        if index >= 0:
            return safe_name(name[: index + len(ext)])
    return safe_name(fallback)


def write_once(path: Path, data: bytes):
    if path.exists() and path.stat().st_size == len(data):
        return
    write_bytes(path, data)


def extract_cri_payloads(bundle: Path, raw_dir: Path):
    exported = []
    file_bytes = bundle.read_bytes()
    direct_ext = None
    direct_offset = 0
    if file_bytes.startswith(b"@UTF"):
        direct_ext = ".acb"
    elif file_bytes.startswith(b"AFS2"):
        direct_ext = ".awb"
    else:
        for sig, ext in ((b"@UTF", ".acb"), (b"AFS2", ".awb")):
            pos = file_bytes.find(sig)
            if 0 <= pos < 256:
                direct_ext = ext
                direct_offset = pos
                break

    if direct_ext:
        out_name = cri_bundle_name(bundle)
        if not out_name.lower().endswith(direct_ext):
            out_name = Path(out_name).stem + direct_ext
        out_path = raw_dir / out_name
        write_once(out_path, file_bytes[direct_offset:])
        exported.append({"path": out_path, "source": bundle, "bytes": out_path.stat().st_size})
        return exported

    try:
        env = UnityPy.load(str(bundle))
    except Exception as exc:
        return [{"source": bundle, "error": "UnityPy load: " + repr(exc)}]

    used_names = set()
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        raw = bytes(obj.get_raw_data())
        utf = raw.find(b"@UTF")
        afs2 = raw.find(b"AFS2")
        if utf >= 0 and (afs2 < 0 or utf < afs2):
            offset = utf
            ext = ".acb"
        elif afs2 >= 0:
            offset = afs2
            ext = ".awb"
        else:
            continue

        try:
            name = getattr(obj.read(), "name", "") or cri_bundle_name(bundle)
        except Exception:
            name = cri_bundle_name(bundle)
        out_name = unique_name(safe_name(Path(name).stem), used_names, ext)
        out_path = raw_dir / out_name
        write_once(out_path, raw[offset:])
        exported.append({"path": out_path, "source": bundle, "bytes": out_path.stat().st_size})

    return exported


def run_vgmstream_info(vgmstream: Path, raw_path: Path, subsong=None):
    args = [str(vgmstream), "-i"]
    if subsong:
        args.extend(["-s", str(subsong)])
    args.append("-I")
    args.append(str(raw_path))
    proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    cleanup_vgmstream_sidecars(raw_path, subsong)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "").strip() or f"vgmstream failed with {proc.returncode}")
    return json.loads(proc.stdout)


def cleanup_vgmstream_sidecars(raw_path: Path, subsong=None):
    candidates = [raw_path.with_name(raw_path.name + ".wav")]
    if subsong:
        candidates.append(raw_path.with_name(f"{raw_path.name}#{subsong}.wav"))
    for candidate in candidates:
        try:
            if candidate.exists():
                candidate.unlink()
        except Exception:
            pass


def run_vgmstream_decode(vgmstream: Path, raw_path: Path, out_path: Path, subsong=None):
    if out_path.exists() and out_path.stat().st_size > 44:
        return
    out_path.parent.mkdir(parents=True, exist_ok=True)
    args = [str(vgmstream), "-i"]
    if subsong:
        args.extend(["-s", str(subsong)])
    args.extend(["-o", str(out_path), str(raw_path)])
    proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "").strip() or f"vgmstream failed with {proc.returncode}")


def audio_category(cue_name: str):
    low = (cue_name or "").lower()
    if low.startswith("vc_"):
        return "voice"
    if low.startswith("bgv_"):
        return "bgv"
    if low.startswith("bgm"):
        return "bgm"
    return "misc"


def convert_cri_payload(raw_info, story_out: Path, vgmstream: Path, audio_ids):
    raw_path = raw_info["path"]
    decoded_dir = story_out / "audio" / "decoded"
    decoded = []
    cues = {}

    first = run_vgmstream_info(vgmstream, raw_path)
    stream_info = first.get("streamInfo") or {}
    total = int(stream_info.get("total") or 1)
    subsongs = range(1, total + 1) if total > 1 else [None]
    wanted = set(audio_ids or [])

    for subsong in subsongs:
        info = first if subsong is None else run_vgmstream_info(vgmstream, raw_path, subsong)
        stream = info.get("streamInfo") or {}
        cue_name = stream.get("name") or raw_path.stem
        if wanted and cue_name not in wanted and not cue_name.lower().startswith(("vc_", "bgv_", "bgm")):
            continue
        category = audio_category(cue_name)
        out_path = decoded_dir / category / f"{safe_name(cue_name)}.wav"
        run_vgmstream_decode(vgmstream, raw_path, out_path, subsong)
        duration = None
        sample_rate = info.get("sampleRate")
        sample_count = info.get("numberOfSamples") or info.get("playSamples")
        if sample_rate and sample_count:
            duration = sample_count / sample_rate
        rel = out_path.relative_to(story_out).as_posix()
        item = {
            "name": cue_name,
            "category": category,
            "path": rel,
            "source": raw_path.relative_to(story_out).as_posix(),
            "subsong": subsong or 1,
            "duration": duration,
            "sampleRate": sample_rate,
            "channels": info.get("channels"),
            "encoding": info.get("encoding"),
            "bytes": out_path.stat().st_size,
        }
        decoded.append(item)
        cues[cue_name] = item

    return decoded, cues


def extract_audio_assets(story_out: Path, manifest, story_id: str, audio_ids, bundle_root: Path, audio_roots, vgmstream_path: str = None):
    audio = {
        "cues": {},
        "raw": [],
        "decoded": [],
        "errors": [],
        "decoder": None,
    }
    raw_dir = story_out / "audio" / "raw"
    if raw_dir.exists():
        for stale in raw_dir.glob("*.wav"):
            stale.unlink()
    candidates = find_audio_candidates(manifest, story_id, audio_ids, bundle_root, audio_roots)
    vgmstream = find_vgmstream_cli(vgmstream_path)
    audio["decoder"] = Path(vgmstream).name if vgmstream else None
    raw_seen = set()

    for candidate in candidates:
        try:
            payloads = extract_cri_payloads(candidate, raw_dir)
            for payload in payloads:
                if "error" in payload:
                    audio["errors"].append({
                        "source": clean_source_path(payload.get("source"), bundle_root),
                        "error": payload["error"],
                    })
                    continue
                rel_raw = payload["path"].relative_to(story_out).as_posix()
                if rel_raw.lower() in raw_seen:
                    continue
                raw_seen.add(rel_raw.lower())
                raw_item = {
                    "path": rel_raw,
                    "source": clean_source_path(payload["source"], bundle_root),
                    "bytes": payload["bytes"],
                }
                audio["raw"].append(raw_item)
                if not vgmstream:
                    continue
                try:
                    decoded, cues = convert_cri_payload(payload, story_out, vgmstream, audio_ids)
                    audio["decoded"].extend(decoded)
                    audio["cues"].update(cues)
                except Exception as exc:
                    is_bgm_cuesheet = payload["path"].suffix.lower() == ".acb" and payload["path"].stem.lower().startswith("bgm")
                    if not is_bgm_cuesheet:
                        audio["errors"].append({
                            "source": payload["path"].name,
                            "error": repr(exc),
                        })
        except Exception as exc:
            audio["errors"].append({"source": clean_source_path(candidate, bundle_root), "error": repr(exc)})

    return audio


def clean_source_path(path, base: Path | None = None) -> str:
    if path is None:
        return ""
    source = Path(path)
    if base is not None:
        for candidate_base in (base, base.resolve() if base.exists() else base):
            try:
                return source.relative_to(candidate_base).as_posix()
            except ValueError:
                continue
    if source.is_absolute():
        return source.name
    return source.as_posix()


def ref_to_dict(value):
    if isinstance(value, dict):
        return value
    return {"value": str(value)}


def extract_story(
    root: Path,
    output_root: Path,
    manifest_path: Path = None,
    export_textures: bool = True,
    bundle_root: Path = None,
    audio_roots=None,
    export_audio: bool = True,
    vgmstream_path: str = None,
    story_id_override: str = None,
):
    source_story_id = story_id_from_path(root, root.name)
    story_id = story_id_override or source_story_id
    story_out = output_root / "stories" / story_id
    textasset_dir = story_out / "textassets"
    texture_dir = story_out / "textures"
    moc_dir = story_out / "moc"
    motion_dir = story_out / "motions"
    meta_dir = story_out / "meta"
    story_out.mkdir(parents=True, exist_ok=True)

    scripts = []
    live2d = {
        "moc": None,
        "textures": [],
        "animations": [],
        "motions": [],
        "fadeMotions": [],
        "monoBehaviours": [],
        "model3": None,
    }
    bundle_errors = []
    texture_names = set()
    text_names = set()
    motion_names = set()

    for bundle in sorted(root.glob("**/*.bundle")):
        rel_bundle = bundle.relative_to(root).as_posix()
        try:
            env = UnityPy.load(str(bundle))
        except Exception as exc:
            bundle_errors.append({"bundle": rel_bundle, "error": repr(exc)})
            continue
        parameter_hashes = None

        for obj in env.objects:
            try:
                typ = obj.type.name
                if typ not in ("TextAsset", "Texture2D", "AnimationClip", "MonoBehaviour"):
                    continue
                data = obj.read()
                name = unity_object_name(data, f"{typ}_{obj.path_id}")

                if typ == "TextAsset":
                    text = decode_text_asset(unity_text_asset_script(data))
                    out_name = unique_name(safe_name(name), text_names, ".txt")
                    rel = Path("textassets") / out_name
                    (story_out / rel).parent.mkdir(parents=True, exist_ok=True)
                    (story_out / rel).write_text(text, encoding="utf-8")
                    if looks_like_script(text):
                        parsed = parse_script(text)
                        scripts.append({
                            "id": safe_name(name),
                            "name": name,
                            "bundle": rel_bundle,
                            "text": rel.as_posix(),
                            "lineCount": len(text.splitlines()),
                            **parsed,
                        })

                elif typ == "Texture2D" and export_textures:
                    out_name = unique_name(safe_name(name), texture_names, ".png")
                    rel = Path("textures") / out_name
                    try:
                        image = data.image
                        (story_out / rel).parent.mkdir(parents=True, exist_ok=True)
                        image.save(story_out / rel)
                        live2d["textures"].append({
                            "name": name,
                            "path": rel.as_posix(),
                            "width": getattr(data, "m_Width", None),
                            "height": getattr(data, "m_Height", None),
                            "bundle": rel_bundle,
                        })
                    except Exception as exc:
                        bundle_errors.append({"bundle": rel_bundle, "object": name, "error": "texture export: " + repr(exc)})

                elif typ == "AnimationClip":
                    live2d["animations"].append({"name": name, "bundle": rel_bundle, "pathId": obj.path_id})
                    try:
                        if parameter_hashes is None:
                            parameter_hashes = live2d_parameter_hashes(env)
                        exported_motion = motion3_from_animation_clip(data, rel_bundle, parameter_hashes)
                        if exported_motion:
                            out_name = unique_name(exported_motion["name"], motion_names, ".motion3.json")
                            rel = Path("motions") / out_name
                            write_json(story_out / rel, exported_motion["motion3"])
                            motion_item = {
                                "name": exported_motion["name"],
                                "group": exported_motion["group"],
                                "path": rel.as_posix(),
                                "duration": exported_motion["duration"],
                                "loop": exported_motion["loop"],
                                "fadeInTime": exported_motion["fadeInTime"],
                                "fadeOutTime": exported_motion["fadeOutTime"],
                                "bundle": rel_bundle,
                                "pathId": obj.path_id,
                                "source": "AnimationClip",
                            }
                            live2d["motions"].append(motion_item)
                    except Exception as exc:
                        bundle_errors.append({"bundle": rel_bundle, "object": name, "error": "animation motion export: " + repr(exc)})

                elif typ == "MonoBehaviour":
                    entry = {"name": name, "bundle": rel_bundle, "pathId": obj.path_id}
                    try:
                        tree = obj.read_typetree()
                        exported_motion = None
                        if "_bytes" in tree:
                            b = bytes(tree["_bytes"])
                            if b[:4] == b"MOC3":
                                moc_name = safe_name(name) + ".moc3"
                                rel = Path("moc") / moc_name
                                write_bytes(story_out / rel, b)
                                live2d["moc"] = {"name": name, "path": rel.as_posix(), "bytes": len(b), "bundle": rel_bundle}
                        exported_motion = motion3_from_fade_tree(name, rel_bundle, tree)
                        if exported_motion:
                            out_name = unique_name(exported_motion["name"], motion_names, ".motion3.json")
                            rel = Path("motions") / out_name
                            write_json(story_out / rel, exported_motion["motion3"])
                            motion_item = {
                                "name": exported_motion["name"],
                                "group": exported_motion["group"],
                                "path": rel.as_posix(),
                                "duration": exported_motion["duration"],
                                "loop": exported_motion["loop"],
                                "fadeInTime": exported_motion["fadeInTime"],
                                "fadeOutTime": exported_motion["fadeOutTime"],
                                "bundle": rel_bundle,
                                "pathId": obj.path_id,
                            }
                            live2d["motions"].append(motion_item)
                            entry["motion"] = motion_item
                        if "MotionInstanceIds" in tree or "CubismFadeMotionObjects" in tree:
                            entry["motionInstanceCount"] = len(tree.get("MotionInstanceIds", []))
                            entry["fadeMotionObjectCount"] = len(tree.get("CubismFadeMotionObjects", []))
                            live2d["fadeMotions"].append(entry)
                        elif name and not exported_motion:
                            live2d["monoBehaviours"].append(entry)
                    except Exception:
                        if name:
                            live2d["monoBehaviours"].append(entry)

            except Exception as exc:
                bundle_errors.append({"bundle": rel_bundle, "pathId": getattr(obj, "path_id", None), "error": repr(exc)})

    live2d["animations"] = sorted(live2d["animations"], key=lambda x: x["name"].lower())
    live2d["motions"] = sorted(live2d["motions"], key=lambda x: (x["group"].lower(), natural_key(x["name"])))
    live2d["monoBehaviours"] = live2d["monoBehaviours"][:300]

    if live2d["moc"] and live2d["textures"]:
        model_motions = defaultdict(list)
        for motion in live2d["motions"]:
            group = motion.get("group") or "Additive"
            motion["index"] = len(model_motions[group])
            item = {"File": motion["path"]}
            if motion.get("fadeInTime", -1) >= 0:
                item["FadeInTime"] = motion["fadeInTime"]
            if motion.get("fadeOutTime", -1) >= 0:
                item["FadeOutTime"] = motion["fadeOutTime"]
            model_motions[group].append(item)
        idle_motion = next((m for m in live2d["motions"] if m["name"].lower().endswith("_loop")), None)
        if idle_motion:
            model_motions["Idle"].append({"File": idle_motion["path"]})

        model_textures = sorted(
            [t for t in live2d["textures"] if t["width"] and t["height"] and t["width"] >= 512],
            key=lambda t: natural_key(t["name"]),
        )
        model3 = {
            "Version": 3,
            "FileReferences": {
                "Moc": live2d["moc"]["path"],
                "Textures": [t["path"] for t in model_textures],
                "Motions": dict(sorted(model_motions.items())),
            },
            "Groups": [],
            "HitAreas": [],
        }
        model3_path = story_out / f"{story_id}.model3.json"
        write_json(model3_path, model3)
        live2d["model3"] = model3_path.relative_to(story_out).as_posix()

    primary_script = scripts[0] if scripts else None
    audio_ids = primary_script["audioIds"] if primary_script else []
    manifest = collect_manifest(manifest_path, source_story_id, audio_ids)
    audio = {"cues": {}, "raw": [], "decoded": [], "errors": [], "decoder": None}
    if export_audio:
        audio = extract_audio_assets(
            story_out,
            manifest,
            source_story_id,
            audio_ids,
            bundle_root or (manifest_path.parent if manifest_path else Path(".")),
            audio_roots or [],
            vgmstream_path,
        )

    command_counts = primary_script["commandCounts"] if primary_script else {}
    command_defs = {cmd: COMMAND_INFO.get(cmd, {}) for cmd in command_counts}
    root_label = clean_source_path(root, bundle_root or root.parent)
    story = {
        "id": story_id,
        "sourceId": source_story_id,
        "root": root_label,
        "scripts": scripts,
        "primaryScript": primary_script["id"] if primary_script else None,
        "live2d": live2d,
        "audio": audio,
        "manifest": manifest,
        "bundleErrors": bundle_errors[:200],
        "commandDefinitions": command_defs,
        "stats": {
            "scriptCount": len(scripts),
            "messageCount": sum(len(s["messages"]) for s in scripts),
            "textureCount": len(live2d["textures"]),
            "animationCount": len(live2d["animations"]),
            "motionCount": len(live2d["motions"]),
            "audioCueCount": len(audio.get("cues", {})),
            "bundleErrorCount": len(bundle_errors),
        },
    }

    write_json(story_out / "story.json", story)
    write_json(story_out / "live2d.json", live2d)
    write_json(meta_dir / "manifest_matches.json", manifest)
    return {
        "id": story_id,
        "title": make_title(primary_script, story_id),
        "path": f"stories/{story_id}/story.json",
        "root": root_label,
        "stats": story["stats"],
    }


def unique_name(base: str, seen: set, suffix: str):
    if base.lower().endswith(suffix.lower()):
        stem = base[: -len(suffix)]
    else:
        stem = base
    candidate = stem + suffix
    i = 2
    while candidate.lower() in seen:
        candidate = f"{stem}_{i}{suffix}"
        i += 1
    seen.add(candidate.lower())
    return candidate


def make_title(script, story_id: str):
    if not script:
        return story_id
    for command in script["commands"]:
        if command["command"] == "charaload" and len(command["args"]) >= 3:
            return f"{command['args'][2]} / {story_id}"
    for message in script["messages"]:
        if message.get("speaker"):
            return f"{message['speaker']} / {story_id}"
    return story_id


def natural_key(value: str):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value or "")]


def make_unique_story_ids(roots):
    source_ids = [story_id_from_path(root, root.name) for root in roots]
    counts = Counter(source_ids)
    used = set()
    result = []
    for root, source_id in zip(roots, source_ids):
        if counts[source_id] <= 1:
            candidate = source_id
        else:
            parts = [p for p in root.parts if p and p != source_id]
            suffix_parts = []
            for part in reversed(parts):
                low = part.lower()
                if low in {"assets", "project", "lazyassets", "novel", "general", "r18-only"}:
                    continue
                suffix_parts.append(safe_name(part))
                if len(suffix_parts) >= 2:
                    break
            suffix = "_".join(reversed(suffix_parts)) or safe_name(root.parent.name)
            candidate = f"{source_id}_{suffix}"
        base = candidate
        i = 2
        while candidate.lower() in used:
            candidate = f"{base}_{i}"
            i += 1
        used.add(candidate.lower())
        result.append(candidate)
    return result


def main():
    configure_stdout()
    load_command_analysis_info(Path(__file__).resolve().parents[1])
    parser = argparse.ArgumentParser(description="Extract DotAbyss ADV novel bundles into the local web player.")
    parser.add_argument("--target", action="append", default=[], help="Story folder containing the .txt bundle and l2d folder.")
    parser.add_argument("--bundle-root", default="workspace/bundles/android-dmm-r18", help="Downloaded bundle root used when --scan-all is set.")
    parser.add_argument("--scan-root", default=None, help="Directory to scan for novel scripts. Defaults to --bundle-root.")
    parser.add_argument("--output", default="src/AdvPlayer/data", help="Player data output directory.")
    parser.add_argument("--manifest", default=None, help="download_manifest.tsv path. Defaults to <bundle-root>/download_manifest.tsv.")
    parser.add_argument("--scan-all", action="store_true", help="Scan bundle-root for all novel script folders.")
    parser.add_argument("--story-prefix", default="", help="Only scan story ids starting with this prefix when --scan-all is set.")
    parser.add_argument("--limit", type=int, default=0, help="Limit scan-all story count.")
    parser.add_argument("--no-textures", action="store_true", help="Skip Texture2D PNG export.")
    parser.add_argument("--no-audio", action="store_true", help="Skip CRI audio extraction and wav conversion.")
    parser.add_argument("--vgmstream", default=None, help="Path to vgmstream-cli.exe. Defaults to tools/bin/vgmstream/vgmstream-cli.exe or PATH.")
    parser.add_argument("--audio-search-root", action="append", default=[], help="Extra root to search for external AWB files.")
    args = parser.parse_args()

    output_root = Path(args.output)
    bundle_root = Path(args.bundle_root)
    manifest_path = Path(args.manifest) if args.manifest else bundle_root / "download_manifest.tsv"
    audio_roots = [bundle_root]
    for path in args.audio_search_root:
        audio_roots.append(Path(path))
    default_webgl_root = Path("catalog_1_downloads")
    if default_webgl_root.exists() and all(p.resolve() != default_webgl_root.resolve() for p in audio_roots if p.exists()):
        audio_roots.append(default_webgl_root)

    roots = [Path(p) for p in args.target]
    if args.scan_all:
        roots.extend(discover_story_roots(Path(args.scan_root) if args.scan_root else bundle_root, args.limit, args.story_prefix))
    if not roots:
        if args.scan_all:
            scan_root = Path(args.scan_root) if args.scan_root else bundle_root
            parser.error(f"--scan-all found no story roots under {scan_root}")
        parser.error("provide --target or --scan-all")

    story_ids = make_unique_story_ids(roots)
    stories = []
    for root, output_story_id in zip(roots, story_ids):
        print(f"extract {root} -> {output_story_id}")
        stories.append(extract_story(
            root,
            output_root,
            manifest_path,
            export_textures=not args.no_textures,
            bundle_root=bundle_root,
            audio_roots=audio_roots,
            export_audio=not args.no_audio,
            vgmstream_path=args.vgmstream,
            story_id_override=output_story_id,
        ))

    index = {
        "generatedBy": "tools/adv_extract.py",
        "stories": stories,
        "commandInfo": COMMAND_INFO,
    }
    write_json(output_root / "index.json", index)
    print(f"wrote {output_root / 'index.json'}")
    for story in stories:
        print(f"{story['id']}: {story['stats']}")


if __name__ == "__main__":
    main()
