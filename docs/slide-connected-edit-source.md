# Slide 路线编辑交互：反编译证据与实现建议

本文按 Visual Maimai 的编辑器源码区分“一条 Slide 路线里的连续段”和“共享同一头部的另一条路线”。证据来自 `.tools/visual-reverse/r3`；`SlideTrack`、`SlideEdit` 和 `SlideFragmentEdit` 由本地 Assembly-CSharp 定向 ILSpy 输出核对。可用 `DOTNET_ROOT="$PWD/.tools/dotnet" .tools/visual-reverse/bin/ilspycmd -t 'EditorScene.Edit.SlideEdit' 'Visual Maimai/Visual Maimai_Data/Managed/Assembly-CSharp.dll'` 复现 `SlideEdit` 片段；下文对应行号是该类型输出的行号。

## 源编辑器状态机

新建普通 Slide 时，`NoteTrack.PlaceNote` 记录头部时间和轨道；`PlaceSlide` 先选等待结束时刻，再选移动结束时刻，然后打开 `SlidePlacePanel`（`.tools/visual-reverse/r3/EditorScene_Edit_NoteTrack.cs:441-535,594-654`）。当选定终点轨道传给 `Show` 时，`placeTrack >= 1` 会开启 `_editShortSlide`：确认和撤销按钮隐藏，首条有效手绘路线立即确认。Festival/自由选择路线用 `placeTrack = 0`，进入非 Short 模式，可继续添加多个连续段，完成后按 Enter/确认提交（`SlidePlacePanel.cs:201-229,364-384`）。

面板内的非 Short 编辑可用如下状态机表示：

1. **确定头部**：起点 lane 来自打开面板时传入的 `startTrack`。新建模式或单 part 编辑允许撤销到空路径后重新选头；当正在编辑一个多 part 的共享头 Slide 时，`AllowEditHead` 为 false，头 lane 固定。
2. **绘制一段**：从当前 `_lastTrackIndex` lane 开始拖动到终点 lane。首段可以确定路径起点；已有段之后，`StartPaint` 只接受从上一段终点 lane 开始的笔划。结束拖动后，`SlideUtility.SelectSlideFromPath` 从起终点对应候选路径中选与笔迹采样最接近的一条，`AddSlide` 把结果加入 `_slideFragments`，并把当前终点设为下一段起点（`SlidePlacePanel.cs:160-198,329-394`）。
3. **继续或收尾**：每次成功手绘追加一条 `SlideFragmentData`，同一分支中的路线按前一段终点连续前进。确认会一次性回调整份 fragment 列表；Escape/取消返回 `null` 并放弃本次面板编辑。确认只在列表非空时生效（`SlidePlacePanel.cs:284-309`）。

时间轴上点选某个路径段的 `SlideEdit`（`EditMono` 的中键走 `OnSelect`）会打开该 part 的编辑面板；时间轴右键走 `OnRemove`，删除整个 `SlidePartData`，若无其它 part 则删除整条 Slide（`EditorScene_Edit_EditMono.cs:13-60`、ILSpy 输出 `SlideEdit.cs:43-76`）。打开单 part 编辑时，`NoteTrack.StartEditSlide` 恢复该 part 的 wait/move 时间，并将已有 fragments 逐条放回面板。确认后整组 fragments 覆盖该 part；取消不写回（`.tools/visual-reverse/r3/EditorScene_Edit_NoteTrack.cs:396-438`）。

面板右键行为不同于时间轴右键：`SlidePlacePanel.Update` 把右键转为 `UndoSlide`。正在手绘时撤销无效；若当前有临时预览，先移除预览；否则从已提交的 fragment 列表尾部删掉一段，并把下一段起点退回上一个 fragment 的 endpoint。列表为空时，只有允许编辑头部的模式才进入重新选头状态（`SlidePlacePanel.cs:99-115,240-282`）。

## 时间字段的作用范围

等待和移动时长不按 fragment 分段。`SlidePartData` 每个 part 只有一组 `prepareTime` / `moveTime`，并独立保存 `isBreak`、`isWifi` 和 `fragments`（`.tools/visual-reverse/r4/Global.Chart.SlidePartData.cs:8-50`）。`SlideLineControl` 对非 Wi-Fi part 为每个 fragment 创建一条线，但只创建一颗星；同一个 part 的单一移动百分比乘以 `part.Length`，再按每段 Length 依次推进，所以整条连续路线共享该 part 的总 moveTime，星跨段连续移动（`.tools/visual-reverse/r2/Gameplay.Control.SlideLineControl.cs:36-54,91-135`）。这不是“每段各有等待/移动时长”。

`SlidePartData.GetCommand` 将同一 part 的所有 fragments 连接后，只输出一次时长；`SlideData.GetCommand` 才在不同 parts 之间添加 `*`（`.tools/visual-reverse/r4/Global.Chart.SlidePartData.cs:30-48`、`Global.Chart.SlideData.cs:15-29`）。因此：

- 同一 part 内追加 fragment = 延长一条连续路线，后段从前段 endpoint 出发，整条路线共用一组 wait/move。
- 对同一 `SlideData` 追加 part = 新增共享头分支，每支从相同头 lane 出发，并可有自己的 wait/move、break 标记和 fragment 链；序列化时对应 `*`。

创建时的同头合并条件是同一时间和 button 上已存在 Slide：`CheckOverlap<SlideData>` 保存已存在索引，最终提交时若 `_slideBaseIndex != -1`，就把新 `SlidePartData` 追加到已有 `SlideData.parts`；否则创建新的 `SlideData`（`.tools/visual-reverse/r3/EditorScene_Edit_NoteTrack.cs:441-484,655-685`）。这为共享头新增分支提供了直接证据。编辑已有多 part Slide 时 `AllowEditHead = slide.parts.Count == 1`，防止单独移动某个分支的共享头（同文件 `:396-419`）。

## 可落地的 Web 编辑方案

UI 应保留两个明确层级：外层是共享头 Slide 下有序的分支列表；内层是选中分支的连续路径段列表。分支拥有各自的 wait、move、break 和 path；path 的每段存 command、middle/end lane，后段起点由前段 endpoint 导出，不单独存重复起点或每段时长。显式的“新增分支”从共享头 lane 重新开始；“追加路径段”则从当前分支末端继续。两种操作的保存编码不同，不能用一类泛化的 `paths[]` 把连续段误当独立共享头分支。

交互上可让右侧面板显示分支卡片，每张卡编辑自己的等待/移动时长和 break 状态；卡内提供手绘匹配或“追加一段”，撤销只退回当前分支最后一段。确认提交当前分支的全部路径编辑，取消放弃该分支草稿；删除分支使用单独的显式删除操作，避免复用面板右键导致误删整个 part。新分支与连续段分别提供按钮，新增分支默认锁定共同 head lane。编辑共享头自身时，只允许对所有分支统一移动头部。

源程序的界面只在一次 `SlidePlacePanel` 会话中编辑一个 part；以上分支列表是将该交互扩展到 Web 的建议，不是声称源程序已有可同时编辑所有分支的列表。时间轴也只读证据确认了“点选一个 part 进入面板”和“右键删除该 part”；Web 可用显式菜单替代中键/右键，但应维持作用范围。

## 未由这组源码证明的部分

这组编辑器源码没有证明目标玩家如何解释现代逐腿 bracket 时间文本；它只证明当前 Visual 编辑模型的时间存储范围。也没有证明运行时对超短/零长度路径的限制、手绘匹配在所有并列候选中的视觉优先级是否有意设计，以及 Web 的事件命中细节。最终兼容仍需目标程序样本或运行时对照。
