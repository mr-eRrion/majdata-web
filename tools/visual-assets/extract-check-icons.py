#!/usr/bin/env python3
"""Extract the two serialized chart-check icons from a Unity data directory.

This is an explicit source-package extraction step. The Node preparation tool
uses the checked-in fixture produced here and never needs the Unity install.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path
from typing import Any

import UnityPy
from PIL import Image


FIXTURES = Path("fixtures/visual-maimai/check-icons")
EXPECTED = (
    ("warning", "Warning", 375, 170),
    ("bad", "Bad", 303, 76),
)
CHECK_RESULT_ROOT_ID = 637
CHECK_RESULT_RECT_ID = 1140
CHECK_RESULT_KEYFRAME_ID = 1421
CHECK_RESULT_REFERENCES = (
    ("image", 1323),
    ("warningSprite", 375),
    ("badSprite", 303),
    ("text", 1353),
    ("bar", 652),
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def xy(value: dict[str, Any]) -> list[float]:
    return [float(value["x"]), float(value["y"])]


def rect(value: dict[str, Any]) -> dict[str, float]:
    return {name: float(value[name]) for name in ("x", "y", "width", "height")}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True, help="Unity *_Data directory containing sharedassets0.assets")
    parser.add_argument("--output-dir", type=Path, default=FIXTURES)
    args = parser.parse_args()

    data_root = args.data_root.resolve()
    assets_path = data_root / "sharedassets0.assets"
    stream_path = data_root / "sharedassets0.assets.resS"
    if not assets_path.is_file():
        raise SystemExit(f"missing Unity source asset: {assets_path}")

    env = UnityPy.Environment()
    env.load_folder(str(data_root))
    shared = next((file for name, file in env.files.items() if Path(name).name == assets_path.name), None)
    if shared is None:
        raise SystemExit(f"UnityPy did not load {assets_path.name}")

    root_obj = shared.objects[CHECK_RESULT_ROOT_ID]
    root = root_obj.read_typetree()
    root_transform = shared.objects[CHECK_RESULT_RECT_ID].read_typetree()
    component_ids = [int(component["component"]["m_PathID"]) for component in root["m_Component"]]
    if root["m_Name"] != "Check Result" or CHECK_RESULT_RECT_ID not in component_ids or CHECK_RESULT_KEYFRAME_ID not in component_ids:
        raise ValueError("Check Result prefab references changed")
    if root_transform["m_GameObject"]["m_PathID"] != CHECK_RESULT_ROOT_ID:
        raise ValueError("Check Result RectTransform points at another GameObject")
    root_ui_size = xy(root_transform["m_SizeDelta"])
    if root_ui_size != [42.0, 42.0]:
        raise ValueError(f"Check Result root UI size changed: {root_ui_size}")
    keyframe_raw = shared.objects[CHECK_RESULT_KEYFRAME_ID].get_raw_data()
    field_references = []
    for index, (field_name, expected_id) in enumerate(CHECK_RESULT_REFERENCES):
        file_id, path_id = struct.unpack_from("<iq", keyframe_raw, 32 + index * 12)
        if file_id != 0 or path_id != expected_id:
            raise ValueError(f"CheckResultKeyframe.{field_name} reference changed: {(file_id, path_id)}")
        field_references.append({"field": field_name, "fileId": int(file_id), "pathId": int(path_id)})

    args.output_dir.mkdir(parents=True, exist_ok=True)
    assets = []
    for key, sprite_name, sprite_id, texture_id in EXPECTED:
        sprite_obj = shared.objects[sprite_id]
        if sprite_obj.type.name != "Sprite":
            raise ValueError(f"path {sprite_id} is {sprite_obj.type.name}, expected Sprite")
        sprite = sprite_obj.read()
        sprite_fields = sprite_obj.read_typetree()
        sprite_rd = sprite_fields["m_RD"]
        texture_ref = sprite_rd["texture"]
        if (texture_ref["m_FileID"], texture_ref["m_PathID"]) != (0, texture_id):
            raise ValueError(f"Sprite{sprite_id} texture reference changed: {texture_ref}")
        if sprite.m_Name != sprite_name:
            raise ValueError(f"Sprite{sprite_id} is named {sprite.m_Name!r}, expected {sprite_name!r}")

        sprite_rect = rect(sprite_fields["m_Rect"])
        sprite_pivot = xy(sprite_fields["m_Pivot"])
        pixels_per_unit = float(sprite_fields["m_PixelsToUnits"])
        texture_rect = rect(sprite_rd["textureRect"])
        texture_rect_offset = xy(sprite_rd["textureRectOffset"])
        atlas_rect_offset = xy(sprite_rd["atlasRectOffset"])
        expected_rect = {"x": 0.0, "y": 0.0, "width": 84.0, "height": 84.0}
        if sprite_rect != expected_rect or texture_rect != expected_rect:
            raise ValueError(f"Sprite{sprite_id} rect metadata changed: {sprite_rect}, {texture_rect}")
        if sprite_pivot != [0.5, 0.5] or pixels_per_unit != 100.0:
            raise ValueError(f"Sprite{sprite_id} pivot/PPU changed: {sprite_pivot}, {pixels_per_unit}")
        if texture_rect_offset != [0.0, 0.0]:
            raise ValueError(f"Sprite{sprite_id} textureRectOffset changed: {texture_rect_offset}")

        texture_obj = shared.objects[texture_id]
        if texture_obj.type.name != "Texture2D":
            raise ValueError(f"path {texture_id} is {texture_obj.type.name}, expected Texture2D")
        texture = texture_obj.read()
        if texture.m_Name != sprite_name or (texture.m_Width, texture.m_Height) != (84, 84):
            raise ValueError(f"Texture{texture_id} metadata changed: {texture.m_Name}, {texture.m_Width}x{texture.m_Height}")

        texture_image = texture.image.convert("RGBA")
        sprite_image = sprite.image.convert("RGBA")
        if texture_image.size != (84, 84) or sprite_image.size != texture_image.size:
            raise ValueError(f"Sprite{sprite_id}/Texture{texture_id} decoded to unexpected dimensions")
        if texture_image.tobytes() != sprite_image.tobytes():
            raise ValueError(f"Sprite{sprite_id} pixels differ from its full Texture{texture_id}")

        filename = f"{key}.png"
        png_path = args.output_dir / filename
        texture_image.save(png_path, format="PNG", optimize=False)
        with Image.open(png_path) as decoded:
            decoded.verify()
        with Image.open(png_path) as decoded:
            if decoded.size != (84, 84) or decoded.convert("RGBA").tobytes() != texture_image.tobytes():
                raise ValueError(f"PNG decode differs from Texture{texture_id}")

        assets.append({
            "key": f"check.{key}",
            "file": filename,
            "sprite": {
                "objectId": sprite_id,
                "name": sprite.m_Name,
                "rect": sprite_rect,
                "pivot": sprite_pivot,
                "pixelsPerUnit": pixels_per_unit,
                "textureRect": texture_rect,
                "textureRectOffset": texture_rect_offset,
                "atlasRectOffset": atlas_rect_offset,
                "texture": {"fileId": int(texture_ref["m_FileID"]), "pathId": texture_id},
            },
            "texture": {
                "objectId": texture_id,
                "name": texture.m_Name,
                "width": int(texture.m_Width),
                "height": int(texture.m_Height),
            },
            "png": {
                "width": 84,
                "height": 84,
                "sha256": sha256_file(png_path),
            },
        })

    source = {
        "schemaVersion": 1,
        "extraction": {
            "tool": "UnityPy",
            "toolVersion": UnityPy.__version__,
            "unityVersion": shared.version,
            "sourceAssets": {
                "path": "Visual Maimai/Visual Maimai_Data/sharedassets0.assets",
                "sha256": sha256_file(assets_path),
            },
            "sourceStream": {
                "path": "Visual Maimai/Visual Maimai_Data/sharedassets0.assets.resS",
                "sha256": sha256_file(stream_path) if stream_path.is_file() else None,
            },
            "method": "Export Texture2D RGBA PNG unchanged; verify its decoded pixels exactly equal the referenced Sprite.image and the Sprite textureRect covers the full 84x84 texture.",
        },
        "displayReference": {
            "rootGameObject": {"objectId": CHECK_RESULT_ROOT_ID, "name": root["m_Name"]},
            "rootRectTransform": {
                "objectId": CHECK_RESULT_RECT_ID,
                "anchorMin": xy(root_transform["m_AnchorMin"]),
                "anchorMax": xy(root_transform["m_AnchorMax"]),
                "pivot": xy(root_transform["m_Pivot"]),
                "size": root_ui_size,
            },
            "checkResultKeyframe": {
                "objectId": CHECK_RESULT_KEYFRAME_ID,
                "fieldReferences": field_references,
                "referencesReadFrom": "MonoBehaviour serialized PPtrs after the 32-byte Unity header; declaration order confirmed against CheckResultKeyframe source metadata.",
            },
            "evidenceBoundary": "Serialized sharedassets0 prefab references and RectTransform values; this does not establish runtime visibility or animation.",
        },
        "assets": assets,
    }
    output_path = args.output_dir / "source.json"
    output_path.write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Extracted {len(assets)} check icons from Sprite375/303 to {args.output_dir}")


if __name__ == "__main__":
    main()
