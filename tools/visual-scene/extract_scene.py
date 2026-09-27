#!/usr/bin/env python3
"""Extract a bounded Unity scene/object inventory for Visual Maimai.

Requires UnityPy==1.20.26. The target build strips custom MonoBehaviour
TypeTrees, so this script records stable script/object references and all
available built-in object data; it never substitutes C# defaults for scene
values.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from collections import Counter
from pathlib import Path
from typing import Any

import UnityPy
from UnityPy.classes.PPtr import PPtr


DEFAULT_DATA = Path("Visual Maimai/Visual Maimai_Data")
DEFAULT_OUTPUT = Path(".tools/visual-scene/scene-layout.full.json")
DEFAULT_FOCUS_OUTPUT = Path("fixtures/visual-maimai/desktop-layout.json")
SCENE_NAME = "level0"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def vec(value: Any) -> Any:
    if value is None:
        return None
    names = ("x", "y", "z", "w")
    result = [getattr(value, name) for name in names if hasattr(value, name)]
    return result if result else value


def pointer(value: Any) -> dict[str, int] | None:
    if value is None:
        return None
    return {"file_id": value.m_FileID, "path_id": value.m_PathID}


def parse_canvas_scaler(raw: bytes, object_id: int) -> dict[str, Any]:
    if len(raw) != 80:
        raise ValueError(f"CanvasScaler {object_id}: expected 80 serialized bytes, got {len(raw)}")

    scale_mode = struct.unpack_from("<i", raw, 32)[0]
    screen_match_mode = struct.unpack_from("<i", raw, 52)[0]
    physical_unit = struct.unpack_from("<i", raw, 60)[0]
    scale_modes = {0: "ConstantPixelSize", 1: "ScaleWithScreenSize", 2: "ConstantPhysicalSize"}
    screen_modes = {0: "MatchWidthOrHeight", 1: "Expand", 2: "Shrink"}
    physical_units = {0: "Centimeters", 1: "Millimeters", 2: "Inches", 3: "Points", 4: "Picas"}
    return {
        "scale_mode": {"value": scale_mode, "name": scale_modes[scale_mode]},
        "reference_pixels_per_unit": struct.unpack_from("<f", raw, 36)[0],
        "scale_factor": struct.unpack_from("<f", raw, 40)[0],
        "reference_resolution": list(struct.unpack_from("<ff", raw, 44)),
        "screen_match_mode": {"value": screen_match_mode, "name": screen_modes[screen_match_mode]},
        "match_width_or_height": struct.unpack_from("<f", raw, 56)[0],
        "physical_unit": {"value": physical_unit, "name": physical_units[physical_unit]},
        "fallback_screen_dpi": struct.unpack_from("<f", raw, 64)[0],
        "default_sprite_dpi": struct.unpack_from("<f", raw, 68)[0],
        "dynamic_pixels_per_unit": struct.unpack_from("<f", raw, 72)[0],
        "preset_info_is_world": bool(raw[76]),
        "field_parse": {
            "schema": "UnityEngine.UI.CanvasScaler serialized field declaration order",
            "fields_offset": 32,
            "object_bytes": len(raw),
            "tail_padding_hex": raw[77:].hex(),
        },
    }


def parse_layout_element(raw: bytes, object_id: int) -> dict[str, Any]:
    if len(raw) != 64:
        raise ValueError(f"LayoutElement {object_id}: expected 64 serialized bytes, got {len(raw)}")
    values = struct.unpack_from("<6f", raw, 36)
    return {
        "ignore_layout": bool(raw[32]),
        "min_width": values[0],
        "min_height": values[1],
        "preferred_width": values[2],
        "preferred_height": values[3],
        "flexible_width": values[4],
        "flexible_height": values[5],
        "layout_priority": struct.unpack_from("<i", raw, 60)[0],
        "field_parse": {"schema": "UnityEngine.UI.LayoutElement serialized field declaration order", "fields_offset": 32, "object_bytes": len(raw)},
    }


def parse_horizontal_layout_group(raw: bytes, object_id: int) -> dict[str, Any]:
    if len(raw) != 84:
        raise ValueError(f"HorizontalLayoutGroup {object_id}: expected 84 serialized bytes, got {len(raw)}")
    return {
        "padding_left_right_top_bottom": list(struct.unpack_from("<4i", raw, 32)),
        "child_alignment": struct.unpack_from("<i", raw, 48)[0],
        "spacing": struct.unpack_from("<f", raw, 52)[0],
        "child_force_expand_width": bool(struct.unpack_from("<i", raw, 56)[0]),
        "child_force_expand_height": bool(struct.unpack_from("<i", raw, 60)[0]),
        "child_control_width": bool(struct.unpack_from("<i", raw, 64)[0]),
        "child_control_height": bool(struct.unpack_from("<i", raw, 68)[0]),
        "child_scale_width": bool(struct.unpack_from("<i", raw, 72)[0]),
        "child_scale_height": bool(struct.unpack_from("<i", raw, 76)[0]),
        "reverse_arrangement": bool(struct.unpack_from("<i", raw, 80)[0]),
        "field_parse": {"schema": "UnityEngine.UI.HorizontalLayoutGroup serialized field declaration order", "fields_offset": 32, "object_bytes": len(raw)},
    }


def resolve_script(scene_file: Any, file_id: int, path_id: int) -> dict[str, Any] | None:
    if not path_id:
        return None
    try:
        script = PPtr(m_FileID=file_id, m_PathID=path_id, assetsfile=scene_file).deref()
        data = script.read_typetree()
        return {
            "file_id": file_id,
            "path_id": path_id,
            "name": data.get("m_ClassName") or data.get("m_Name"),
            "namespace": data.get("m_Namespace"),
            "assembly": data.get("m_AssemblyName"),
            "object_name": data.get("m_Name"),
            "script_object_type": script.type.name,
        }
    except Exception as exc:  # retain unresolved pointers as evidence
        return {"file_id": file_id, "path_id": path_id, "error": f"{type(exc).__name__}: {exc}"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--focus-output", type=Path, default=DEFAULT_FOCUS_OUTPUT)
    args = parser.parse_args()

    data_root = args.data_root.resolve()
    env = UnityPy.Environment()
    env.load_folder(str(data_root))
    files = {
        Path(file.name).name: file
        for file in env.files.values()
        if hasattr(file, "objects") and hasattr(file, "header")
    }
    scene = files[SCENE_NAME]

    raw_by_id: dict[int, Any] = scene.objects
    game_objects: dict[int, Any] = {}
    transforms: dict[int, Any] = {}
    script_cache: dict[tuple[int, int], Any] = {}
    components: dict[int, list[dict[str, Any]]] = {}

    for obj in raw_by_id.values():
        kind = obj.type.name
        if kind == "GameObject":
            game_objects[obj.path_id] = obj.read()
        elif kind in ("Transform", "RectTransform"):
            transforms[obj.path_id] = obj.read()

    def go_name(path_id: int) -> str | None:
        game_object = game_objects.get(path_id)
        return game_object.m_Name if game_object else None

    def script_info(file_id: int, path_id: int) -> Any:
        key = (file_id, path_id)
        if key not in script_cache:
            script_cache[key] = resolve_script(scene, file_id, path_id)
        return script_cache[key]

    object_parent_transform: dict[int, int | None] = {}
    object_sibling_index: dict[int, int] = {}
    for transform_id, transform in transforms.items():
        go = transform.m_GameObject
        parent = transform.m_Father
        object_parent_transform[go.m_PathID] = parent.m_PathID if parent.m_PathID else None
        if parent.m_PathID:
            for index, child in enumerate(transforms[parent.m_PathID].m_Children):
                if child.m_PathID == transform_id:
                    object_sibling_index[go.m_PathID] = index
                    break

    for obj in raw_by_id.values():
        if obj.type.name != "MonoBehaviour":
            continue
        raw = obj.get_raw_data()
        if len(raw) < 28:
            continue
        go_path = struct.unpack_from("<q", raw, 4)[0]
        script_file = struct.unpack_from("<i", raw, 16)[0]
        script_path = struct.unpack_from("<q", raw, 20)[0]
        info = script_info(script_file, script_path)
        item = {
            "object_id": obj.path_id,
            "class_id": 114,
            "game_object_id": go_path,
            "game_object": go_name(go_path),
            "enabled": bool(raw[12]),
            "script": info,
            "raw_size": len(raw),
            "serialized_type_script_index": obj.serialized_type.script_type_index if obj.serialized_type else None,
        }
        components.setdefault(go_path, []).append(item)

    rows: list[dict[str, Any]] = []
    for go_id, go in game_objects.items():
        t = next((tr for tr_id, tr in transforms.items() if tr.m_GameObject.m_PathID == go_id), None)
        transform_id = next((tr_id for tr_id, tr in transforms.items() if tr.m_GameObject.m_PathID == go_id), None)
        parent_id = object_parent_transform.get(go_id)
        parent_go_id = None
        if parent_id:
            parent = transforms[parent_id]
            parent_go_id = parent.m_GameObject.m_PathID

        row: dict[str, Any] = {
            "object_id": go_id,
            "name": go.m_Name,
            "active": go.m_IsActive,
            "layer": go.m_Layer,
            "tag": go.m_Tag,
            "parent_id": parent_go_id,
            "transform_id": transform_id,
            "sibling_index": object_sibling_index.get(go_id),
            "components": [],
        }
        if t is not None:
            row["transform"] = {
                "type": "RectTransform" if type(t).__name__ == "RectTransform" else "Transform",
                "local_position": vec(t.m_LocalPosition),
                "local_rotation_xyzw": vec(t.m_LocalRotation),
                "local_scale": vec(t.m_LocalScale),
            }
            if hasattr(t, "m_AnchorMin"):
                row["transform"].update({
                    "anchor_min": vec(t.m_AnchorMin),
                    "anchor_max": vec(t.m_AnchorMax),
                    "anchored_position": vec(t.m_AnchoredPosition),
                    "size_delta": vec(t.m_SizeDelta),
                    "pivot": vec(t.m_Pivot),
                })

        game_object = game_objects[go_id]
        for pair in game_object.m_Component:
            ref = pair.component
            target = raw_by_id.get(ref.m_PathID) if ref.m_FileID == 0 else None
            component: dict[str, Any] = {
                "object_id": ref.m_PathID,
                "class": target.type.name if target else "external",
            }
            if target and target.type.name == "MonoBehaviour":
                details = next((x for x in components.get(go_id, []) if x["object_id"] == ref.m_PathID), None)
                if details:
                    component["script"] = details["script"]
                    component["enabled"] = details["enabled"]
                    component["raw_size"] = details["raw_size"]
                    if details["script"].get("name") == "CanvasScaler":
                        component["serialized_values"] = parse_canvas_scaler(target.get_raw_data(), ref.m_PathID)
                    elif details["script"].get("name") == "LayoutElement":
                        component["serialized_values"] = parse_layout_element(target.get_raw_data(), ref.m_PathID)
                    elif details["script"].get("name") == "HorizontalLayoutGroup":
                        component["serialized_values"] = parse_horizontal_layout_group(target.get_raw_data(), ref.m_PathID)
            elif target:
                try:
                    tree = target.read_typetree()
                    component["name"] = tree.get("m_Name")
                    for key in ("m_SortingOrder", "m_OverrideSorting", "m_Enabled", "m_RenderMode", "m_PixelPerfect", "m_ScaleFactor", "m_ReferencePixelsPerUnit", "m_SortingLayerID", "m_SortingOrder"):
                        if key in tree:
                            component[key] = tree[key]
                except Exception as exc:
                    component["read_error"] = f"{type(exc).__name__}: {exc}"
            row["components"].append(component)
        rows.append(row)

    by_id = {row["object_id"]: row for row in rows}
    roots = [row["object_id"] for row in rows if row["parent_id"] is None]

    def descendants(start_id: int) -> list[int]:
        result: list[int] = []
        stack = [start_id]
        while stack:
            current = stack.pop()
            result.append(current)
            children = [row["object_id"] for row in rows if row["parent_id"] == current]
            stack.extend(reversed(children))
        return result

    scene_sources = [
        "level0",
        "globalgamemanagers.assets",
        "sharedassets0.assets",
        "resources.assets",
        "Managed/UnityEngine.UI.dll",
    ]
    source_hashes = {
        name: sha256(data_root / name)
        for name in scene_sources
        if (data_root / name).is_file()
    }

    layout_keywords = (
        "editor canvas", "main camera", "track", "preview", "wave", "song info",
        "toolbar", "top bar", "bottom bar", "panel", "note", "judgement", "slide",
    )
    layout_ids = {
        row["object_id"]
        for row in rows
        if any(term in row["name"].casefold() for term in layout_keywords)
    }
    layout_ids = {value for id_ in layout_ids for value in descendants(id_)}

    inventory: dict[str, Any] = {}
    for name in scene_sources:
        file = files.get(name)
        if not file:
            continue
        counts = Counter(obj.type.name for obj in file.objects.values())
        named: list[dict[str, Any]] = []
        for obj in file.objects.values():
            entry: dict[str, Any] = {"object_id": obj.path_id, "class": obj.type.name, "bytes": obj.byte_size}
            if obj.type.name == "MonoBehaviour" and file is scene:
                matched = next((x for values in components.values() for x in values if x["object_id"] == obj.path_id), None)
                if matched:
                    entry.update({"game_object_id": matched["game_object_id"], "game_object": matched["game_object"], "script": matched["script"]})
            else:
                try:
                    tree = obj.read_typetree()
                    for key in ("m_Name", "m_AssemblyName", "m_ClassName", "m_Namespace"):
                        if key in tree:
                            entry[key.removeprefix("m_").lower()] = tree[key]
                except Exception:
                    pass
            named.append(entry)
        inventory[name] = {"sha256": source_hashes.get(name), "object_counts": dict(counts), "objects": named}

    scene_external = [external.path for external in scene.externals]
    custom_components = [
        x for group in components.values() for x in group
        if x.get("script", {}).get("name")
    ]
    payload = {
        "metadata": {
            "unitypy": UnityPy.__version__,
            "unity_version": scene.version,
            "scene_file": SCENE_NAME,
            "source_hashes_sha256": source_hashes,
            "scene_object_count": len(raw_by_id),
            "game_object_count": len(game_objects),
            "transform_count": len(transforms),
            "monobehaviour_count": sum(1 for obj in raw_by_id.values() if obj.type.name == "MonoBehaviour"),
            "scene_external_files": scene_external,
        },
        "roots": roots,
        "objects": rows,
        "layout_focus_ids": sorted(layout_ids),
        "script_class_counts": dict(Counter(
            f'{x["script"].get("assembly", "?")}:{x["script"].get("namespace", "")}.{x["script"].get("name", "?")}'
            for x in custom_components
        )),
        "resource_inventory": inventory,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output} ({len(rows)} GameObjects; {len(custom_components)} named MonoBehaviours)")

    focus_names = {
        "Editor Canvas", "Center", "Scale", "Track Panel", "Tracks Base", "Note Tracks",
        "Slide Track", "Touch Track", "Mark Track", "Check Result Track", "Track Splits",
        "Bpm Track", "Time Signature Track", "Wave Track", "Time Selector", "Judgement Line",
        "Line Base", "Gameplay", "Scene Base", "Track Base", "Beat Line Base", "Background Canvas",
        "Right Panels", "Property Panel", "Info Panel", "View Panel", "Song Info Panel",
        "Preview Panel", "View Base", "View Mask",
        *(f"Track ({index})" for index in range(1, 9)),
        *(f"Track {index}" for index in range(1, 9)),
    }
    focus_ids = {row["object_id"] for row in rows if row["name"] in focus_names}
    for target_id in tuple(focus_ids):
        parent_id = by_id[target_id]["parent_id"]
        while parent_id is not None and parent_id not in focus_ids:
            focus_ids.add(parent_id)
            parent_id = by_id[parent_id]["parent_id"]
    focus_payload = {
        "metadata": {
            "unitypy": UnityPy.__version__,
            "unity_version": scene.version,
            "scene_file": SCENE_NAME,
            "source_hashes_sha256": source_hashes,
            "evidence": "selected serialized GameObject, Transform/RectTransform, Canvas and script-reference data; unavailable stripped fields are omitted",
        },
        "selection": {"target_names": sorted(focus_names), "includes_ancestor_chains": True},
        "objects": [row for row in rows if row["object_id"] in focus_ids],
    }
    args.focus_output.parent.mkdir(parents=True, exist_ok=True)
    args.focus_output.write_text(json.dumps(focus_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.focus_output} ({len(focus_payload['objects'])} focused GameObjects)")
    print("Top scripts:")
    for name, count in Counter(x["script"].get("name", "?") for x in custom_components).most_common(30):
        print(f"  {count:4d} {name}")
    print("Scene roots:")
    for root_id in roots:
        print(f"  {root_id:5d} {by_id[root_id]['name']}")


if __name__ == "__main__":
    main()
