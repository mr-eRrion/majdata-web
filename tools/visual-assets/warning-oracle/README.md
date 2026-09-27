# Visual Maimai chart-warning oracle

This small .NET console harness runs the decompiled `EditorScene.Check.ChartWatcher.Check` against narrowly serialized cases. It exists to compare the Web checker with the original arithmetic and result rules; it does not reconstruct the Unity application.

## Run

Use a .NET 10 SDK, the repository root, an input JSON file, and a directory containing the original decompiled source files listed below. No NuGet packages are required.

```sh
dotnet run --project tools/visual-assets/warning-oracle/CheckOracle.csproj \
  -p:DecompileDir="$DECOMPILE_DIR" -- \
  "$PWD" "$INPUT_JSON" "$OUTPUT_JSON"
```

The committed golden fixture is [warning-oracle.json](../../../fixtures/visual-maimai/warning-oracle.json). To extract its input array before running the command above:

```sh
node --input-type=module -e 'import fs from "node:fs"; const {cases}=JSON.parse(fs.readFileSync("fixtures/visual-maimai/warning-oracle.json", "utf8")); fs.writeFileSync("/tmp/warning-input.json", JSON.stringify(cases));'
```

Use `/tmp/warning-input.json` as `INPUT_JSON`; extra expected-result fields are ignored by the harness. The Vitest golden test checks the Web output against all committed results.

`DecompileDir` must contain these exact filenames. The harness reads `apps/web/src/skin/slide-paths.json` from the supplied repository root. The input is a top-level array of cases:

```json
[
  {
    "name": "case-name",
    "notes": [
      {
        "id": "n1",
        "kind": "tap",
        "position": 1,
        "hit": { "numerator": 0, "denominator": 1 },
        "end": { "numerator": 0, "denominator": 1 },
        "ex": false,
        "head": true,
        "paths": []
      }
    ],
    "bpms": [
      { "beat": { "numerator": 0, "denominator": 1 }, "bpm": 120 }
    ]
  }
]
```

`kind` accepts `tap`, `hold`, `touch`, `touchHold`, and `slide`. Rational beats are quarter-note beats. The harness converts a rational beat `n/d` to original `TimeData(4d, n)`. Hold duration is `end - hit`. For each Slide branch, `start` is the prepare endpoint and `end` is the movement endpoint, so the source part receives `prepareTime = start - hit` and `moveTime = end - start`. `head: false` maps to the source's hidden-head flag.

Each Slide path carries `segments` with `command`, `startPosition`, and `endPosition`, matching [`apps/web/src/checks/types.ts`](../../../apps/web/src/checks/types.ts). The harness chooses the serialized path by command and circular distance, swapping `<` and `>` when the segment starts on ring positions 3–6, as `SlideTypesData.GetPath` does. Fragment `Length` and `enterAreaData` come from `slide-paths.json`'s `warningLength` and `enterAreaData`. Wi-Fi remains atomic and uses the original checker’s generated three-track events.

Output is an array in input case order. Each case contains `results`, sorted by normalized beat while preserving the source checker's insertion order for results at the same beat, with `{ "beat": { "numerator", "denominator" }, "code", "severity" }` entries.

## Source provenance

The source assembly is `Visual Maimai/Visual Maimai_Data/Managed/Assembly-CSharp.dll`, SHA-256:

```text
e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e
```

These decompiled files are compiled directly from `DecompileDir`, without edits. Their SHA-256 hashes below identify the source snapshot used for the 58-case comparison:

| Source file | SHA-256 |
| --- | --- |
| `EditorScene_Check_ChartWatcher.cs` | `ee7bebd202cbf662a25aa2b728c7cb12063e05d0c09fdb20bad7a09959461bd9` |
| `EditorScene_Check_CheckResult.cs` | `315c9bd7c5b955403e1ed9e36bd5a4974b520dcb8821f3c1e2ca042494da2d9a` |
| `Global_Chart_TimeData.cs` | `70dccb8aed3609596b0d2334531b7c3d77f16c013402035e25163cad4c196b97` |
| `Global_Chart_BpmData.cs` | `69ccd5c3ad31f30ddc9c01abffe37cabf4440c9e6a6ceff59c90d058ff423621` |
| `Settings_Data_SettingsData.cs` | `2477e1a1a3fdd7367c0907f12bd8180e731f7b2d825bb795595018f7da13fb0d` |

The chart watcher, result type, time conversion, BPM conversion, and default settings are the original linked sources. `Stubs.cs` supplies only the missing chart/note/path data containers, `SettingsManager`, `MonoSingleton`, `LanguageManager`, `ResultType`, and the float `Clamp`/`Lerp` extensions needed to compile them. Settings defaults come from the linked source (`maxHitRange = 0.2`, `severeHitRange = 0.12`).

## Evidence boundary

The harness runs the source checker and source `BpmData.GetTime`/`TimeData` methods over already-constructed JSON notes. It does not exercise maidata parsing, source import serialization, Unity scene state, audio, or runtime input. Unity-specific object ownership and localization are stubbed. Path selection and warning data are sourced from the extracted skin JSON, so this oracle independently checks the C# checker arithmetic and branching but not the asset extraction process itself.

The current 58-case input produced 602 results and was compared item-by-item with the Web checker; all beats, codes, and severities matched. That comparison is a validation record for this source snapshot, not a promise that arbitrary charts or future decompiler revisions are covered.
