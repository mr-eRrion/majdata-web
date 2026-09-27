# Visual Maimai 谱面检查器来源与实现边界

本文定向复核本地 `Assembly-CSharp.dll` 中 `EditorScene.Check.ChartWatcher.Check` 的 code 0–8，以及它使用的 Slide 路径数据。目标是给 Web warning checker 一个可核对的行为定义；这里没有实现 warning UI，也没有把解析器诊断当成原生 warning。

## 证据与数据链

程序集 SHA-256 为 `e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`；定向反编译使用 ILSpyCmd `11.1.0.9782`。可复现命令示例：

```sh
DOTNET_ROOT="$PWD/.tools/dotnet" .tools/visual-reverse/bin/ilspycmd \
  -t 'EditorScene.Check.ChartWatcher' \
  'Visual Maimai/Visual Maimai_Data/Managed/Assembly-CSharp.dll'
```

定向反编译结果保存在 [warnings 临时提取目录](../.tools/visual-reverse/warnings/)，核心文件是 `EditorScene_Check_ChartWatcher.cs`、`Gameplay_Control_SlideControl.cs`、`Gameplay_Data_SlideTypesData.cs`、`Gameplay_Data_SlidePathData.cs`、`Global_Chart_BpmData.cs` 和 `Settings_Data_SettingsData.cs`。

执行次序见 [InitManager](../.tools/visual-reverse/r4/Gameplay.Manager.InitManager.cs:31)：先取当前 `NotesData` 并转换 BPM keyframes，再调用 `InitChartData()`，最后按 `checkChart` 设置调用 `ChartWatcher.Check`。`InitChartData` 构造 `SlideControl`；其构造器对非 Wi-Fi 的每个 fragment 调 `SlideTypesData.GetPath`，把返回的 `SlidePathData` 放进 `fragment.Path`，并把路径长度累加到 `SlidePartData.Length`（[SlideControl](../.tools/visual-reverse/warnings/Gameplay_Control_SlideControl.cs:21)）。因此 Checker 读到的是已绑定真实路径资源的谱面对象。

`GetPath` 以 command、起点、终点距离和中间距离查 `RuntimeManager.slideTypes`；负距离加 8，起点 3–6 时交换 `<`/`>`，`V` 还按 `centerDistance` 匹配（[SlideTypesData](../.tools/visual-reverse/warnings/Gameplay_Data_SlideTypesData.cs:13)）。命中的 `SlidePathData` 含 `points`、`splitIndexes`、`enterAreaData`；`Length` 是相邻三维点距离之和（[SlidePathData](../.tools/visual-reverse/warnings/Gameplay_Data_SlidePathData.cs:9)）。Checker 并不根据路径点做最近距离查询。

项目已有 UnityPy 1.20.26 提取链 [extract_rendering.py](../tools/visual-scene/extract_rendering.py:644)，从实际 `SlidePathData` 序列化字段读路径点、`split_indexes` 和 `enter_area_data`，每个自定义对象都要求 `Reader.finish()` 精确耗尽字节。完整 [rendering fixture](../fixtures/visual-maimai/rendering.json) 含 69 个唯一路径对象、73 个 `SlideTypesData` info 引用、69/69 条非空 `enter_area_data`，总计 171 个区域事件；资产来自 `sharedassets0.assets`，其 SHA-256 记录在 fixture metadata 中。每条路径均保留 object ID 和 asset 来源。

当前 Web [slide-paths.json](../apps/web/src/skin/slide-paths.json) 仅投影 29 条已支持几何（`-<>vsz`），含路径点、分片和长度，但没有投影 `enter_area_data`。这 29 条在完整 fixture 中对应 87 个区域事件，可从已有 fixture 按实际 `SlideTypesData` PPtr/路径 ID 精确派生，无需反推几何。Wi-Fi 的 warning 事件由源码固定生成，不依赖路径资源。

## Checker 的公共处理

`Check` 把 `taps + holds + slides` 合并成环道列表，把 `touches + touchHolds` 合并成 Touch 列表。Slide 的每个 `SlidePartData` 是一条独立分支；该分支的 `fragments` 是连续路径段。头部无头（`hindHead`）不会作为一个可命中的环道音符参与 codes 0–2、7、8，但它的 Slide 分支仍参加 code 3 和路径区域事件生成。

两个预处理影响后面的边界：

- `array[n]`：若一条音符与另一个同 lane Slide 的 `hitTime + prepareTime` 相同，就标记它。该标记不会排除 code 7/8；它只在各类多押累计时阻止计数。`isNoMulti`、每拍视觉 `IsMulti`、EX 以外的属性都不参与此预处理。
- `SlidePartData.IgnoreEnd`：若非 Wi-Fi 分支的最后 fragment 终点等于另一条 Slide 的起点，且本分支 `hitTime + prepareTime + moveTime` 与对方任一分支的 `hitTime + prepareTime` 相同，则本分支的移动终点不再算作活动重叠端点。只有 codes 1/2 的 Slide 覆盖计数使用这个标记；code 3 仍按原始完整区间检查。

除 codes 4–6 外，Checker 直接比较 `TimeData` 拍位置；其隐式浮点值为 $4 \times beat / split$。结果按规范化 `TimeData` 作为 key。`AddResult` 将返回状态设为有检查结果，并在同一 key 下按 code 去重，不会合并不同 code。

## code 0–8

以下均来自 [ChartWatcher.Check](../.tools/visual-reverse/warnings/EditorScene_Check_ChartWatcher.cs:13)。区间端点按源码中的不等式描述，避免把它们误写成通用碰撞规则。

| Code | 类型 | 实际判定 |
| --- | --- | --- |
| 0 | Bad | 对当前有头环道音符，`num2` 初值为 1；对每个不同环道对象，若 `IsTapMulti(current, other)` 成立，且两对象都未被 `array` 标记，则 `num2++`。`num2 >= 3` 报错。这里不把同一 Slide 音符的多条分支当成多个头部。 |
| 1 | Bad | `count` 统计当前 hitTime 落入其他 Slide 活动分支的数量；普通分支每条加 1，Wi-Fi 分支加 2。活动区间为 `[hit + prepare, hit + prepare + move]`，但若 `IgnoreEnd` 则右端改为开区间。当前对象未被 `array` 标记时才累加；同一 Slide 对象自身会跳过。若 `count > 0` 且 `count + num2 >= 3`，并且 `num2 > 1`，报 Bad。 |
| 2 | Warning | 与 code 1 使用同一计数条件，但 `num2 <= 1` 时记 Warning。 |
| 3 | Warning | 把所有 Slide 分支（包括无头 Slide、同一共享头下不同分支）展平。三个不同分支若移动区间两两严格相交，即 `startA < endB && startB < endA`，报 Warning。区间只含 `prepare` 后的移动，不含等待；结果 key 是三条分支 `max(hit + prepare)` 的规范化拍点。仅端点相接不算相交；但零时长分支的点若严格位于另两支内部，三组比较仍可同时成立，因此源算法也会给出 code 3。 |
| 4 | Warning | 先生成 Slide 区域事件，再检查每个有头环道音符。若 lane 相同、`delta = noteTimeSeconds - eventTimeSeconds` 满足 `delta <= maxHitRange` 且 `delta >= -0.001`，但没有同 lane 的 severe 命中，且音符不是 EX，则报 Warning。默认 `maxHitRange = 0.2s`。 |
| 5 | Bad | 同 code 4 的候选，但 `delta < severeHitRange` 且非 EX；首次命中后停止扫描该音符的区域事件。默认 `severeHitRange = 0.12s`。 |
| 6 | Warning | 同 code 4 的 severe 范围，但音符为 EX；记录 code 6 后停止扫描该音符。严重命中优先于 code 4，不再给同一音符补 code 4。 |
| 7 | Bad | `IsTapMulti(a,b)` 只问当前 `a.hitTime` 是否落在另一对象 `b` 的 `[b.hitTime, b.hitTime + holdTime]` 中；Tap/Slide 的结束点就是起点，Hold 用自身 `holdTime`。若满足且两对象环道 lane 相同，报 Bad。区间端点包含。当前无头 Slide 被跳过；内层候选的无头过滤却只在当前音符未被 `array` 标记时执行，因此被标记的普通音符仍可能与无头候选产生 code 7。 |
| 8 | Bad | 只比较环道 lane 与 Touch 区域 `A{lane}`；B–E 与环道不碰撞。Ring 侧为 Tap/Slide 的单点或 Hold 区间，Touch 侧为 Touch 单点或 TouchHold 区间；两个闭区间相交时报 Bad。无头 Slide 不作为头部参与此项。 |

`IsTapMulti` 是有方向的辅助谓词：它检查 `a.hitTime` 是否在 `b` 的持续区间，而不是拿两个区间做对称区间交集。外层会以每个音符为 `a` 再扫描其他对象，这能发现普通 Hold 与 Tap/Hold 的重叠；不要在实现中替换成不等价的对称规则。`CountTapAndSlideMulti` 的原始端点条件是 `hit >= start`，且 `IgnoreEnd ? hit < end : hit <= end`。

### codes 4–6 的路径区域事件

每个 `SlidePartData` 的移动开始/结束时间先算为：

$$ t_0 = Bpm.GetTime(hit + prepare), \qquad t_1 = Bpm.GetTime(hit + prepare + move). $$

非 Wi-Fi 分支中，令 `L` 为该分支所有 fragment 路径长度之和，`P` 为当前 fragment 前面路径长度之和，`l` 为当前 fragment 长度。fragment 内每个序列化 `SlideEnterAreaData(area, timeRate)` 的事件时间为：

$$ t = Lerp(t_0, t_1, clamp(P / L + timeRate \times l / L, 0, 1)). $$

事件 lane 是 `AddTrack(area, fragmentStartButton - 1)`，而 `AddTrack(i, n) = ((i + n - 1) mod 8) + 1`。完成一个 fragment 后，后续 fragment 的起点 lane 变成前一段 `endButton`。这完全依赖路径资源显式给出的 `enterAreaData`，不依赖线段最近距离、点采样或手绘匹配。当前提取值的 `area` 范围为 1–8、`timeRate` 范围约 0.08142–0.96675。

Wi-Fi 没有 fragment 路径事件。源码固定在该 Slide 移动时间的 `85.073%` 生成三个区域事件，分别位于起点 lane 顺时针偏移 3、4、5 格。它们与其它路径事件使用同一后续碰撞阈值。

`delta` 边界须照抄源码：大于 `maxHitRange` 被跳过；早于事件超过 1ms 被跳过；`delta < severeHitRange` 是 severe，恰好等于 severe 阈值归 code 4；恰好等于最大阈值仍可命中。对非 EX 音符，扫描到任一 severe 事件就报 code 5 并停止，code 4 被压掉；EX severe 事件报 code 6 并停止。

## 实现前的数据差距与方案

当前 [Core Note / DisplayNote](../packages/chart-core/src/types.ts) 已提供环道/Touch 家族、beat、lane、Hold 时长、EX、Slide head、Break、独立 `additionalPaths` 以及连续 `continuations`；Display 层也有每条分支的 `moveStartSeconds/endSeconds` 和每个连续 segment 的端点。因此 codes 0–3、7、8 的算法输入结构基本齐全，`isNoMulti` 不必补，因为 Checker 本身没读该字段；但这些检查应从规范化 `Note` 和 duration 表达式推导 target beat 区间，不应只拿秒数显示层去替代原始 `TimeData` 运算。

以下是实施前审查确认的差距；本轮已投影事件和 float32 长度并接入检查，具体证据见文末验收链接：

- 资产事件数据已完整存在于 fixture，但 `prepare-slide-paths.mjs` 当前只把点、分片和长度投影到 29 个 Web 路径，未带 `enter_area_data`。只针对现有可编辑路径时，给这 29 个路径追加 `{area,timeRate}[]` 就够；其路径 ID 可通过 `resolvePath` 返回值精确查表。
- 目标 `SlidePathData.Length` 是 C# `float` 累加（Unity `Vector3.Distance`，见 `MathUtility.Sum`）；fixture 与当前 JS 生成器用双精度重新计算长度。一般路径数值很近，但边界事件若要求原生同判定，需复制目标 float32 的逐段距离和累加顺序，不能把双精度长度宣称为 bit-equivalent。
- `SettingsData` 默认 `maxHitRange = 0.2f`、`severeHitRange = 0.12f`，但 `SettingsManager` 从用户 `PlayerPrefs` 的 `vm_settings` 载入覆盖值。因此 Web 若没有同一设置输入，只能明确采用默认阈值 profile，不能覆盖某台原生设备的用户设置。
- `ChartWatcher` 的移动区间是把 Simai 时长表达式先转换成 `TimeData`，再经完整 BPM keyframe 表 `BpmData.GetTime` 变成秒。`ChartImporter.DecryptSlide` 对普通 `[split:beat]` 直接保留拍分数；`##` 秒数与指定 BPM 的 `#` 形式则按音符行 BPM 计算整数 `TimeData`（有截断），之后经过后续 BPM 时仍由 `GetTime` 分段换算。当前 Core `compile.ts` 的 `compileSlidePath` 则对 `HoldDuration` 调 `durationToSeconds(..., bpmAtBeat(note.beat))`，这是 Simai duration descriptor 在 Web 显示层的起始 BPM 换算，不等同于 Visual 内部保存的拍时长经过后续 BPM keyframes 的结果。它不应被称为一般错误，但 warning checker 若声称复刻 Visual，必须单独按 Visual 导入公式恢复拍区间，不能直接复用该派生秒数。

手算反例：在拍 0 是 120 BPM，拍 1 切到 240 BPM，Slide 写作 `1-3[4:2]`。Visual importer 得到 prepare=`TimeData(4,1)`、move=`TimeData(4,2)`。于是移动在拍 1（0.5s）开始，在拍 3 结束；目标的移动时长为拍 1→3 的 0.5s。当前 Core 若将 wait/move 都按 note 起始 120 BPM 转秒，则 wait 为 0.5s、move 为 1s，显示结束时刻是 1.5s；目标是 1.0s。对 Warning 4–6，Slide 区域事件时间会因此偏移。代码0–3、7–8 应比较源拍域区间，不受这段秒数映射直接影响。

现有 Web parser 对不支持的 Slide 结构会保留原文并使难度只读，不产生完整 `Note`。所以即使 fixture 已有 69 条路径资源，当前 DTO 也只能检查被 Web 成功建模的音符。全源格式覆盖还需要无损的检查输入：例如路径 command、middle/center distance、分支和每段时间表达式及 note 标记；仅从只读诊断文本或最近几何不能可靠重建它们。完整资源中额外包含 uppercase `V` 的 middle-button 路径以及 `p/q/pp/qq` 路径；当前 DTO 不能表示 uppercase `V` 的中间键。

## 建议分步实现

1. 新增独立的 Web warning 结果类型，按目标 TimeData 语义实现 codes 0–3、7、8。展开规则要区分“同一 Note 的共享头分支”与“一个分支内的 continuation”，并按源码重建 `array` 和 `IgnoreEnd`。结果 key 仍用 beat，按 code 去重；不和 parser `Diagnostic` 混用。
2. 扩展已有路径生成器，从 `rendering.json` 同 path object ID 投影 29 条支持路径的 `enter_area_data`，加生成/`--check` 校验。对目标 duration 转 `TimeData`、BPM 分段、fragment lengths 和阈值建立独立边界样例；不触碰 `compile.ts` 的显示层 duration 语义。
3. 给 Web 明确一个 warning threshold profile（默认 Visual 值，或可配置值），然后只对有完整可表示模型的难度运行 codes 4–6。将上面跨 BPM 例子和 severe/max 精确边界作为原生 source-oracle 对照样例，避免只靠同一个 Web parser 导入/导出自洽。
4. 若目标是对保留原文的所有 Simai Slide 也报 warning，再另行扩展检查专用的完整语义输入以覆盖现有 DTO 不表示的 path forms；在此之前，不应宣称 0–8 对任意原生谱面完整复刻。

当前 [edit-menu-source.md](edit-menu-source.md) 已记录 Next/Last Warning 与源 checker 的关系及时间比较疑点。即使 checker 算法实现，菜单导航和时间排序仍需单独对照；本文不把 warning 数据生成等同于 Next/Last 的原生 UI 行为验证。

当前实现新增独立 warning 模块与 Worker 派生结果；源算法和 Web 导航的实际检查情况见 [检查器验收](visual-checks-validation.md)。当前拍域模型的检查不等于对任意 Simai 原文在 Visual 导入器中逐字符重放：原导入器的网格整数限制、截断和后续原生运行仍需独立验证。
