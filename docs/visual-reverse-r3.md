# R3：桌面编辑器交互

日期：2026-09-27。目标程序集 `Assembly-CSharp.dll` SHA-256：`e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`，MVID：`58e61df1-0329-40d9-801a-4e104725cca0`。使用 ILSpyCmd 11.1.0.9782 定向反编译；提取源码在忽略目录 `.tools/visual-reverse/r3/`。本报告是桌面编辑器的静态恢复，没有运行目标程序。

## 时间轴坐标与命中

`EditorScene.Edit.NoteTrack.UpdateNoteTrack` 与 `EditorScene.Edit.TouchTrack.UpdateTouchTrack` 以同一公式摆放对象：

$$ y_{local} = 200 + (t_{note} - t_{playhead}) \times 150 \times beatScale $$

其中 `t_note` 由 `BpmData.GetTime(TimeData)` 得到，`ProgressManager.Time` 是谱面秒数。未来时间增大时 Unity 局部 y 增大，所以时间轴上的未来朝上。Web Canvas 的 top-down y 应反转方向：`y = playheadY - (seconds - viewSeconds) * pixelsPerSecond`。设置默认 `beatScale=2` 对应 300 px/s；它只是构造默认值，运行设置可被用户配置覆盖。

`BeatLineManager.UpdateSelectedTime` 在 Canvas 局部 y 上选最近拍线，距离阈值 30 Unity 单位；`TrackControl.IsInteracting` 只按 Canvas 局部 x 的轨道矩形命中。左键按下置 `CanPlace`，左键释放时才调用轨道的 `OnPlacing`。因此命中时间由 y 决定，轨道/位置由 x 决定。实际 RectTransform、轨道排序与锚点已由 [场景提取](visual-scene.md) 补齐；屏幕效果仍需运行对照。

## 放置状态

桌面路径为 `BeatLineManager` → `TrackControl.OnPlacing` → `NoteTrack` 或 `TouchTrack`，不是 `Mobile.Edit.*`。`SelectArea` 文件也引用 Mobile 类型，但其桌面框选分支使用 `BeatLineManager`；本报告不将移动端手势混入桌面行为。

| 工具 | 桌面状态转换与结果 |
| --- | --- |
| Tap | 单次左键释放立即创建，轨道与拍点取释放时当前选择；同拍同轨同类重叠会拒绝。 |
| Hold | 首次左键释放记录时间与轨道并进入待放置状态；第二次左键释放创建，端点排序，轨道固定为第一次点击的轨道。右键按下取消；检查到的路径没有 Escape 取消。两次同拍没有显式拒绝。 |
| Touch | `TouchTrack.OnPlacing` 先选时间，传感器面板经 `PlacingNote(area)` 调用 `PlaceNote` 创建；Touch 与 TouchHold 同传感器同拍重叠检查会拒绝。 |
| TouchHold | 先在 Touch 轨选时间，传感器面板固定起点区域并进入待放置；随后在轨道点击终点生成两端差。右键按下取消；未拒绝显式零时长，也未找到 Escape 取消。 |
| Slide | 首点确定星标与轨道。`IsOneBeatStart` 默认开启时自动令起始点为首点后 1/4 小节，否则依次要点选准备点和终点。Wi-Fi Slide 随即生成；普通 Slide 打开路径面板。 |

`NoteTrack.PlaceHold`（token `0x060005D2`）及 `TouchTrack.PlaceHold` 都按两个 `TimeData` 端点排序，再存端点差。Slide 普通路径由 `SlidePlacePanel` 收集：鼠标左键从圆环指定区域起笔，移动超过 20 px 后按最近轨道采样路径，松开调用 `SlideUtility.SelectSlideFromPath` 匹配命令；右键撤销/回退起点，Esc 取消，Enter 或确认按钮在存在路径段时提交。短路径可自动确认。这些视觉阈值和按钮显隐仍需场景 / 运行对照。

## 拖动、框选与快捷键

- `EditMono.OnPointerDown` 只准备左键拖动，指针移动达到 5 px 才进入拖动；否则释放作为点击。右键调用删除，中键调用当前工具设置。Slide 在 Ctrl+左键点击时复制命令文本。
- 普通 Tap / Slide 拖动以松开位置的时间和轨道为目标。Hold 拖动选择离按下拍点较近的头端或尾端；拖头只改起点，拖尾重算两端差，越过另一端时端点交换。多选拖动走组编辑。Touch 拖动只移动时间。
- `SelectArea.OnBeginDrag/OnEndDrag` 的桌面分支仅左键生效；Ctrl 在框选开始时保留已有选择。时间区间包含 Tap / Slide 命中点和 Hold 两端相交对象，并按轨道排序选择。中键拖动滚动时间，释放后吸附到拍线。靠近窗口上下沿的自动滚动速度为每秒 2 秒。
- 已检查的快捷键：Space 播放/暂停；逗号前进、Backspace 后退一个网格单位。`ProgressPanel.Update` 无 Ctrl 时按滚轮轴符号移动一个吸附格，按 Shift 则加 `TimeData(1, sign)`，即一小节（四个四分音符拍），不是更细一步；关闭吸附时按滚轮轴值乘以 3 秒移动。Ctrl+O / Ctrl+P 调播放速度；按住 Tab 临时试听并在松开时恢复。左右方向键在轨道悬停时每 0.2 秒快速放置并切换轨道。

## Web 实现约定与最小行为样例

Web 使用 Canvas top-down 坐标，时间以秒为绘制、命中和滚动的共同基准；拍点仍由 `secondsToBeat` / `beatToSeconds` 互换。播放或 seek 推进参考时间，使播放头留在 Canvas 距底部约 200 px 的位置；手动滚动偏移可在连续播放时保留，新 seek 回到播放头。普通 Tap 在释放位置放置。Hold 采用两次点击并在首次点击固定轨道；TouchHold 先在独立轨选时间、再在传感器面板固定区域，随后点击轨道终点。右键取消，工具切换保留两族待放置状态，谱面或难度切换清掉待放置状态，最终只发一个 `EditCommand`。Hold 拖动头端只改起点并保留原始 duration；拖动尾端重算端点差。Touch / TouchHold 拖动只改时间，不改区域或传感器位置。

目标编辑器的 Hold 是两端时间轴差；Web 内核的 `beatsAtStartBpm` 则按起点 BPM 解释全长。若两端之间有 BPM 变化，生成 `duration: { kind: 'seconds', seconds: endSeconds - startSeconds }`，确保编译后尾端等于第二次点击；两端在同一 BPM 段时用等价拍长表达。BPM 事件恰好落在终点不算穿越，因为区间内没有新 BPM 时长。两次点击同拍可创建显式零长度 Hold / TouchHold；`TouchTrack.PlaceHold` 没有拒绝它的逻辑，Web core 也允许显式零时长。

例：以第 0 拍为零秒，BPM 120 下从第 1 拍到第 3 拍，起点为 0.5 s、尾端为 1.5 s，持续两拍即 1 秒；若第 2 拍切至 BPM 240，两端秒数变为 0.5 s 与 1.25 s，应保存 `seconds: 0.75`，不能保存起点 BPM 下的两拍（那会把尾端放到 1.5 s）。同拍两次点击保存显式零时长，形成瞬时音符。

## 当前 Web 与目标的输入差异

- Web 已实现普通滚轮一个吸附格、Shift+滚轮一小节，并暂停和定位音频；Unity 滚轮轴与 DOM deltaY 符号相反。已接入暂停时逗号前进、Backspace 后退、Ctrl/⌘+O/P 调速。拍线定位保留目标的 `-0.0001 s` 偏移，便于查看命中前一刻。
- Ctrl/⌘+滚轮仍为 Web 的缩放扩展；中键已按事件增量拖动实际播放时间，并在松开时按当前 BPM 吸附，边界与播放状态行为见 [验收](timeline-scrub-validation.md)。表单内 Tab 继续用于浏览器焦点导航；表单外暂停时按住 Tab 临时试听，松开或窗口失焦后暂停并还原起点，Shift+Tab 不拦截。左右方向键快速放置已接入，按显示顺序先放置再换轨，浏览器使用逻辑光标替代系统鼠标移动；提交期间等待、其他差异和验证见 [方向键验收](fast-placement-validation.md)。删除选中用 Delete，不占用目标的 Backspace 时间后退。
- 目标只在拍线 30 Unity 单位内命中时间；Web 按鼠标 y 连续换算拍点并按当前细分吸附。目标空白轨道右键弹编辑菜单，当前 Web 右键只用于取消待放置或删除命中音符，没有复刻该菜单。
- 场景确认普通轨道从左向右为 `8,7,6,5,4,3,2,1`，另有独立 Touch 列；SlideTrack 是覆盖编号轨道的图层，不是额外一列。Web 已增加右侧 Touch 轨及 33 个传感器选择面板，取消 C 中线和借用编号轨道。同拍 Touch/TouchHold 聚合显示，拖动整组只改变时间，属性区可选组内单个音符。Web 已接入 Slide 原 PNG 头部和等待/移动时间范围辅助线，单击定位后的头部像素位置检查通过；NotePlaceArea 圆形区已按41个原始中心接入按住跨区放置和右键删除，Ring/Touch工具与待定长音符分别保留；它与 SlidePlacePanel 的路径绘制是两种手势。网页在pointerdown立即首放并保留选择模式，两项输入差异及验收见 [圆形输入](place-area-validation.md)。中键已接入已支持的属性子集，完整模板仍待补齐，见 [中键验收](tool-template-validation.md)。

## 尚需运行证据

静态代码与场景数据确认了时间方向、局部坐标公式、序列化轨道顺序、桌面输入状态与主要阈值；不能证明用户设置下实际 `beatScale`、屏幕裁剪和 Slide 路径命令显隐，也未验证 Unity 帧时序下左键释放与下一帧拍线选择的对应关系。后续应按 [运行对照清单](target-capture.md) 固定设置录制 Hold 两次点击、TouchHold、右键取消、Hold 头尾拖动、框选和 Slide 绘制，再与此静态结论交叉检查。
