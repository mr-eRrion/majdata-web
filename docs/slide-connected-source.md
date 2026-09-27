# Connected and shared-head Slide source semantics

这份记录对照 Visual Maimai 反编译源码、仓库内 MajSimai parser 和严格适配层，区分串联路径与同头分支。Visual Maimai 反编译输出位于 `.tools/visual-reverse/r4`、`.tools/visual-reverse/r2`；MajSimai 源码位于 `vendor/MajSimai/Runtime`。

## Visual Maimai 的旧式串联路径

`ChartImporter.DecryptNote` 在首个 slide token 之后以 `*` 分割 `slideTexts`，每一项分别交给 `DecryptSlide`：`.tools/visual-reverse/r4/Global.Chart.ChartImporter.cs:361-365`。因此 `*` 切分的是同一个头部下面的多个 part，不是用来表示一条路径的连续腿。

`DecryptSlide` 只查当前 `slideText` 的第一个 `[` 和它后面的第一个 `]`，将括号内容解析为该 `SlidePartData` 唯一的一组 `prepareTime` / `moveTime`（同文件 `:420-470`）。路径则取第一个 `[` 之前的整个前缀，再按命令/端点成对解析成 `fragments`；例如 `1-3-5[4:2]` 中头部 `1` 由 `SlideData.button` 保留，part 前缀 `-3-5` 会成为 1→3、3→5 两条 fragment（同文件 `:471-515`）。括号后的第二个命令和第二组时间不进入 fragments 或时长。

因此旧式 `1-3-5[4:2]` 是一条 `SlideData` / 一个 `SlidePartData` / 两条 fragments，共用一个移动时长。运行时 `SlideLineControl` 为 fragment 数创建多条 line renderer，但只创建一颗移动星（`.tools/visual-reverse/r2/Gameplay.Control.SlideLineControl.cs:36-53`、`:239-255`）。移动百分比由该 part 的单个 `[prepareTime, moveTime]` 区间计算，再乘以总 `Length`；控制器累加每条线的 Length，完全走完前段后在当前段放置唯一的 star（同文件 `:105-135`）。`SlideLineMono.SetSlide` 再按 path 的累计点长定位星头（`.tools/visual-reverse/r2/Gameplay.Mono.SlideLineMono.cs:44-110`）。也就是说，整条旧式串联路线上的星连续移动；每条腿分到的移动时间与其 Path.Length 成正比，不是每腿平均分配。

`SlidePartData.GetCommand` 将一个 part 的所有 fragments 聚合成单条路径文本，后面只附一组时长；`SlideData.GetCommand` 才会在多个 part 之间写 `*`（`.tools/visual-reverse/r4/Global.Chart.SlidePartData.cs:30-48`、`.tools/visual-reverse/r4/Global.Chart.SlideData.cs:15-29`）。因此旧式单 bracket 连段可以由 Visual Maimai 的结构化导出保留为一条连续路线；同头多 part 会作为 `*` 分支导出，不等价于串联腿。

## 现代逐腿括号与 MajSimai

MajSimai 的 `NoteHelper.TryGetSlideParams` 会遍历 slide token 中的所有 `[...]`，把每个 bracket 的 move duration 累加进同一个 `slideTime`；wait 不按括号重复累加，而是在循环结束后仅取一次 `60 / (customBpm ?? bpm)`（`vendor/MajSimai/Runtime/SimaiNoteParser.cs:292-409`）。`TryGetSingleNote` 将结果写为一个 `SimaiNote.SlideStartTime = timing + wait` 和一个总 `SlideTime`，而 model 没有逐腿 endpoint 或逐腿时间字段（同文件 `:241-262`；DTO 字段见 `vendor/MajSimai/Runtime/SimaiNote.cs:10-26`）。

在 120 BPM 下，`1-3[4:1]-5[4:3]` 被 MajSimai 作为一个 Slide 读取：wait 为 0.5 秒，两个 move bracket 分别为 0.5 秒和 1.5 秒，parser 输出 `SlideStartTime=0.5`、`SlideTime=2`。这个总时长没有说明两段路线的时间边界或几何。相对地，旧式 `1-3-5[4:2]` 输出 wait 0.5 秒、move 1 秒；其中一个 `[4:2]` 是总路线时长，不是为两腿各分配 2 拍。

MajSimai 用 `*` 表示同头多 Slide：`GetSameHeadSlide` 将每个 `*` 项单独解析，并为后续项补上相同起始位置且置 `IsSlideNoHead=true`（`vendor/MajSimai/Runtime/SimaiNoteParser.cs:109-151`）。120 BPM 下 `1-3[4:1]*-5[4:3]` 会成为两条从位置 1 起步的 Slide，移动时长分别是 0.5 秒与 1.5 秒；这不是 1→3→5 的串联路线。

## 精确保存边界

Visual Maimai 的结构模型能精确保留“一个头部 + 一条 fragment 链 + 一组 wait/move”的旧式写法，并可将该路线导出成 `1-3-5[4:2]` 一类的单 bracket token。MajSimai 则能把现代多 bracket文本解析成一个累计 move 秒数，但结构 API 只提供这个总时长，无法无损还原各腿的命令、endpoint 和各自时长。Visual Maimai importer 对 `1-3[4:1]-5[4:3]` 只解析第一个 `[` 之前的 `-3` 和第一组时长；后缀 `-5[4:3]` 不进入其 part 数据，因此从结构化 ChartData 再导出会丢失后段。

本轮实现采用 Visual 的旧式单括号模型：每条路径的顶层 `command/endPosition` 为首段，`continuations` 为后续命令和端点；`wait/move` 只出现一次，`move` 是整条路线的时长。每段从前段终点继续，编译时按 Visual 的源 Path.Length 分配移动区间。`additionalPaths` 仍只表示从共同头部出发的并行分支。路径最多 64 段、同头最多 64 支，全图展开路径段预算 100,000。Wi-Fi 只能作为独立分支，不能串入普通路径。

现代逐段括号继续按难度只读并保留原文；本轮不提供“每段独立速度”属性。下面的固定播放器源码进一步证明：括号内的分段比例也不能直接解释为 MajdataPlay 的实际分段速度。Web 的段边界依据 Visual 几何长度，尚未实现 MajdataPlay 的条带数量权重，也未取得两端运行对照。

## MajdataPlay 播放器对串联路径的实际分段

`NoteLoader.CreateSlideGroup` 会把 `FoldedSimaiNote.RawContent` 当作一条串联路线处理：开头数字初始化当前起点，每读到一个命令/终点就生成一个 `SubSlideNote`，并把该终点作为下一段起点（`vendor/MajdataPlay-geometry/Assets/Scripts/Scenes/Game/NoteLoader.cs:978-1037`）。例如 `1-3-5[4:2]` 会变成 1→3、3→5 两个连接段，而不是一段带两条 fragment 的路径。除 `K` 扩展路线外，Slide 都进入这个方法；调用处没有按新旧括号格式或 Classic 模式选择另一套分配算法（同文件 `:360-389`）。

括号的存在位置只用于判定语法是否一致。`specTimeFlag` 接受“每一段都有括号”或“仅最后一段有括号、表示总时长”两种形式，混合形式以及完全没有括号都会报 `SLIDE CHAIN ERROR`（同文件 `:982-986`、`:1039-1081`、`:1117-1124`）。不论 flag 是逐段形式 2 还是尾段总时长形式 3，随后都走同一分配代码，没有读取各括号对应的单段秒数：每段权重取路径 prefab 的 `transform.childCount`，并计算 `段时长[i] = note.SlideTime × childCount[i] / ΣchildCount`、`段起点[i] = note.SlideStartTime + Σ前段时长`（同文件 `:1087-1100`、`:1124-1132`）。`SlideDrop.Awake` 将 prefab 的所有子项（排除最后的 SlideOK）计作 slide bars，再令 `SlideLength = SlideBars.Count + 1`，因此这里的 childCount 正好是运行时 `SlideLength`（`vendor/MajdataPlay-geometry/Assets/Scripts/Scenes/Game/NoteBehaviours/SlideDrop.cs:93-104`）。子段 `Init` 时又以 `parent.StartTiming + parent.Length` 覆盖自己的开始时间，保证串联连续（同文件 `:197-223`）。

这意味着“现代逐段括号”在 MajSimai 解析后并未成为播放器的逐段计时指令。120 BPM 下，`1-3[240#4:1]-5[240#4:3]` 与 `1-3[240#4:3]-5[240#4:1]` 都得到同一个总 move `1s` 和同一个首 bracket wait `0.25s`；命令与端点不变时，两种写法进入相同的 NoteLoader 分支、得到相同的 prefab 权重和运行时段边界。括号 move 的比例本身不会控制各段时长；改变各段路径 prefab 的 childCount 才会改变分配。单段/总时长括号也使用同一权重规则。与此相对，Visual Maimai 旧式模型把单 part 的 moveTime 按 fragment 的 Path.Length 连续分配（见上文），不能把播放器的 prefab childCount 比例当成 Visual Maimai 的几何时长规则。

时间解析仍由 MajSimai 完成，而非 `NoteLoader` 按段再计算。`TryGetSlideParams` 将所有括号的 move 秒数累计为单个 `SlideTime`；`[BPM#ratio]` 用该 BPM 换算该括号 move，`[wait##move]` 用 wait 固定全局起始等待并将 move 秒数累计。全路线只有一个 `SlideStartTime = timing + wait`。`customBpm ??=` 令第一个显式 BPM 或固定 wait 来源决定这个全局 wait；后续括号不会覆盖它（`vendor/MajSimai/Runtime/SimaiNoteParser.cs:292-408`）。所以实现若要复刻该播放器，应保留一个 global wait 与 total move，再根据目标路径 prefab 的 childCount 确定各段实际运行时长；不能把逐段括号的 move 比例直接当成实际段边界，也不能把每段 wait 相加。

连接关系、头部和 break 也有明确的全段语义。每个生成的 `SubSlideNote` 都从源 note 继承 `IsBreak`、`IsEx`、`IsSlideBreak` 等 flag；所有子段先置 `IsSlideNoHead=true`，然后仅将原始 head flag 恢复给第一段（`NoteLoader.cs:1106-1115`）。普通路径材质使用 `note.IsSlideBreak`（同文件 `:1347-1360`），因此这是整条路线共用的 slide-break 标记，不是每个 bracket 独立控制的属性；head 的 Break/EX 则来自原 note。`CreateSlideGroup` 为多段设置 head/end 与 parent 链，且只允许 Wi-Fi 单段，Wi-Fi 出现在多段连接里会抛错（同文件 `:1135-1180`、`:1149-1154`）。运行时只有首段显示/播放头部星星，后续段依赖 parent；连接组只在最后一段进行最终判定，首段触发音效，后段判定可等待/强制完成 parent（`NoteBehaviours/SingleSlideBase.cs:53-60`、`:112-117`、`:149-167`、`:207-234`；`NoteBehaviours/SlideDrop.cs:201-235`）。这应作为完整连接 Slide 的模型边界，而不应被误作 `*` 同头分支。

**可实现模型边界：**若目标是复刻 MajdataPlay 播放器，可将串联路线保存为一条 note 的有序 `segments[]`（各段命令、终点、路径 break）和共享 head flags、global wait、total move；播放时通过路径类型对应的 prefab 子节点数分配各段时间，并串联 parent/head/end 与末段判定语义。只用括号中的各段 move 比例做时间分段会与当前播放器不符。由于目标 Web 尚未投影全部路径 prefab 的 childCount，不能据现有 `slide-paths.json` 单独还原其运行时权重；在拿到对应来源数据前，逐段准确时长仍不可实现。该结论描述 MajSimai + MajdataPlay 的实际行为，不代表 Visual Maimai 的旧 importer/exporter 语义。

## 连续段的深度顺序与边界星头

Visual Maimai 的 `SlideLineControl.GetObject` 按 `CurrentData.fragments` 的索引 `j` 创建每段，并设置 `localPosition.z = _prepareTime / 100 + j × 0.001`；后续 fragment 因而有更大的 z。每段的 LineRenderer 按数组顺序处理（`SlideLineMono.SetSlide` 遍历 `slideLines`），同一 fragment 内保留 renderer 索引顺序。共享星头会在 `UpdateSlide` 中重新 parent 到当前 fragment，`SlideLineMono.SetSlide` 再写入其 localPosition；路径点的 z 为 0，因此星头继承 active fragment 的 z。来源位置：`.tools/visual-reverse/r2/Gameplay.Control.SlideLineControl.cs:76-135,214-255`、`.tools/visual-reverse/r2/Gameplay.Mono.SlideLineMono.cs:54-135`。

场景静态数据中 Gameplay Camera 位于 z=-10 且正向旋转，`Scene Base` 位于 Gameplay 下 z=10，`Slide Base` 位于 Scene Base 下 z=0；相机为 orthographic。Slide 材质在透明队列（3000），关闭 ZWrite 并使用透明混合；没有发现覆盖默认透明排序模式的相机设置。Unity 文档说明正交相机的默认透明排序沿相机视线，透明队列按 back-to-front 绘制（[Camera.transparencySortMode](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Camera-transparencySortMode.html)、[Transparent RenderQueue](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Rendering.RenderQueue.Transparent.html)）。据此，Pixi 将 fragment 按 `prepareTime / 100 + segmentIndex × 0.001` 降序送入条带层，组内按 renderer 索引升序；不同共享头分支也按该合成深度全局排序，避免仅按路线起始时间排序时跨分支错序。移动星头使用当前 segment 的同一合成深度，head 保留独立排序层。

`UpdateSlide` 的路径累计循环仅在 `累计长度 < 当前移动距离` 时结束前段；等号仍由前段调用 `SetSlide(1)` 并承载星头，后段收到 `SetSlide(0)`。Web 在精确段边界因此把唯一星头归给前段终点，边界后一刻再切到下一段。全零时长路径仍由既有时间窗逻辑隐藏。以上是对固定程序集和场景数据的静态解释，尚无 Visual Maimai 运行截图或透明排序的目标机实测。
