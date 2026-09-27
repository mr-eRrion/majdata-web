# NotePlaceArea 圆形跨区放置的场景证据

## 场景对象与序列化引用

`NotePlaceArea` 挂在 `level0` 的 GameObject `Place Area`（GO `201`，组件 `3601`，脚本 `EditorScene.Edit.NotePlaceArea`，MonoScript `1548`）上。它是 `View`（GO `81`）的全屏子 RectTransform；该对象另有 `Image` 和 `SoftMaskable`。独立的 `Slide Place`（GO `27`）才挂 `SlidePlacePanel`，二者不是同一输入区。

从组件 `3601` 的原始 68 字节按字段顺序读取三个 PPtr，字段块恰为 36 字节且完整耗尽：

| 字段 | PPtr | 实际对象 |
| --- | --- | --- |
| `placeAreaPosition` | file 2, path 1199 | `sharedassets0.assets` 的 `TouchPositionData`，资产名 `Place Area Position Info` |
| `baseTransform` | file 0, path 2292 | GO `201` 自己的 RectTransform |
| `pointer` | file 0, path 1228 | GO `1201` `Place Pointer` 的 Transform；其父链在 `Scene Base`（GO `956`）下，SpriteRenderer sortingOrder=10 |

`TouchPositionData` 的 `positions` 声明为 `SerializableDictionary<string, Vector2>`。对象 `1199` 的原始数据为 716 字节，包含 41 个键值，解析后恰好读完全部字节。其 33 个 Touch 键 `C`、`A1..A8`、`B1..B8`、`D1..D8`、`E1..E8` 与 `fixtures/visual-maimai/rendering.json` 的 `runtime.touch_positions.entries` 逐项完全相同；后者对应另一个 `TouchPositionData`（`sharedassets0.assets` path `1270`，33 项）。NotePlaceArea 专用资产 `1199` 在这 33 项之外还保存 `1..8` 八个 Ring 轨道区中心，不能只读取 RuntimeManager 的 33 项表。

## 中心、范围和判定

33 个 Touch 中心的完整浮点坐标可直接从上述 fixture 路径读取。其各圈中心到原点的半径为：`C=0`、`B≈2.2994024`、`E≈2.995`、`A≈4.0946391`、`D=4.1`。`A/B/D/E` 各有 8 点，`C` 是中心点。

`Place Area Position Info` 中另外八个 Ring 中心是：

| 区域 | x | y | 半径 |
| --- | ---: | ---: | ---: |
| `1` | 1.836880565 | 4.434621811 | 4.8 |
| `2` | 4.434621811 | 1.836880684 | 4.8 |
| `3` | 4.434621811 | -1.836880684 | 4.8 |
| `4` | 1.836880565 | -4.434621811 | 4.8 |
| `5` | -1.836880326 | -4.434622288 | 4.8 |
| `6` | -4.434621811 | -1.836880803 | 4.8 |
| `7` | -4.434621811 | 1.836880565 | 4.8 |
| `8` | -1.836881280 | 4.434621811 | 4.8 |

这些是**编辑命中区中心**，和可视轨道 Transform 中心来自不同数据源：`rendering.json` 中 Track 1..8 的实际场景半径约 `4.792`，相应中心与这里半径 `4.8` 的命中中心相差约 `0.008` 个场景单位。点击分区应使用 NotePlaceArea 表；音符绘制仍用轨道 Transform。

反编译的 `EditorScene.Edit.NotePlaceArea.Update()` 给出判定公式：

```text
mouse = baseTransform.InverseTransformPoint(Input.mousePosition)
reject if |mouse| > baseTransform.rect.height / 2
center(key) = placeAreaPosition[key] * baseTransform.rect.size / 11
selected = nearest center among all 41 keys
pointer.localPosition = placeAreaPosition[selected]
```

因此它不是 41 个互不相连的小圆。它先用 `baseTransform` 的中心圆作为总活动范围，再把圆内所有位置分给最近的中心，形成被外圆裁切的 Voronoi 区域。若显示区为边长 `s` 的正方形，每个数据坐标单位映射为 `s/11`，活动边界半径是 `s/2`，即数据坐标半径 `5.5`；最外层 Ring 中心半径为 `4.8`。等距时源代码会用枚举中后遇到的项覆盖前项；`SerializableDictionary` 按其序列化列表顺序枚举，网页实现宜将 41 项保留为数组顺序，不要依赖 JS 对象键顺序。

鼠标必须先进入 `Place Area` 的 UI 命中区；越界、退出或播放时会隐藏 `Place Pointer`。左键按住拖动时，`_lastArea` 让每次进入新分区只放置一次：键为 `1..8` 时调用 `NoteTrack.PlacingNote`，其余键调用 `TouchTrack.PlaceNote`。放置还要求吸附设置开启、图表/时间有效、没有粘贴操作，且 `SlidePlacePanel.IsOpened` 为 false。指针 Transform 位于 `Scene Base` 世界坐标链中，因此 hover 指针用原始 `Vector2` 坐标；鼠标最近点计算则用缩放到 RectTransform 的坐标。

## UI 坐标空间与桌面布局

层级为 `Editor Canvas`（GO `256`）→ `Center` `281` → `Scale` `53` → `Right Panels` `552` → `Info Panel` `379` → `View Panel` `160` → `View Base` `518` → `View Mask` `494` → `View` `81` → `Place Area` `201`。CanvasScaler 参考分辨率是 `1920×1080`；`Scale` 的参考 Rect 为 `1920×1010`。`Right Panels` 的序列化锚点为全拉伸，anchored position=`(285,22.5)`、sizeDelta=`(-570,-45)`；其水平布局中 `Info Panel` 最小宽度为 `680`。`View Panel` 占 `Info Panel` 上部，锚点全拉伸，anchored position=`(0,115)`、sizeDelta=`(0,-230)`；底部 `Song Info Panel` 固定高度 `230`。`View Base` 相对 `View Panel` 的 anchored position=`(0,62.5)`、sizeDelta=`(-80,-145)`。

`View Mask` 的 RectTransform 序列化锚点初值是左下角；但组件 `4060` 的原始值为 `AspectMode=3`、`aspectRatio=1`。本包 `UnityEngine.UI.dll` 中 `AspectRatioFitter.UpdateRect()` 的 `FitInParent` 分支会在运行时把锚点改为全拉伸、位置改为 `(0,0)`，并让矩形适配父节点，因此运行时 View 是父矩形内居中的正方形，边长为父宽、高的较小值。`View` 和 `Place Area` 再全拉伸填满这个正方形。

按 `1920×1080` 参考布局和现存 LayoutElement/RectTransform 参数推算，`Info Panel` 为 `680px` 宽，`View Panel` 高约 `735px`，`View Base` 约 `600×590px`，最终正方形 View 约 `590×590px`。这只是参考分辨率下的布局推导；`RectTransform.rect` 是运行时计算值，其他窗口尺寸下应按实际 `rect.size` 代入前述公式。该布局证据与既有 [桌面场景布局报告](visual-scene.md) 一致。

## 来源与复核

- Unity `6000.0.10.1`，UnityPy `1.20.26`。
- `level0` SHA-256：`5565829c440d808738f313ef5770c6981de46576d884b59197c87a533dbcfd1e`；`sharedassets0.assets` SHA-256：`83f743d5f7c522ee436941ddbd647dbdf0dc80ea61354c410934d55cbf7a8104`。
- `Assembly-CSharp.dll` SHA-256：`e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`。`NotePlaceArea` 字段和 Update 逻辑来自 `.tools/visual-reverse/r3/EditorScene_Edit_NotePlaceArea.cs`；`SerializableDictionary` 枚举顺序来自该 DLL 的 `Global.Utils.SerializableDictionary<TKey,TValue>.GetEnumerator()`。
- 解析结果与现有 `.tools/visual-scene/scene-layout.full.json`、`fixtures/visual-maimai/rendering.json` 的对象 ID、场景哈希及 Touch 坐标交叉核对；未将 C# 默认值当作场景序列化值。
