# Slide 几何离线提取记录

本记录对应 MajdataPlay `850f3e3eac354d328b1e9e8bde50b64c4946faf5`。提取输入与上游 Git blob ID、SHA-256 保存在 [代表轨迹 JSON](../fixtures/geometry/majdataplay-850f3e3e-representative.json)，源码副本及 GPL-3.0 许可文本保存在 [vendor/MajdataPlay-geometry](../vendor/MajdataPlay-geometry/README.md)。

提取器只覆盖三个代表样例：`line3`（直线）、`circle3`（弧形）和 `wifi`。它读取 `Game.unity` 中的 Prefab GUID 映射、Transform 父子关系与子对象顺序，并解析被 `Star_Line_3` 引用的 `Just_str` 嵌套 Prefab 及局部位置/旋转覆盖。`circle3` 与 Wi-Fi Prefab 的末尾 `SlideOK` 对象直接序列化在文件内。提取器校验该对象的 `SlideOK` 脚本 GUID，并遵循播放器源码中“末尾子对象是 SlideOK”的处理方式。

几何点和视觉条带分开保存。普通 Slide 的 `motionPath.points` 是源码 `SlideDrop.LoadSlidePath` 依次采集的起点、每个条带 Transform 位置和终点；这组点没有时间戳，JSON 不推断它们之间的运行时插值。`visualStrips` 只记录条带 Transform 原点、旋转和缩放，不能替代精灵、皮肤或最终屏幕像素。坐标是 Prefab 根局部的 Unity XY 单位；环上首尾点使用源码 `NoteHelper.GetTapPosition` 的半径 4.8。

连接 Slide 的 `durationWeights.connectionGroupWeight` 记录 `NoteLoader.CreateSlideGroup` 读取的 Prefab 根直接子对象数，包含最后的 `SlideOK`。因此它与视觉条带数、运动点数分别是：$w = n_{children}$、$n_{strips} = n_{children} - 1$、$n_{motion} = n_{strips} + 2$。它只表示该源码中的连接总时长分配权重，不是秒数，也不证明目标二进制采用相同规则。Wi-Fi 使用独立的三个运动点轨迹，按 `WifiDrop` 的环位置规则生成左右与中间终点；当前源码拒绝把 Wi-Fi 放进连接 Slide，因此它的连接权重记为 `null`。

可复现命令需要 Node.js，不使用 Unity 或额外包：

```sh
node tools/geometry-export/extract.mjs
node --test tools/geometry-export/extract.test.mjs
```

本机没有与该提交对应的可执行播放器构建；没有执行 Unity 场景或播放器运行对照。因此这些轨迹是带来源校验的 Prefab/源码提取证据，状态标为 `source-and-prefab-extraction-only`，不作为播放器行为验收，也不解锁连接 Slide 编辑。连接 Slide 行为与逐段时长仍须在固定目标构建上对照后单独判定。
