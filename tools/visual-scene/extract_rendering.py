#!/usr/bin/env python3
"""Extract scene-backed Visual Maimai rendering data with byte-bound checks.

UnityPy cannot infer this build's stripped custom MonoBehaviour TypeTrees. The
small schemas below are taken from the matching Assembly-CSharp fields and
checked against each serialized object size before any value is accepted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
from pathlib import Path
from typing import Any

import UnityPy
from UnityPy.classes.PPtr import PPtr


DEFAULT_ROOT = Path("Visual Maimai/Visual Maimai_Data")
DEFAULT_OUTPUT = Path("fixtures/visual-maimai/rendering.json")
ASSEMBLY = Path("Visual Maimai/Visual Maimai_Data/Managed/Assembly-CSharp.dll")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class Reader:
    def __init__(self, data: bytes, offset: int, object_id: int):
        self.data = data
        self.offset = offset
        self.start = offset
        self.object_id = object_id
        self.name: str | None = None

    def take(self, size: int) -> bytes:
        end = self.offset + size
        if end > len(self.data):
            raise ValueError(f"object {self.object_id}: read past end at {self.offset}, size {size}, object size {len(self.data)}")
        value = bytes(self.data[self.offset:end])
        self.offset = end
        return value

    def i32(self) -> int:
        return struct.unpack("<i", self.take(4))[0]

    def f32(self) -> float:
        return struct.unpack("<f", self.take(4))[0]

    def pptr(self) -> dict[str, int]:
        return {"file_id": self.i32(), "path_id": struct.unpack("<q", self.take(8))[0]}

    def string(self) -> str:
        size = self.i32()
        if size < 0:
            raise ValueError(f"object {self.object_id}: negative string size {size} at {self.offset - 4}")
        value = self.take(size).decode("utf-8", errors="replace")
        self.offset = (self.offset + 3) & ~3
        if self.offset > len(self.data):
            raise ValueError(f"object {self.object_id}: string alignment passes object end")
        return value

    def finish(self) -> None:
        if self.offset != len(self.data):
            raise ValueError(f"object {self.object_id}: schema stopped at {self.offset}/{len(self.data)} bytes; tail={self.data[self.offset:self.offset + 24].hex()}")


def ptr(owner: Any, value: dict[str, int]) -> Any | None:
    if not value["path_id"]:
        return None
    return PPtr(m_FileID=value["file_id"], m_PathID=value["path_id"], assetsfile=owner).deref()


def ptr_record(value: dict[str, int], owner: Any) -> dict[str, Any]:
    record: dict[str, Any] = dict(value)
    try:
        obj = ptr(owner, value)
        if obj is None:
            record["object"] = None
        else:
            record["class"] = obj.type.name
            record["object_name"] = object_name(obj)
            record["object_file"] = Path(obj.assets_file.name).name if obj.assets_file else None
    except Exception as exc:
        record["resolve_error"] = f"{type(exc).__name__}: {exc}"
    return record


def object_name(obj: Any) -> str | None:
    try:
        return obj.read_typetree().get("m_Name")
    except Exception:
        return None


def script_info(obj: Any) -> dict[str, Any]:
    raw = obj.get_raw_data()
    script_file = struct.unpack_from("<i", raw, 16)[0]
    script_path = struct.unpack_from("<q", raw, 20)[0]
    script = PPtr(m_FileID=script_file, m_PathID=script_path, assetsfile=obj.assets_file).deref()
    tree = script.read_typetree()
    return {
        "file_id": script_file,
        "path_id": script_path,
        "name": tree.get("m_ClassName"),
        "namespace": tree.get("m_Namespace"),
        "assembly": tree.get("m_AssemblyName"),
    }


def component_go_id(obj: Any) -> int:
    return struct.unpack_from("<q", obj.get_raw_data(), 4)[0]


def scriptable_reader(obj: Any) -> Reader:
    # In this Unity 6 build ScriptableObjects use the common serialized
    # MonoBehaviour prefix: null GameObject PPtr, enabled byte/padding,
    # MonoScript PPtr, m_Name string, then their serialized fields.
    reader = Reader(obj.get_raw_data(), 28, obj.path_id)
    reader.name = reader.string()
    return reader


def component_reader(obj: Any) -> Reader:
    # MonoBehaviour layout: GameObject PPtr, enabled + padding, MonoScript
    # PPtr and empty m_Name; custom fields begin at byte 32 in this build.
    return Reader(obj.get_raw_data(), 32, obj.path_id)


def xyz(value: Any) -> list[float]:
    return [float(value.x), float(value.y), float(value.z)]


def xyzw(value: Any) -> list[float]:
    return [float(value.x), float(value.y), float(value.z), float(value.w)]


def rect_dict(value: dict[str, Any] | None) -> dict[str, float] | None:
    if not value:
        return None
    return {key: float(value[key]) for key in ("x", "y", "width", "height") if key in value}


def vec2_dict(value: dict[str, Any] | None) -> list[float] | None:
    if not value:
        return None
    return [float(value["x"]), float(value["y"])]


def vec4_dict(value: dict[str, Any] | None) -> list[float] | None:
    if not value:
        return None
    return [float(value[k]) for k in ("x", "y", "z", "w")]


def color_dict(value: dict[str, Any] | None) -> list[float] | None:
    if not value:
        return None
    return [float(value[k]) for k in ("r", "g", "b", "a")]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--png-dir", type=Path, default=Path("fixtures/visual-maimai"))
    args = parser.parse_args()

    root = args.data_root.resolve()
    env = UnityPy.Environment()
    env.load_folder(str(root))
    files = {Path(key).name: file for key, file in env.files.items() if hasattr(file, "objects")}
    scene = files["level0"]
    shared = files["sharedassets0.assets"]

    game_objects: dict[tuple[str, int], Any] = {}
    transforms: dict[tuple[str, int], Any] = {}
    sorting_groups_by_go: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for filename, file in files.items():
        for obj in file.objects.values():
            if obj.type.name == "GameObject":
                game_objects[(filename, obj.path_id)] = obj.read()
            elif obj.type.name in ("Transform", "RectTransform"):
                transforms[(filename, obj.path_id)] = obj.read()
            elif obj.type.name == "SortingGroup":
                fields = obj.read_typetree()
                go_id = fields.get("m_GameObject", {}).get("m_PathID", 0)
                sorting_groups_by_go.setdefault((filename, go_id), []).append({
                    "component_object_id": obj.path_id,
                    "component_class": obj.type.name,
                    "sorting_layer_id": fields.get("m_SortingLayerID"),
                    "sorting_layer_raw": fields.get("m_SortingLayer"),
                    "sorting_order": fields.get("m_SortingOrder"),
                    "enabled": bool(fields.get("m_Enabled", 1)),
                    "sort_at_root": fields.get("m_SortAtRoot"),
                })

    def go_record(filename: str, go_id: int) -> dict[str, Any]:
        go = game_objects[(filename, go_id)]
        transform_id = None
        for (owner, path_id), transform in transforms.items():
            if owner == filename and transform.m_GameObject.m_PathID == go_id:
                transform_id = path_id
                break
        return {"object_id": go_id, "name": go.m_Name, "active": bool(go.m_IsActive), "transform_id": transform_id}

    def transform_record(filename: str, go_id: int) -> dict[str, Any] | None:
        for (owner, path_id), transform in transforms.items():
            if owner == filename and transform.m_GameObject.m_PathID == go_id:
                record = {
                    "object_id": path_id,
                    "game_object_id": go_id,
                    "local_position": xyz(transform.m_LocalPosition),
                    "local_rotation_xyzw": xyzw(transform.m_LocalRotation),
                    "local_scale": xyz(transform.m_LocalScale),
                    "parent_transform_id": transform.m_Father.m_PathID or None,
                }
                if hasattr(transform, "m_AnchorMin"):
                    record.update({
                        "anchor_min": vec2_dict({"x": transform.m_AnchorMin.x, "y": transform.m_AnchorMin.y}),
                        "anchor_max": vec2_dict({"x": transform.m_AnchorMax.x, "y": transform.m_AnchorMax.y}),
                        "anchored_position": vec2_dict({"x": transform.m_AnchoredPosition.x, "y": transform.m_AnchoredPosition.y}),
                        "size_delta": vec2_dict({"x": transform.m_SizeDelta.x, "y": transform.m_SizeDelta.y}),
                        "pivot": vec2_dict({"x": transform.m_Pivot.x, "y": transform.m_Pivot.y}),
                    })
                return record
        return None

    def transform_chain(filename: str, go_id: int) -> list[dict[str, Any]]:
        chain: list[dict[str, Any]] = []
        current = go_id
        visited: set[int] = set()
        while current and current not in visited:
            visited.add(current)
            transform = transform_record(filename, current)
            if transform is None:
                break
            node = {**go_record(filename, current), **transform}
            groups = sorting_groups_by_go.get((filename, current), [])
            if groups:
                node["sorting_groups"] = [
                    {**group, "game_object_id": current, "game_object_name": node["name"], "transform_id": transform["object_id"]}
                    for group in groups
                ]
            chain.append(node)
            parent_id = transform["parent_transform_id"]
            if not parent_id:
                break
            parent = transforms[(filename, parent_id)]
            current = parent.m_GameObject.m_PathID
        return chain

    def tree(obj: Any) -> dict[str, Any]:
        return obj.read_typetree()

    def sprite_info(value: dict[str, int], owner: Any) -> dict[str, Any] | None:
        obj = ptr(owner, value)
        if obj is None:
            return None
        fields = tree(obj)
        render_data = fields.get("m_RD", {})
        texture_ref = render_data.get("texture", {"m_FileID": 0, "m_PathID": 0})
        texture_record: dict[str, Any] | None = None
        texture = ptr(obj.assets_file, {"file_id": texture_ref["m_FileID"], "path_id": texture_ref["m_PathID"]})
        if texture is not None:
            texture_fields = tree(texture)
            texture_record = {
                "object_id": texture.path_id,
                "name": texture_fields.get("m_Name"),
                "width": texture_fields.get("m_Width"),
                "height": texture_fields.get("m_Height"),
                "format": texture_fields.get("m_TextureFormat"),
                "asset_file": Path(texture.assets_file.name).name,
            }
        return {
            "object_id": obj.path_id,
            "name": fields.get("m_Name"),
            "asset_file": Path(obj.assets_file.name).name,
            "rect": rect_dict(fields.get("m_Rect")),
            "pivot": vec2_dict(fields.get("m_Pivot")),
            "border": vec4_dict(fields.get("m_Border")),
            "pixels_per_unit": float(fields.get("m_PixelsToUnits", 0)),
            "texture": texture_record,
        }

    def material_info(value: dict[str, int], owner: Any) -> dict[str, Any]:
        try:
            obj = ptr(owner, value)
            if obj is None:
                return {**value, "object": None}
            fields = tree(obj)
            shader_ptr = fields.get("m_Shader", {"m_FileID": 0, "m_PathID": 0})
            shader = ptr(obj.assets_file, {"file_id": shader_ptr["m_FileID"], "path_id": shader_ptr["m_PathID"]})
            shader_record = None
            if shader is not None:
                shader_fields = tree(shader)
                parsed = shader_fields.get("m_ParsedForm", {})
                platforms = shader_fields.get("platforms") or []
                compressed_blob = shader_fields.get("compressedBlob") or []
                from UnityPy.enums import ShaderCompilerPlatform

                shader_record = {
                    "object_id": shader.path_id,
                    "name": parsed.get("m_Name") or shader_fields.get("m_Name"),
                    "asset_file": Path(shader.assets_file.name).name,
                    "platforms": [
                        {
                            "value": int(platform),
                            "name": ShaderCompilerPlatform(platform).name,
                        }
                        for platform in platforms
                    ],
                    "compressed_blob_bytes": len(compressed_blob),
                    "decompressed_lengths": shader_fields.get("decompressedLengths") or [],
                    "source_status": "platform bytecode only; no shader source body serialized",
                }
            properties = fields.get("m_SavedProperties", {})
            tex_envs = []
            for name, env_data in properties.get("m_TexEnvs", []):
                texture_ref = env_data.get("m_Texture", {"m_FileID": 0, "m_PathID": 0})
                tex_envs.append({
                    "name": name,
                    "texture": texture_info({"file_id": texture_ref["m_FileID"], "path_id": texture_ref["m_PathID"]}, obj.assets_file) if texture_ref.get("m_PathID") else None,
                    "scale": vec2_dict(env_data.get("m_Scale")),
                    "offset": vec2_dict(env_data.get("m_Offset")),
                })
            floats = [{"name": name, "value": value} for name, value in properties.get("m_Floats", [])]
            colors = [{"name": name, "value": color_dict(value)} for name, value in properties.get("m_Colors", [])]
            return {
                "object_id": obj.path_id,
                "name": fields.get("m_Name"),
                "asset_file": Path(obj.assets_file.name).name,
                "shader": shader_record,
                "valid_keywords": fields.get("m_ValidKeywords", []),
                "textures": tex_envs,
                "floats": floats,
                "colors": colors,
            }
        except Exception as exc:
            return {**value, "resolve_error": f"{type(exc).__name__}: {exc}"}

    def texture_info(value: dict[str, int], owner: Any) -> dict[str, Any] | None:
        texture = ptr(owner, value)
        if texture is None:
            return None
        fields = tree(texture)
        return {
            "object_id": texture.path_id,
            "name": fields.get("m_Name"),
            "asset_file": Path(texture.assets_file.name).name,
            "width": fields.get("m_Width"),
            "height": fields.get("m_Height"),
            "format": fields.get("m_TextureFormat"),
        }

    def renderer_info(value: dict[str, int], owner: Any, role: str) -> dict[str, Any]:
        obj = ptr(owner, value)
        if obj is None:
            return {"role": role, **value, "object": None}
        fields = tree(obj)
        go_ptr = fields.get("m_GameObject", {"m_FileID": 0, "m_PathID": 0})
        go_id = go_ptr["m_PathID"]
        renderer_sprite = fields.get("m_Sprite", {"m_FileID": 0, "m_PathID": 0})
        materials = [
            material_info({"file_id": item["m_FileID"], "path_id": item["m_PathID"]}, obj.assets_file)
            for item in fields.get("m_Materials", [])
        ]
        chain_root_first = list(reversed(transform_chain(Path(obj.assets_file.name).name, go_id)))
        sorting_groups = [
            {**group, "transform_name": node["name"]}
            for node in chain_root_first
            for group in node.get("sorting_groups", [])
        ]
        record = {
            "role": role,
            "object_id": obj.path_id,
            "class": obj.type.name,
            "game_object": go_record(Path(obj.assets_file.name).name, go_id),
            "transform_chain_root_first": chain_root_first,
            "sorting_groups": sorting_groups,
            "sprite": sprite_info({"file_id": renderer_sprite["m_FileID"], "path_id": renderer_sprite["m_PathID"]}, obj.assets_file) if renderer_sprite.get("m_PathID") else None,
            "draw_mode": fields.get("m_DrawMode"),
            "size": vec2_dict(fields.get("m_Size")),
            "sorting_order": fields.get("m_SortingOrder"),
            "sorting_layer_id": fields.get("m_SortingLayerID"),
            "color_rgba": color_dict(fields.get("m_Color")),
            "materials": materials,
        }
        if obj.type.name == "LineRenderer":
            parameters = fields.get("m_Parameters", {})
            record["line_parameters"] = {
                "width_multiplier": parameters.get("widthMultiplier"),
                "width_curve": parameters.get("widthCurve"),
                "alignment": parameters.get("alignment"),
                "texture_mode": parameters.get("textureMode"),
                "texture_scale": vec2_dict(parameters.get("textureScale")),
                "color_gradient": parameters.get("colorGradient"),
                "num_corner_vertices": parameters.get("numCornerVertices"),
                "num_cap_vertices": parameters.get("numCapVertices"),
                "use_world_space": fields.get("m_UseWorldSpace"),
                "loop": fields.get("m_Loop"),
            }
        return record

    def direct_sprite(value: dict[str, int], owner: Any, role: str) -> dict[str, Any]:
        return {"role": role, "sprite": sprite_info(value, owner) if value.get("path_id") else None}

    def one_component(filename: str, class_name: str) -> Any:
        file = files[filename]
        matches = [
            obj for obj in file.objects.values()
            if obj.type.name == "MonoBehaviour" and script_info(obj)["name"] == class_name
        ]
        if len(matches) != 1:
            raise ValueError(f"expected one {class_name} in {filename}, found {len(matches)}")
        return matches[0]

    def parse_pointer_fields(component: Any, names: list[str], tail_bytes: int = 0) -> dict[str, dict[str, int]]:
        reader = component_reader(component)
        fields = {name: reader.pptr() for name in names}
        if tail_bytes:
            reader.take(tail_bytes)
        reader.finish()
        return fields

    def component_for_game_object(filename: str, game_object_id: int, class_name: str) -> Any:
        go = game_objects[(filename, game_object_id)]
        for component_ref in go.m_Component:
            component = component_ref.component.deref()
            if component.type.name == "MonoBehaviour" and script_info(component)["name"] == class_name:
                return component
        raise ValueError(f"{filename} GameObject {game_object_id} has no {class_name} component")

    def ui_image_record(filename: str, game_object_id: int) -> dict[str, Any]:
        image = component_for_game_object(filename, game_object_id, "Image")
        raw = image.get_raw_data()
        if len(raw) != 136:
            raise ValueError(f"Image component {image.path_id}: expected 136 bytes, got {len(raw)}")
        # Unity UI.Image in this build serializes Color at byte 44 and its
        # sprite PPtr at byte 88 (file ID followed by 64-bit path ID).
        color = list(struct.unpack_from("<4f", raw, 44))
        sprite_ref = {"file_id": struct.unpack_from("<i", raw, 88)[0], "path_id": struct.unpack_from("<q", raw, 92)[0]}
        sprite = sprite_info(sprite_ref, image.assets_file)
        if sprite is None:
            raise ValueError(f"Image component {image.path_id} has no sprite")
        return {
            "component_object_id": image.path_id,
            "component_class": "Image",
            "game_object": go_record(filename, game_object_id),
            "sprite": sprite,
            "color_rgba": color,
            "field_parse": {
                "object_bytes": len(raw),
                "color_offset": 44,
                "sprite_pointer_offset": 88,
                "schema": "Unity UI.Image fields in this build; Color then m_Sprite PPtr",
            },
        }

    def rect_children(filename: str, game_object_id: int) -> list[dict[str, Any]]:
        transform_id = next(
            (path_id for (owner, path_id), transform in transforms.items()
             if owner == filename and transform.m_GameObject.m_PathID == game_object_id),
            None,
        )
        if transform_id is None:
            raise ValueError(f"{filename} GameObject {game_object_id} has no Transform")
        parent = transforms[(filename, transform_id)]
        children = []
        for sibling_index, child_ref in enumerate(parent.m_Children):
            child_transform = child_ref.deref().read()
            child_game_object_id = child_transform.m_GameObject.m_PathID
            children.append({
                "sibling_index": sibling_index,
                "game_object": go_record(filename, child_game_object_id),
                "transform": transform_record(filename, child_game_object_id),
            })
        return children

    def firework_placement(filename: str, owner: Any, firework_ref: dict[str, int], root_game_object_id: int) -> dict[str, Any]:
        firework_obj = ptr(owner, firework_ref)
        if firework_obj is None:
            raise ValueError("Touch firework reference is null")
        if firework_obj.type.name == "GameObject":
            firework_game_object_id = firework_obj.path_id
        elif firework_obj.type.name in ("RectTransform", "Transform"):
            firework_game_object_id = firework_obj.read().m_GameObject.m_PathID
        else:
            raise ValueError(f"Touch firework reference has type {firework_obj.type.name}")
        children = rect_children(filename, root_game_object_id)
        sibling = next((entry["sibling_index"] for entry in children if entry["game_object"]["object_id"] == firework_game_object_id), None)
        if sibling is None:
            raise ValueError(f"Firework GameObject {firework_game_object_id} is not a direct child of {root_game_object_id}")
        transform = transform_record(filename, firework_game_object_id)
        return {
            "game_object": go_record(filename, firework_game_object_id),
            "transform": transform,
            "image": ui_image_record(filename, firework_game_object_id),
            "sibling_index": sibling,
            "siblings": [{"index": entry["sibling_index"], "name": entry["game_object"]["name"]} for entry in children],
        }

    # RuntimeManager component; declared fields are in the class source order.
    runtime = scene.objects[4114]
    rr = component_reader(runtime)
    background_count = rr.i32()
    backgrounds = []
    for _ in range(background_count):
        raw_image = rr.pptr()
        need_color = bool(rr.take(1)[0])
        rr.offset = (rr.offset + 3) & ~3
        backgrounds.append({"image": ptr_record(raw_image, scene), "need_set_color": need_color})
    default_background = rr.pptr()
    bga_texture = rr.pptr()
    track_count = rr.i32()
    tracks = []
    for index in range(track_count):
        track_ptr = rr.pptr()
        transform_obj = ptr(scene, track_ptr)
        t = transform_obj.read()
        go_id = t.m_GameObject.m_PathID
        tracks.append({
            "index": index,
            "source": track_ptr,
            "game_object": go_record("level0", go_id),
            "parent_chain_root_first": list(reversed(transform_chain("level0", go_id))),
            "position_radius": math.hypot(t.m_LocalPosition.x, t.m_LocalPosition.y),
        })
    touch_positions_ref = rr.pptr()
    slide_types_ref = rr.pptr()
    touch_base_ref = rr.pptr()
    slide_base_ref = rr.pptr()
    video_player_ref = rr.pptr()
    touch_area_ref = rr.pptr()
    rr.finish()

    def parse_touch_positions(obj: Any) -> dict[str, list[float]]:
        reader = scriptable_reader(obj)
        entries = reader.i32()
        output: dict[str, list[float]] = {}
        for _ in range(entries):
            key = reader.string()
            output[key] = [reader.f32(), reader.f32()]
        reader.finish()
        return output

    touch_positions_obj = ptr(scene, touch_positions_ref)
    touch_positions = parse_touch_positions(touch_positions_obj)

    # NotePlaceArea owns a separate TouchPositionData: it contains the same
    # 33 touch centers as RuntimeManager plus eight ring-lane centers. Keep its
    # serialized list as an array so exact-distance ties retain source order.
    note_place_candidates = [
        obj for obj in scene.objects.values()
        if obj.type.name == "MonoBehaviour" and script_info(obj)["name"] == "NotePlaceArea"
    ]
    if len(note_place_candidates) != 1:
        raise ValueError(f"expected one NotePlaceArea component, found {len(note_place_candidates)}")
    note_place_component = note_place_candidates[0]
    note_place_reader = component_reader(note_place_component)
    place_area_position_ref = note_place_reader.pptr()
    base_transform_ref = note_place_reader.pptr()
    pointer_ref = note_place_reader.pptr()
    note_place_reader.finish()

    place_area_position_obj = ptr(scene, place_area_position_ref)
    if place_area_position_obj is None:
        raise ValueError("NotePlaceArea.placeAreaPosition is null")
    place_area_reader = scriptable_reader(place_area_position_obj)
    place_area_position_count = place_area_reader.i32()
    place_area_positions = []
    for _ in range(place_area_position_count):
        key = place_area_reader.string()
        place_area_positions.append({
            "key": key,
            "position": [place_area_reader.f32(), place_area_reader.f32()],
        })
    place_area_reader.finish()
    if place_area_position_count != 41:
        raise ValueError(f"expected 41 serialized placement centers, found {place_area_position_count}")

    base_transform_obj = ptr(scene, base_transform_ref)
    pointer_transform_obj = ptr(scene, pointer_ref)
    if base_transform_obj is None or base_transform_obj.type.name != "RectTransform":
        raise ValueError("NotePlaceArea.baseTransform is not a RectTransform")
    if pointer_transform_obj is None or pointer_transform_obj.type.name != "Transform":
        raise ValueError("NotePlaceArea.pointer is not a Transform")
    base_transform_go_id = base_transform_obj.read().m_GameObject.m_PathID
    pointer_transform_go_id = pointer_transform_obj.read().m_GameObject.m_PathID
    note_place_area = {
        "component_object_id": note_place_component.path_id,
        "component_class": script_info(note_place_component)["name"],
        "game_object": go_record("level0", component_go_id(note_place_component)),
        "serialized_fields": {
            "placeAreaPosition": ptr_record(place_area_position_ref, scene),
            "baseTransform": ptr_record(base_transform_ref, scene),
            "pointer": ptr_record(pointer_ref, scene),
        },
        "base_transform": {
            "component_object_id": base_transform_obj.path_id,
            "game_object": go_record("level0", base_transform_go_id),
            "transform": transform_record("level0", base_transform_go_id),
        },
        "pointer": {
            "component_object_id": pointer_transform_obj.path_id,
            "game_object": go_record("level0", pointer_transform_go_id),
            "transform_chain_root_first": list(reversed(transform_chain("level0", pointer_transform_go_id))),
        },
        "positions": {
            "object_id": place_area_position_obj.path_id,
            "name": place_area_reader.name,
            "class": script_info(place_area_position_obj)["name"],
            "asset_file": Path(place_area_position_obj.assets_file.name).name,
            "asset_sha256": sha256_file(root / "sharedassets0.assets"),
            "entries": place_area_positions,
            "field_parse": {
                "consumed_bytes": place_area_reader.offset,
                "object_bytes": len(place_area_position_obj.get_raw_data()),
                "entry_count": place_area_position_count,
                "schema": "TouchPositionData.m_Name, SerializableDictionary<string, Vector2> serialized list",
            },
        },
        "field_parse": {
            "consumed_bytes": len(note_place_component.get_raw_data()),
            "object_bytes": len(note_place_component.get_raw_data()),
            "fields_offset": 32,
            "schema": "EditorScene.Edit.NotePlaceArea placeAreaPosition, baseTransform, pointer",
        },
    }

    def parse_slide_path(obj: Any) -> dict[str, Any]:
        reader = scriptable_reader(obj)
        points_count = reader.i32()
        points = [[reader.f32(), reader.f32(), reader.f32()] for _ in range(points_count)]
        split_count = reader.i32()
        split_indexes = [reader.i32() for _ in range(split_count)]
        area_count = reader.i32()
        enter_area = [{"area": reader.i32(), "time_rate": reader.f32()} for _ in range(area_count)]
        reader.finish()
        return {
            "object_id": obj.path_id,
            "name": reader.name,
            "asset_file": Path(obj.assets_file.name).name,
            "points": points,
            "split_indexes": split_indexes,
            "enter_area_data": enter_area,
            "length": sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1)),
        }

    def parse_slide_types(obj: Any) -> list[dict[str, Any]]:
        reader = scriptable_reader(obj)
        types_count = reader.i32()
        values = []
        for _ in range(types_count):
            command = reader.string()
            infos_count = reader.i32()
            infos = []
            for _ in range(infos_count):
                distance = reader.i32()
                center_distance = reader.i32()
                path = reader.pptr()
                infos.append({"distance": distance, "center_distance": center_distance, "path": path})
            values.append({"command": command, "infos": infos})
        reader.finish()
        return values

    slide_types_obj = ptr(scene, slide_types_ref)
    slide_types = parse_slide_types(slide_types_obj)
    path_refs: dict[int, dict[str, int]] = {}
    for type_item in slide_types:
        for info in type_item["infos"]:
            if info["path"]["path_id"]:
                path_refs[info["path"]["path_id"]] = info["path"]
    slide_paths = {}
    for path_id, path_ref in path_refs.items():
        path_obj = ptr(shared, path_ref)
        slide_paths[str(path_id)] = parse_slide_path(path_obj)

    # Resolve SkinManager.defaultSkin (an inline SkinData with a serialized
    # SerializableDictionary list) and the prefab components it names.
    skin_manager = scene.objects[3516]
    skin_reader = component_reader(skin_manager)
    note_count = skin_reader.i32()
    note_components = []
    for _ in range(note_count):
        note_type = skin_reader.i32()
        component_ref = skin_reader.pptr()
        component = ptr(scene, component_ref)
        note_components.append({
            "note_type": note_type,
            "component_ref": ptr_record(component_ref, scene),
            "component": component,
        })
    slide_line_ref = skin_reader.pptr()
    slide_wifi_ref = skin_reader.pptr()
    star_ref = skin_reader.pptr()
    skin_reader.finish()

    script_owner = shared

    def prefab_root(component: Any) -> dict[str, Any]:
        filename = Path(component.assets_file.name).name
        go_id = component_go_id(component)
        chain = transform_chain(filename, go_id)
        root_node = chain[-1] if chain else go_record(filename, go_id)
        return {"component_object_id": component.path_id, "component_class": script_info(component)["name"], "root": root_node, "root_scale": root_node.get("local_scale")}

    def parse_note_prefab(note: dict[str, Any]) -> dict[str, Any]:
        component = note.pop("component")
        reader = component_reader(component)
        obj_class = script_info(component)["name"]
        # Fields declared in NoteMono, TapMono, HoldMono, TouchMono and
        # TouchHoldMono are consumed in inheritance/source order.
        values: dict[str, Any] = {"singleSprite": reader.pptr(), "multiSprite": reader.pptr()}
        if obj_class in ("TapMono", "HoldMono"):
            values["noteModel"] = reader.pptr()
            values["exModel"] = reader.pptr()
            values["breakSprite"] = reader.pptr()
            if obj_class == "HoldMono":
                values["endPoint"] = reader.pptr()
                values["singleEndPoint"] = reader.pptr()
                values["multiEndPoint"] = reader.pptr()
                values["breakEndPoint"] = reader.pptr()
        elif obj_class in ("TouchMono", "TouchHoldMono"):
            values["centerModel"] = reader.pptr()
            values["centerSingleSprite"] = reader.pptr()
            values["centerMultiSprite"] = reader.pptr()
            triangle_count = reader.i32()
            values["triangleModels"] = [reader.pptr() for _ in range(triangle_count)]
            if obj_class == "TouchHoldMono":
                values["holdModel"] = reader.pptr()
        else:
            raise ValueError(f"unsupported note component {obj_class}")
        reader.finish()

        roles = []
        for field_name, ref in values.items():
            if field_name in ("singleSprite", "multiSprite", "breakSprite", "centerSingleSprite", "centerMultiSprite", "singleEndPoint", "multiEndPoint", "breakEndPoint"):
                roles.append(direct_sprite(ref, script_owner, field_name))
            elif field_name == "triangleModels":
                for i, renderer_ref in enumerate(ref):
                    roles.append(renderer_info(renderer_ref, script_owner, f"triangleModels.{i}"))
            elif field_name in ("noteModel", "exModel", "endPoint", "centerModel", "holdModel"):
                roles.append(renderer_info(ref, script_owner, field_name))
        return {
            "note_type": note["note_type"],
            "component": {"object_id": component.path_id, "class": obj_class, "game_object": go_record("sharedassets0.assets", component_go_id(component))},
            "prefab": prefab_root(component),
            "serialized_fields": {name: ptr_record(value, script_owner) if isinstance(value, dict) else [ptr_record(v, script_owner) for v in value] for name, value in values.items()},
            "renderers": [role for role in roles if "object_id" in role],
            "sprites": [role for role in roles if "sprite" in role and "role" in role],
            "field_parse": {"consumed_bytes": len(component.get_raw_data()), "end_offset": len(component.get_raw_data()), "schema": "Assembly-CSharp serialized field declaration order"},
        }

    prefabs = {}
    note_by_type = {x["note_type"]: x for x in note_components}
    type_names = {0: "tap", 1: "hold", 2: "slide", 3: "slideMulti", 4: "touch", 5: "touchHold"}
    for note_type, note in note_by_type.items():
        prefabs[type_names[note_type]] = parse_note_prefab(note)

    def parse_slide_line(obj: Any) -> dict[str, Any]:
        reader = component_reader(obj)
        line_count = reader.i32()
        lines = [reader.pptr() for _ in range(line_count)]
        material_refs = {name: reader.pptr() for name in ("single", "multi", "break")}
        reader.finish()
        return {
            "component_object_id": obj.path_id,
            "component_class": "SlideLineMono",
            "root": prefab_root(obj),
            "lines": [renderer_info(ref, shared, f"slideLines.{i}") for i, ref in enumerate(lines)],
            "materials": {name: material_info(ref, shared) for name, ref in material_refs.items()},
            "field_parse": {"consumed_bytes": len(obj.get_raw_data()), "schema": "slideLines[], singleMaterial, multiMaterial, breakMaterial"},
        }

    def parse_slide_wifi(obj: Any) -> dict[str, Any]:
        reader = component_reader(obj)
        arrows_count = reader.i32()
        arrows = [reader.pptr() for _ in range(arrows_count)]
        arrays: dict[str, list[dict[str, int]]] = {}
        for name in ("arrowsSingle", "arrowsMulti", "arrowsBreak"):
            count = reader.i32()
            arrays[name] = [reader.pptr() for _ in range(count)]
        reader.finish()
        return {
            "component_object_id": obj.path_id,
            "component_class": "SlideWifiMono",
            "root": prefab_root(obj),
            "arrows": [renderer_info(ref, shared, f"arrows.{i}") for i, ref in enumerate(arrows)],
            "sprites": {name: [sprite_info(ref, shared) for ref in refs] for name, refs in arrays.items()},
            "field_parse": {"consumed_bytes": len(obj.get_raw_data()), "schema": "arrows[], arrowsSingle[], arrowsMulti[], arrowsBreak[]"},
        }

    slide_line_obj = ptr(scene, slide_line_ref)
    slide_wifi_obj = ptr(scene, slide_wifi_ref)
    slide_line = parse_slide_line(slide_line_obj)
    slide_wifi = parse_slide_wifi(slide_wifi_obj)

    touch_track = one_component("level0", "TouchTrack")
    touch_track_fields = parse_pointer_fields(touch_track, ["touchInstance", "touchPlacingInstance", "track", "touchAreaPanel", "notePointer"], tail_bytes=20)
    touch_edit = ptr(scene, touch_track_fields["touchInstance"])
    touch_placing = ptr(scene, touch_track_fields["touchPlacingInstance"])
    touch_pointer = ptr(scene, touch_track_fields["notePointer"])
    if any(obj is None for obj in (touch_edit, touch_placing, touch_pointer)):
        raise ValueError("TouchTrack display prefab or pointer reference is null")
    if script_info(touch_edit)["name"] != "TouchEdit" or script_info(touch_placing)["name"] != "TouchPlacing" or script_info(touch_pointer)["name"] != "TouchEdit":
        raise ValueError("TouchTrack display references do not resolve to TouchEdit / TouchPlacing")

    edit_names = ["group", "touch", "touchMulti", "touchHold", "touchHoldLength", "firework", "editing", "touchSelected", "touchHoldSelected"]
    placing_names = ["group", "touch", "touchMulti", "touchHold", "firework", "noMulti"]
    touch_edit_fields = parse_pointer_fields(touch_edit, edit_names, tail_bytes=16)
    touch_pointer_fields = parse_pointer_fields(touch_pointer, edit_names, tail_bytes=16)
    touch_placing_fields = parse_pointer_fields(touch_placing, placing_names)

    def touch_display_record(component: Any, fields: dict[str, dict[str, int]], filename: str, glyph_names: list[str]) -> dict[str, Any]:
        root_game_object_id = component_go_id(component)
        siblings = rect_children(filename, root_game_object_id)

        def field_display(name: str) -> dict[str, Any]:
            field_obj = ptr(component.assets_file, fields[name])
            if field_obj is None:
                raise ValueError(f"Touch display field {name} is null")
            if field_obj.type.name == "GameObject":
                field_game_object_id = field_obj.path_id
            elif field_obj.type.name in ("RectTransform", "Transform"):
                field_game_object_id = field_obj.read().m_GameObject.m_PathID
            else:
                raise ValueError(f"Touch display field {name} resolves to {field_obj.type.name}")
            sibling = next((entry["sibling_index"] for entry in siblings if entry["game_object"]["object_id"] == field_game_object_id), None)
            if sibling is None:
                raise ValueError(f"Touch display field {name} is not a direct child of {root_game_object_id}")
            return {
                "game_object": go_record(filename, field_game_object_id),
                "transform": transform_record(filename, field_game_object_id),
                "image": ui_image_record(filename, field_game_object_id),
                "sibling_index": sibling,
            }

        return {
            "component_object_id": component.path_id,
            "component_class": script_info(component)["name"],
            "game_object": go_record(filename, root_game_object_id),
            "root_transform": transform_record(filename, root_game_object_id),
            "serialized_fields": {name: ptr_record(value, component.assets_file) for name, value in fields.items()},
            "firework": firework_placement(filename, component.assets_file, fields["firework"], root_game_object_id),
            "glyphs": {name: field_display(name) for name in glyph_names},
            "sibling_order": [{"index": entry["sibling_index"], "name": entry["game_object"]["name"]} for entry in siblings],
            "field_parse": {
                "object_bytes": len(component.get_raw_data()),
                "fields": len(fields),
                "schema": "TouchEdit or TouchPlacing serialized fields in Assembly-CSharp declaration order",
            },
        }

    touch_display = {
        "touch_track": {
            "component_object_id": touch_track.path_id,
            "game_object": go_record("level0", component_go_id(touch_track)),
            "serialized_fields": {name: ptr_record(value, scene) for name, value in touch_track_fields.items()},
            "field_parse": {
                "object_bytes": len(touch_track.get_raw_data()),
                "fields": len(touch_track_fields),
                "trailing_bytes": 20,
                "schema": "TouchTrack touchInstance, touchPlacingInstance, track, touchAreaPanel, notePointer, runtime selection tail",
            },
        },
        "timeline": touch_display_record(touch_edit, touch_edit_fields, Path(touch_edit.assets_file.name).name, ["touch", "touchMulti", "touchHold"]),
        "sensor": touch_display_record(touch_placing, touch_placing_fields, Path(touch_placing.assets_file.name).name, ["touch", "touchMulti", "touchHold"]),
        "pointer": touch_display_record(touch_pointer, touch_pointer_fields, Path(touch_pointer.assets_file.name).name, ["touch", "touchMulti", "touchHold"]),
    }
    firework_sprite = touch_display["timeline"]["firework"]["image"]["sprite"]
    if firework_sprite["object_id"] != 386 or firework_sprite["texture"]["object_id"] != 185:
        raise ValueError("TouchEdit firework is no longer Sprite386 / Texture185")
    for variant in ("sensor", "pointer"):
        image_sprite = touch_display[variant]["firework"]["image"]["sprite"]
        if image_sprite["object_id"] != firework_sprite["object_id"] or image_sprite["texture"]["object_id"] != firework_sprite["texture"]["object_id"]:
            raise ValueError(f"Touch {variant} firework does not use the same source Sprite/Texture")

    firework_sprite_object = shared.objects[firework_sprite["object_id"]]
    firework_sprite_obj = firework_sprite_object.read()
    firework_sprite_fields = tree(firework_sprite_object)
    firework_texture_ref = firework_sprite_fields["m_RD"]["texture"]
    firework_texture_obj = ptr(shared, {"file_id": firework_texture_ref["m_FileID"], "path_id": firework_texture_ref["m_PathID"]})
    if firework_texture_obj is None or firework_texture_obj.path_id != 185:
        raise ValueError("Sprite386 texture PPtr no longer resolves to Texture185")
    firework_texture_image = firework_texture_obj.read().image.convert("RGBA")
    firework_sprite_image = firework_sprite_obj.image.convert("RGBA")
    sprite_rect = rect_dict(firework_sprite_fields["m_Rect"])
    texture_rect = rect_dict(firework_sprite_fields["m_RD"].get("textureRect"))
    texture_rect_offset = vec2_dict(firework_sprite_fields["m_RD"].get("textureRectOffset"))
    if not sprite_rect or not texture_rect or not texture_rect_offset:
        raise ValueError("Sprite386 lacks rect, textureRect, or textureRectOffset metadata")
    crop_left = round(texture_rect["x"])
    crop_top = firework_texture_image.height - round(texture_rect["y"] + texture_rect["height"])
    crop_right = round(texture_rect["x"] + texture_rect["width"])
    crop_bottom = crop_top + firework_sprite_image.height
    sprite_crop_from_texture = firework_texture_image.crop((crop_left, crop_top, crop_right, crop_bottom))
    same_sprite_pixels = sprite_crop_from_texture.size == firework_sprite_image.size and all(
        source_pixel[3] == sprite_pixel[3] and (source_pixel[3] == 0 or source_pixel[:3] == sprite_pixel[:3])
        for source_pixel, sprite_pixel in zip(sprite_crop_from_texture.get_flattened_data(), firework_sprite_image.get_flattened_data())
    )
    if not same_sprite_pixels:
        raise ValueError("Texture185 textureRect crop does not match Sprite386 image")
    if (sprite_rect["x"], sprite_rect["y"], sprite_rect["width"], sprite_rect["height"]) != (0.0, 0.0, float(firework_texture_image.width), float(firework_texture_image.height)):
        raise ValueError("Sprite386 logical rect no longer covers the complete source Texture185")

    star_obj = ptr(scene, star_ref)
    if script_info(star_obj)["name"] != "StarMono":
        raise ValueError(f"SkinData.starMono resolved to {script_info(star_obj)['name']}, expected StarMono")
    star_reader = component_reader(star_obj)
    star_fields = {name: star_reader.pptr() for name in ("model", "single", "multi", "break")}
    star_reader.finish()
    star_prefab = prefab_root(star_obj)
    model_renderer = ptr(shared, star_fields["model"])
    star_renderers = [renderer_info(star_fields["model"], shared, "model")] if model_renderer else []
    star_model = {
        **star_prefab,
        "serialized_fields": {name: ptr_record(value, shared) for name, value in star_fields.items()},
        "sprites": {name: sprite_info(star_fields[name], shared) for name in ("single", "multi", "break")},
        "renderers": star_renderers,
        "field_parse": {
            "consumed_bytes": len(star_obj.get_raw_data()),
            "end_offset": star_reader.offset,
            "schema": "Gameplay.Mono.StarMono model, single, multi, break; verified against matching Assembly-CSharp",
        },
    }
    slide_line["split_indexes_source"] = {
        "field_path": "Gameplay.Data.SlidePathData.splitIndexes",
        "fixture_path": "slide_types.paths[*].split_indexes",
    }

    # Export distinct Hold endpoint source textures and hash the actual PNGs.
    png_dir = args.png_dir
    png_dir.mkdir(parents=True, exist_ok=True)
    hold = prefabs["hold"]
    endpoint_names = {
        "singleEndPoint": "hold_end.png",
        "multiEndPoint": "hold_end_each.png",
        "breakEndPoint": "hold_end_break.png",
    }
    png_manifest = {}
    for role, filename in endpoint_names.items():
        sprite = next(x["sprite"] for x in hold["sprites"] if x["role"] == role)
        tex_id = sprite["texture"]["object_id"]
        texture = shared.objects[tex_id].read()
        path = png_dir / filename
        texture.image.save(path)
        png_manifest[role] = {
            "file": filename,
            "sprite_object_id": sprite["object_id"],
            "texture_object_id": tex_id,
            "asset_sha256": sha256_file(root / "sharedassets0.assets"),
            "png_sha256": sha256_file(path),
            "width": texture.m_Width,
            "height": texture.m_Height,
        }

    firework_path = png_dir / "touch_firework.png"
    firework_texture_image.save(firework_path, format="PNG", optimize=False)
    touch_firework_png = {
        "file": firework_path.name,
        "sprite_object_id": firework_sprite_object.path_id,
        "texture_object_id": firework_texture_obj.path_id,
        "asset_sha256": sha256_file(root / "sharedassets0.assets"),
        "png_sha256": sha256_file(firework_path),
        "width": firework_texture_image.width,
        "height": firework_texture_image.height,
        "sprite_rect": sprite_rect,
        "texture_rect": texture_rect,
        "texture_rect_offset": texture_rect_offset,
        "sprite_crop_width": firework_sprite_image.width,
        "sprite_crop_height": firework_sprite_image.height,
        "crop_pixel_offset_top_left": [crop_left, crop_top],
        "png_method": "Texture2D image exported unchanged after checking Sprite.image against m_RD.textureRect; alpha and visible RGB match, transparent RGB ignored",
    }
    png_manifest["touchFirework"] = touch_firework_png

    canvas_scalers = []
    for obj in scene.objects.values():
        if obj.type.name != "MonoBehaviour" or script_info(obj)["name"] != "CanvasScaler":
            continue
        go_id = component_go_id(obj)
        if go_id in game_objects:
            canvas_scalers.append({"object_id": obj.path_id, "game_object": go_record("level0", go_id)})

    payload = {
        "metadata": {
            "tool": "UnityPy",
            "tool_version": UnityPy.__version__,
            "unity_version": scene.version,
            "assembly_sha256": sha256_file(root / "Managed" / ASSEMBLY.name),
            "source_sha256": {
                name: sha256_file(root / name)
                for name in ("level0", "sharedassets0.assets", "sharedassets0.assets.resS", "resources.assets", "resources.assets.resS")
                if (root / name).exists()
            },
            "scene_path": "level0",
            "asset_path": "sharedassets0.assets",
            "evidence": "scene serialized values; custom fields parsed by verified source-order schemas with exact byte exhaustion",
        },
        "runtime": {
            "component_object_id": runtime.path_id,
            "game_object": go_record("level0", component_go_id(runtime)),
            "backgrounds": backgrounds,
            "default_background": ptr_record(default_background, scene),
            "bga_texture": ptr_record(bga_texture, scene),
            "tracks": tracks,
            "touch_positions": {"object_id": touch_positions_obj.path_id, "name": scriptable_reader(touch_positions_obj).name, "entries": touch_positions},
            "touch_base": ptr_record(touch_base_ref, scene),
            "slide_base": ptr_record(slide_base_ref, scene),
            "slide_types": ptr_record(slide_types_ref, scene),
            "video_player": ptr_record(video_player_ref, scene),
            "touch_area_object": ptr_record(touch_area_ref, scene),
            "field_parse": {"consumed_bytes": len(runtime.get_raw_data()), "schema": "backgrounds[], defaultBackground, bgaTexture, tracks[], touchPositions, slideTypes, touchBase, slideBase, videoPlayer, touchAreaObject"},
        },
        "note_place_area": note_place_area,
        "skin": {
            "component_object_id": skin_manager.path_id,
            "game_object": go_record("level0", component_go_id(skin_manager)),
            "skin_data": {"note_instances_count": note_count, "slide_line_instance": ptr_record(slide_line_ref, scene), "slide_wifi_instance": ptr_record(slide_wifi_ref, scene), "star_mono": ptr_record(star_ref, scene)},
            "prefabs": prefabs,
            "star_model": star_model,
            "slide_line": slide_line,
            "slide_wifi": slide_wifi,
            "endpoint_pngs": png_manifest,
            "touch_firework": {"display": touch_display, "png": touch_firework_png},
            "canvas_scalers": canvas_scalers,
        },
        "slide_types": {
            "object_id": slide_types_obj.path_id,
            "name": scriptable_reader(slide_types_obj).name,
            "commands": slide_types,
            "paths": slide_paths,
            "field_parse": {"consumed_bytes": len(slide_types_obj.get_raw_data()), "path_count": len(slide_paths), "schema": "types[] → command + infos[] → distance, centerDistance, SlidePathData PPtr"},
        },
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output}: {len(tracks)} tracks, {len(touch_positions)} runtime touch positions, {len(place_area_positions)} placement centers, {len(slide_paths)} paths")
    print(f"Hold endpoint PNGs: {', '.join(png_manifest[k]['file'] for k in endpoint_names)}")
    print(f"Touch firework marker PNG: {firework_path.name}")


if __name__ == "__main__":
    main()
