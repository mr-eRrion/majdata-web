# Slide 手绘路径：静态源码与参考坐标

本文依据目标包的反编译代码和 Unity 序列化场景恢复桌面 SlidePlacePanel 的手绘行为及参考尺寸。以下是静态证据，不代表已在目标程序运行验证；特别是运行时布局重建、不同屏幕比例和失焦时的实际输入行为仍需录屏或场景运行对照。

## 来源与组件定位

- `Visual Maimai/Visual Maimai_Data/level0` 的 SHA-256 为 `5565829c440d808738f313ef5770c6981de46576d884b59197c87a533dbcfd1e`；`Assembly-CSharp.dll` 的 SHA-256 为 `e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`。原始场景由 UnityPy 1.20.26 定向提取，程序由 ILSpyCmd 11.1.0.9782 定向反编译。
- `SlidePlacePanel` 组件是场景 MonoBehaviour path ID `3333`，挂在 GameObject `27`“Slide Place”。它序列化引用的 `slidePanel` 是 GameObject `542`“Slide Tracks”上的 RectTransform path ID `2625`，不是底部按钮面板 `27` 的 RectTransform。
- `Slide Tracks` 拉伸填满 `View`（GO `81`）；`View` 拉伸填满 `View Mask`（GO `494`）。该遮罩上的 `AspectRatioFitter` MonoBehaviour path ID `4060`，脚本引用 path ID `897`，原始 40 字节为 `00000000ee010000000000000100000001000000810300000000000000000000030000000000803f`，SHA-256 为 `72778526139990103f0aef821c480cf87ab8642a6a67f7445c9c31cc378cac68`。MonoBehaviour 头之后从偏移 32 开始是 `m_AspectMode=3`（`FitInParent`），偏移 36 是 `m_AspectRatio=1.0f`。该源场景实参令遮罩正方形适配父 Rect。

## 参考布局的 590 × 590 计算

`Editor Canvas` 的 CanvasScaler 参考分辨率是 `1920 × 1080`，`ScaleWithScreenSize`、`MatchWidthOrHeight`、match=`1`；在参考分辨率下缩放因子为 1。布局链的序列化值给出以下结果：

| 对象 | 场景值 | 参考 Rect 尺寸 |
| --- | --- | ---: |
| `Center`（GO 281） | 拉伸至 Canvas，sizeDelta=`[0,-70]` | `1920 × 1010` |
| `Scale`（GO 53） | 中央锚定，sizeDelta=`[1920,1010]` | `1920 × 1010` |
| `Right Panels`（GO 552） | 拉伸至 Scale，sizeDelta=`[-570,-45]` | `1350 × 965` |
| `Info Panel`（GO 379） | 水平布局下 minWidth=`680`；同级 Property Panel 的 flexibleWidth=`1` | `680 × 965` |
| `View Panel`（GO 160） | 拉伸，sizeDelta=`[0,-230]` | `680 × 735` |
| `View Base`（GO 518） | 拉伸，sizeDelta=`[-80,-145]` | `600 × 590` |
| `View Mask`（GO 494） | `FitInParent`，aspect=`1.0` | `590 × 590` |
| `Slide Tracks`（GO 542） | 拉伸填满 View | **`590 × 590`** |

右侧 HLayoutGroup 无间距、控制子宽度但不强制扩宽；Info Panel 的最小宽度为 680，Property Panel 吸收剩余的 670。View Mask 的 RectTransform 序列化宽高本身为零，因为其尺寸由 AspectRatioFitter 在父 Rect 内计算；`590 × 590` 是用完整序列化父链和 fitter 实参算出的参考布局值，并非对运行时 Rect 的直接读取。项目的 [`desktop-layout.json`](../fixtures/visual-maimai/desktop-layout.json) 保留了大部分父链，原始 fitter 值按上面的 path ID 和字节记录；为复核可运行 `tools/visual-scene/extract_scene.py`，其默认全场景清单位于忽略目录 `.tools/visual-scene/`。

## 原生手绘状态与路径匹配

来源为反编译的 `EditorScene.Slide.SlidePlacePanel`、`SlideUtility`（本地代码目录 `.tools/visual-reverse/r3/`；概要见 [R3](visual-reverse-r3.md)）、`SlideTypeList.GetSelections` 和 `SlideTypesData.GetPaths`。其行为顺序如下：

1. 每帧把鼠标位置变换到 `slidePanel` 局部坐标 `vector`，再用 `vector2 = vector / slidePanel.rect.size * 10` 映射到 10 单位画布。每帧 `_currentTrack` 都是离 `vector2` 最近的 `RuntimeManager.tracks[i].localPosition`；没有距离上限，等距时后出现的轨道覆盖前者。
2. 左键按下仅记录 `_pressPosition = vector`。未开始绘制时，只有该按下位置满足 `width/3 < |pressPosition| < width/2`，且当前鼠标位置与按下位置的局部距离严格大于 `20`，才调用 `StartPaint`。参考宽度 590 下，起笔环带半径是 `196.667–295` 局部单位；换到 10 单位轨道平面是 `10/3 < r < 5`。按下后再移入环带不会满足条件。
3. 起点不是按下时固定的轨道。触发 `StartPaint` 的那一帧，方法读取当帧最近轨道 `_currentTrack`，锁为 `_startPaintTrack`；路径采样以该轨道的真实 `RuntimeManager.tracks[start-1].position` 起步，而不是光标位置。短模式的新放置在无既有 fragment 时允许任意最近轨道起笔；编辑状态还有 `_lastTrackIndex` / `AllowEditHead` 门禁。
4. 按住左键绘制期间，以 `vector2` 为采样坐标；新点距上一个采样点小于 `0.03` 时跳过，否则追加。松开时重新读取当帧 `_currentTrack` 作为终点，并追加该轨道的真实位置。终点也没有距离或面板内命中门槛：它始终是 8 条轨道中最近的一条。
5. `EndPaint` 将整条路径按起点轨道旋转到规范方向，然后由 `SelectSlideFromPath` 按路径累计长度做弧长归一采样，与候选 `SlidePathData.points` 逐点比较平均欧氏距离；分数最低者胜出。算法没有“匹配分数必须低于某阈值”的拒绝条件。分数相同会选候选数组中靠后的项。只有候选为空时才没有匹配结果。

候选来自 `SlideTypesData.types` 的序列化顺序，并保留每类 `infos` 的数组顺序。fixture [`rendering.json`](../fixtures/visual-maimai/rendering.json) 中命令顺序是 `-`, `<`, `>`, `v`, `V`, `s`, `z`, `p`, `q`, `pp`, `qq`；目标源码会按 `CalcDistance(end-start)` 筛除距离不符项。起点在 3–6 号轨道时，`GetPaths` 会交换 `<` 与 `>` 的命令标签。Web 当前只开放 `-<>` 的手绘编辑提交，但匹配会比较完整源候选集，不把未支持的命中替换成已支持类型。Web 候选按钮在受限集合中按 `-`, `<`, `>` 排列，手绘匹配仍须注意源候选顺序及中心轨道的方向交换。

`Show(startTrack, isBreak, placeTrack, callback)` 以 `placeTrack >= 1` 开启 `_editShortSlide`，并隐藏撤销与确认按钮；它调用 `SetTrack(placeTrack)` 初始化轨道选择，但不会锁定手绘起点或终点。起点取首次越过 20 单位门槛那一帧的最近轨道，终点取左键释放那一帧的最近轨道。有效候选被 `AddSlide` 接受后，短模式直接调用隐藏确认按钮，回调一个 fragment 并关闭面板，因此它是一次手势自动提交，不是固定端点的单击选择器。

右键按下调用 `UndoSlide`：正在绘制时该方法直接返回；有候选预览时撤销预览；已有 fragment 时删除最后一段并回到前一终点；没有 fragment 时在允许编辑起点的状态切换 `_selectStart`、隐藏起点头。它不是整体取消。Escape 调用 `Cancel`，清理预览并以 `null` 回调；Enter 调用 `Confirm`，但仅在已有 fragment 时有效。确认和取消按钮由完整模式显示，短模式不显示；短模式成功匹配后自动调用确认。

已反编译的 `SlidePlacePanel` 没有应用失焦或指针离开回调。`Cancel` 也没有显式将静态 `_isPainting` 复位；这是代码层面的状态风险，不足以证明目标运行中必然卡住。鼠标失焦、取消与正在绘制同时发生时的帧行为，以及窗口重新获得焦点后的状态，需要目标程序运行证据。

## Web 坐标换算与视觉边界

原生参考绘图平面每轴是 `[-5,5]`，由 `vector / rect.size * 10` 得到。以 590 单位参考 Rect 归一化，原生 20 单位拖动门槛为：

$$ 20 / 590 × 10 = 0.338983... $$

起笔环带在同一平面中是 `10/3 < r < 5`；原生路径采样步进阈值仍是 `0.03` 平面单位。Web `SlidePathPicker` 将屏幕点换算到轨道坐标后执行这些平面阈值，20 单位项使用 `20 / 590 * 10`。因此交互逻辑采用原生参考 Rect 的归一化坐标，不把 CSS 像素 20 当成 Unity 单位。

预览的可见大小仍由 Web 的 `previewTransform` 单独控制：轨道半径映射到 `min(width,height) * 0.36` 的 CSS 半径，中心也按 CSS 预览容器定位。这是适配后的显示比例，不是原生 590 单位 Rect 的像素复刻；没有目标程序同分辨率截图时，不宣称两者像素位置或视觉大小一致。原生场景参数确定了轨道坐标和预览 Rect 的归一化关系，实际鼠标像素布局仍待运行对照。

可继续补充的目标证据是：在 1920×1080 与一个非参考分辨率下读取/录制实际 `slidePanel.rect.size` 和 CanvasScaler 比例；录制按下点在环带内外、移动刚好跨过 20、起笔后跨轨、松开在任意位置的结果；再验证右键、Escape、Enter 和窗口失焦时的目标状态。静态结论不代替这些运行检查。
