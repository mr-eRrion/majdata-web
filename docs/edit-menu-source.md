# 时间轴右键编辑菜单来源

目标为 `Assembly-CSharp.dll` SHA-256 `e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`。R3 提取采用 ILSpyCmd 11.1；时间轴入口见 [R3 反编译目录](../.tools/visual-reverse/r3/) 中的 `EditorScene_Edit_BeatLineManager.cs`、`EditorScene_Edit_EditMono.cs`、`EditorScene_Edit_NoteEdit.cs`、`EditorScene_Select_SelectArea.cs` 和 `EditorScene_TitleBar_EditMenu.cs`。菜单层级也与 [桌面场景布局 fixture](../.tools/visual-scene/scene-layout.full.json) 相符。

## 打开与关闭

`BeatLineManager.UpdateSelectedTime`（`EditorScene_Edit_BeatLineManager.cs:139–187`）先要求 `AllowEdit`，再检查鼠标是否位于时间轴有效纵向范围以及某个启用的 `TrackControl` 横向范围内。鼠标右键抬起时，如果 `InvokeRemove` 为真，就清除此标记并返回；否则只在 Edit 下拉当前未打开时，调用 `editDropdown.OpenInPosition(Input.mousePosition)`。打开检查发生在是否命中最近拍线的放置判断之前，因此右键空白轨道无需正好贴近拍线。右键点在音符上由 `EditMono.OnPointerClick` 分派给删除；`NoteEdit.OnRemove` 删除后设置 `InvokeRemove`，避免同一右键抬起又打开菜单（`EditorScene_Edit_EditMono.cs:15–33`、`EditorScene_Edit_NoteEdit.cs:317–341`）。

`editDropdown` 是 `EditorScene.TitleBar.TitleBarDropdown`。`OpenInPosition` 将菜单放到鼠标位置附近并做垂直边界限制；`MenuBar.SetOpened` 关闭之前打开的下拉并暂停时间轨交互。菜单项点击由 `DropdownButton.Init` 注册关闭回调；点击外部 `CloseMenuArea`、再次点击当前标题按钮或应用失焦时关闭。下拉切换时鼠标进入另一个标题菜单也会打开新菜单。检查的这些类没有 Escape 关闭绑定。右键发生时若 Edit 菜单本身已打开，时间轴不会重新定位或切换它。相关方法在 `EditorScene.TitleBar.TitleBarDropdown`、`MenuBar`、`DropdownButton`、`CloseMenuArea`；这些类型由同一程序集定向反编译。

菜单面板在场景中顺序包含 20 个动作，中间用分隔线分组：Undo、Redo、Select All、Cancel Select、Copy、Cut、Paste、Delete、Flip H、Flip V、Rotate C、Rotate A、To Break、Cancel Break、To Break Slide、Cancel Break Slide、To Ex、Cancel Ex、Next Warning、Last Warning。`EditorScene_TitleBar_EditMenu.cs:75–133` 将它们绑定到 `OperationManager`、`SelectArea` 或 `CheckResultTrack`。`EditMenu.Update` 只按 `OperationManager.Chart != null` 设置整个 CanvasGroup 的 `interactable`；没找到逐项的选择数量或剪贴缓存启用条件。无选中时，具体动作按各自方法的空数据保护返回。

## 选择、属性与剪贴

`SelectArea.SelectAll` 选中 Tap、Hold、Slide、Touch 和 TouchHold，不包含 BPM 与拍号 keyframe（`EditorScene_Select_SelectArea.cs:453–473`）。`SetBreak` 对选中的 Tap、Hold、Slide 改 note-level `isBreak`；`SetEx` 对这三类改 `isEx`；二者不修改 Touch / TouchHold。`SetBreakSlide` 只处理选中的 Slide，并将它所有 `SlidePartData.isBreak` 设为目标值（同文件 `:380–451`）。Flip 与 Rotate 对已选的各音符类型执行 `OperationUtility` 变换；Web 实现不应把这些按钮缩成只改圆环 lane 的 Tap 变换。

`Copy` 捕获当前选择的五类音符；若不是拖拽复制，还会捕获选中的 BPM 和拍号 keyframe。`Cut` 就是 Copy 后 Delete。Paste 先深拷贝缓存，取所有被复制对象中最早时刻作为 `MinTime`；按下 Paste 后显示预览，`BeatLineManager.SelectTime` 是鼠标悬停位置吸附后的拍点。左键在有效轨道释放时，以 `selectTime - MinTime` 整体平移时间并生成新 ID。它不会按悬停轨道重新映射音符 lane 或 Touch 区域；原始位置、区域和长音时长保留。BPM 与拍号 keyframe 若被复制也使用相同时间偏移，插入后各自排序。证据见 `EditorScene_Select_SelectArea.cs:70–135`、`:137–235`，以及预览处 `EditorScene_Edit_NoteTrack.cs:713–721`、`EditorScene_Edit_TouchTrack.cs:258–275`。

Web 初次接入菜单时只覆盖音符。后续已补 BPM 标签选择、混合框选及一次事务的复制/剪切/两阶段粘贴，见 [事件剪贴](event-clipboard-validation.md)。Web 以精确拍点作为 BPM 选择键，同拍多个声明作为一组选取；粘贴以最后一个传入 BPM 替换目标同拍声明，避免产生新的冲突声明。菜单“全选”仍只选择音符，第 0 拍 BPM 删除保护保留。拍号仍无编辑模型：原 `ChartImporter` 从 maidata 初始化为 4/4，`ChartExporter.SortElements` 不输出拍号；它依赖原工程 `chart.json` 的保存通道，不能把 Simai 分割数当拍号。右键仍在命中音符的删除处理之后才打开空白轨道菜单，已有工具放置 / 粘贴手势优先。

## Warning 导航

`Next Warning` / `Last Warning` 使用 `EditorScene.Check.CheckResultTrack` 的 `_results`，其数据由 `EditorScene.Check.ChartWatcher.Check` 为目标程序碰撞和 Slide 通行检查生成。它不是解析器语法诊断。两个方法按当前秒数的 `±0.001` 阈值筛选候选，空结果集时不动作；无候选时尝试回绕。但反编译出的候选比较把已选 `time`（秒）与 `(float)TimeData`（拍数）比较，而 `Global.Chart.TimeData` 的隐式 float 转换是 `4 × beat / split`，不是秒。因此在原生上未经验证前，不应声称 next/last 一定选到最近项或正确回绕；Web 的 parser diagnostics 也不可直接接到这两个按钮。

源 `ChartWatcher.Check` 的 result codes 简表（Bad / Warning 由创建 `CheckResult` 时的类型标记）：

| Code | 类型 | 来源条件摘要 |
| --- | --- | --- |
| 0 | Bad | 同拍普通多押数量至少 3。 |
| 1 | Bad | 多押与 Slide 覆盖合并后达到至少 3，且普通多押数大于 1。 |
| 2 | Warning | 多押与 Slide 覆盖合并后达到至少 3，普通多押数不超过 1。 |
| 3 | Warning | 三个 Slide part 的移动时段两两重叠。 |
| 4 | Warning | 非 EX 音符命中 Slide `enterAreaData` 的轨道与时间范围，落在宽警戒范围内但不在严重范围内。 |
| 5 | Bad | 非 EX 音符命中 Slide 通行区域的严重时间范围。 |
| 6 | Warning | EX 音符命中 Slide 通行区域的严重时间范围。 |
| 7 | Bad | Tap / Hold / Slide 之间同轨时间区间重叠。 |
| 8 | Bad | Tap / Hold 与 A 区对应 Touch / TouchHold 时间区间重叠。 |

菜单初次接入时，Web Core 只有解析和编辑诊断，所以 Next / Last 两项保持禁用。后续已新增独立 `ChartWatcher` 派生数据并启用告警导航，没有把“warning”映射成语法 warning。

完整检查算法、区域事件来源、默认阈值和跨 BPM 语义差异另见 [检查器来源与实现边界](chart-warning-source.md)，作为实现依据；当前 Web 的秒域排序导航与源比较疑点的区别见 [检查器验收](visual-checks-validation.md)。
