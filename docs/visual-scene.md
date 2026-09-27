# Unity 场景定向提取

本提取记录 V0 渲染与桌面编辑器布局中可从 Unity 序列化数据直接恢复的值。所有路径、Sprite、Renderer、Material 和 Transform 都保留源对象 ID；自定义 MonoBehaviour 以目标 `Assembly-CSharp.dll` 的字段声明顺序读取，并要求解析偏移精确到达对象末尾。未解析出的值不以代码默认值代替。

## 可复现文件

| 文件 | 内容 |
| --- | --- |
| [`fixtures/visual-maimai/rendering.json`](../fixtures/visual-maimai/rendering.json) | RuntimeManager 轨道与触点坐标、SlideTypesData 路径采样、皮肤 prefab 渲染参数、对象引用与字段解析字节数、端点 PNG 哈希 |
| [`fixtures/visual-maimai/desktop-layout.json`](../fixtures/visual-maimai/desktop-layout.json) | Editor Canvas、时间轴/轨道面板及其父链的精简 GameObject、Transform、RectTransform、Canvas 和 CanvasScaler 实参 |
| [`fixtures/visual-maimai/hold_end.png`](../fixtures/visual-maimai/hold_end.png)、[`hold_end_each.png`](../fixtures/visual-maimai/hold_end_each.png)、[`hold_end_break.png`](../fixtures/visual-maimai/hold_end_break.png) | Hold 普通、Each、Break 终点 Sprite 对应的源纹理 PNG |
| `.tools/visual-scene/scene-layout.full.json` | 仅供本机检查的全场景清单，不作为正式 fixture 分发 |

目标版本为 Unity `6000.0.10.1`，UnityPy 为 `1.20.26`。主要输入文件 SHA-256：`level0` `5565829c440d808738f313ef5770c6981de46576d884b59197c87a533dbcfd1e`；`sharedassets0.assets` `83f743d5f7c522ee436941ddbd647dbdf0dc80ea61354c410934d55cbf7a8104`；`sharedassets0.assets.resS` `1136f83ca2d3a765131eeb96d376257900c58ea58bcec6b1a1034c957660ec85`；`Assembly-CSharp.dll` `e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`。CanvasScaler 字段顺序参照 `UnityEngine.UI.dll`（SHA-256 `7f72a45f1e47c02706db14aa315de31a5cd4eb2c04cad3b19b186d72e0fddfc5`）。

在本项目根目录重跑：

```sh
PYTHONPATH=.tools/visual-scene/venv/lib/python3.12/site-packages \
  /opt/homebrew/Caskroom/miniforge/base/envs/scienv/bin/python \
  tools/visual-scene/extract_rendering.py

PYTHONPATH=.tools/visual-scene/venv/lib/python3.12/site-packages \
  /opt/homebrew/Caskroom/miniforge/base/envs/scienv/bin/python \
  tools/visual-scene/extract_scene.py
```

第一条生成渲染 fixture 和三张 PNG；第二条生成精简桌面布局 fixture 与 `.tools` 下全场景清单。脚本会对 `RuntimeManager`、Skin Mono、`SlideTypesData`、`SlidePathData` 和 `CanvasScaler` 检查读取字节边界。

## 场景值

`RuntimeManager` 是 `level0` MonoBehaviour `4114`，挂在 GameObject `528 Runtime Manager`。它的 `tracks[]` 明确保存 8 个 Transform，数组顺序为 Track 1 至 Track 8；每个轨道半径都约为 `4.792`。这些 Transform 的父级 `Track Base`（Transform `1224`）为单位旋转和缩放。将场景四元数应用到局部 +Y 后，方向与轨道位置相反，所以局部 +Y 朝圆心；这是对存档位置和旋转的计算结果。

同一组件引用 `touchPositions` ScriptableObject `1270`（33 个位置）和 `slideTypes` ScriptableObject `1269`。触点位置以实际字典完整写入 fixture：中心 C 为 `(0,0)`；A 环半径约 `4.09464`，B 环约 `2.29940`，D 环约 `4.1`，E 环约 `2.995`。`SlideTypesData` 序列化包含 11 种命令定义及 69 个 `SlidePathData` 引用；路径点、切分索引、进入区域数据和路径长度保存在 `slide_types.paths`。这些都是资源内实参，不是根据图形布局补出的坐标。

`SkinManager` 是 `level0` MonoBehaviour `3516`，位于 GameObject `142 Skin Manager`；`defaultSkin` 内嵌 6 项 NoteType 字典，并引用 SlideLine `1433`、SlideWifi `1284`、StarMono `1283`。皮肤对象映射为共享资源中的 Tap `1319`、Hold `1395`、Touch `1329`、TouchHold `1300`。各 MonoBehaviour 字段按 IL 反编译出的声明顺序逐项读取，Tap/Hold/Touch/TouchHold 的对象长度分别为 92/140/144/156 字节，均到达对象末尾。

可直接用于初版渲染的值包括：

- Tap `noteModel` 使用 Sprite `357 tap`，rect `122×122`，pivot `(0.5,0.5)`，border 为零，PPU `100`；SpriteRenderer 实存 size `1.22×1.22`、Simple draw mode，root 与子 Transform 均为单位缩放。
- Hold 普通、Each、Ex、Break Sprite 分别为 ID `367/388/359/304`，rect 均为 `122×200`、pivot 均为 `(0.5,0)`；其实际 border 分别为 `[0,61,0,56]`、`[0,56,0,55]`、`[0,48,0,47]`、`[0,58,0,55]`。主 Renderer 为 Sliced、size `1.22×5`；子节点局部 Y 为 `-0.73`。终点 Renderer 子节点局部 Y 为 `3.61`。端点来源分别是 Sprite `335/284/309`，三张导出 PNG 与源纹理 ID、尺寸和 SHA-256 一并记录。
- Touch 的中心 Sprite 为 ID `361 touch_point`（`32×32`）；四片三角 Sprite rect 为 `112×82`、pivot 约 `(0.5,0.7735814)`。TouchHold 使用四个独立 `touchhold_0..3` Sprite 和中心 Sprite；各层旋转、引用及缩放都在 renderer 的 `transform_chain_root_first` 中。
- TouchHold 的 Fill Renderer 绑定 Material `8 Touch Hold Fill`，Sprite `300 touchhold_border`（`211×210`）。材质实存 `_Angle=360`、`_StartAngle=90`、`_Clockwise=1`、`_Cutoff=0.5`，有效 keyword 为 `_CLOCKWISE_ON`。代码运行时会把进度乘以 360 写入 `_Angle`。

桌面时间轴位于 `Editor Canvas` GameObject `256` 下。CanvasScaler `3682` 实存参考分辨率 `1920×1080`、`ScaleWithScreenSize`、MatchWidthOrHeight 且 match 值为 `1`；Popup Canvas 使用相同分辨率、match 值 `0`；Background Canvas 使用 ConstantPixelSize。CanvasScaler 在该包中无可读 TypeTree，提取器按 UnityEngine.UI 字段声明顺序解析 80 字节对象，并核对最后 3 个对齐字节为零。

按 1920×1080 参考布局，Canvas 中央 `Scale` 区为 `1920×1010`。左侧 `Track Panel` GameObject `253` 宽 `570`，挂有 BeatLineManager `3296`；它包含 80px 左侧遮罩、标记/图标轨、Tracks Base、判定结果轨。Tracks Base 下有 BPM、拍号、Wave、切分线、Judgement Line，以及 8 个每 45px 排列、单条宽 47px 的轨道和 Touch/Slide 轨。

右侧 `Right Panels` GameObject `552` 由水平布局组控制，实际子顺序为 Property Panel `74`、Info Panel `379`。布局组间距为零；Property Panel `flexibleWidth=1`，Info Panel `minWidth=680`。右侧容器宽约 `1350`，按参考分辨率可分配为约 `670px + 680px`。Info Panel 内先是上方 View Panel，再是底部 Song Info Panel（高度 `230`）；View Base 左右各留 `80px`、上下共减 `145px`，内部 View Mask 使用 AspectRatioFitter。

Popup Canvas 中的 Preview Panel 是独立覆盖层：其根节点 active，但 Base 子节点 inactive，因此全屏预览弹窗默认关闭。父级 `Scale`、Track Panel 及 Tracks Base 等主链局部缩放均为 `(1,1,1)`、旋转为单位四元数；Gameplay 下的 Scene Base、Track Base、Beat Line Base 链也相同，没有负缩放。根 Canvas 的 RectTransform 序列化 scale 为零；这是 Canvas 根对象数据，不能据此将其解释为子 UI 的反向变换。

## 未恢复项

TouchHold Fill 引用 Shader `215 Custom/SprFill`。资源含 D3D11 编译块（平台值 `4`）；UnityPy 没有直接导出程序源码。后续已定向提取并反汇编实际 fragment，确认 `_StartAngle=90`、`_CLOCKWISE_ON` 对应从上方顺时针增长的填充，见 [Shader 恢复](touchhold-shader.md)。目标运行像素对照仍待完成。

UnityPy 的 stripped MonoBehaviour TypeTree 不提供业务字段名。自定义字段依照匹配程序集源码 schema 手动解析并检查精确字节消费；若目标安装包 hash 改变，应先重新核验脚本声明顺序和偏移，再使用这些参数。
