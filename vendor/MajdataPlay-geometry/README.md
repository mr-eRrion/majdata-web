# MajdataPlay geometry source snapshot

This directory contains only the fixed source files used by the representative geometry extraction. The upstream repository is [TeamMajdata/MajdataPlay](https://github.com/TeamMajdata/MajdataPlay) at commit `850f3e3eac354d328b1e9e8bde50b64c4946faf5`; the Unity editor version recorded by that commit is `6000.3.17f1`.

The copied files retain their upstream paths. `Assets/Scenes/Game.unity` and `NoteLoader.cs.meta` establish the serialized `slidePrefab` array; the three selected slide Prefabs and their `.meta` files pin the scene references; `Just_str.prefab` is the nested final child referenced by `Star_Line_3.prefab`. The other selected Prefabs serialize their `SlideOK` object directly. The source files used to interpret strip children, motion points, Wi-Fi lanes and connection weights are included alongside the exact upstream `LICENSE`.

`tools/geometry-export/extract.mjs` checks each source file against its Git blob ID before use and emits both the Git blob ID and SHA-256. It resolves the one nested Prefab reference and its serialized transform overrides. It reads Transform coordinates only; the referenced art, skins, effects and runtime binary are not copied.

These files are from a GPL-3.0 repository. Read [`LICENSE`](LICENSE) before redistributing or combining the snapshot with a larger product.
