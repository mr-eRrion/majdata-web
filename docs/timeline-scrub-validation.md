# 时间轴中键拖动播放头

## 来源与实现边界

目标 `SelectArea.OnDrag` 的中键分支将指针位移转换到 `baseTransform` 局部空间，按 `-deltaY / (150 × beatScale)` 累加到当前时间，再调用 `ProgressPanel.SetTime`。Web Canvas Y 轴向下，因此等价为屏幕 `deltaY / pixelsPerSecond`。源方法按事件增量推进；到达边界后反向小幅移动应立即退回，不能以按下点的总位移重算而形成越界死区。

`SetTime` 仅在有谱且暂停时生效，裁剪到歌曲边界并更新音频时间。松开中键调用 `UpdateAdsorption`，按当前 BPM 将拍值以 round-to-even 舍入到拍网格、回秒后减去 0.0001 秒，再裁剪；该方法本身没有播放状态门控。实现据此保留播放中拖动无效、松开仍吸附且继续播放的区别，不通过自动暂停改写这一行为。

Web 的 `snapDivision` 表示一拍分几格，对应源 `beatSplit = 4 × snapDivision`；当前网格始终启用。负时间按首 BPM 外推，正时间使用 Core 的分段 BPM 转换。源定位点为 `.tools/visual-reverse/r3/EditorScene_Select_SelectArea.cs` 的 `OnDrag`/`OnEndDrag`、`EditorScene_ProgressPanel.cs` 的 `SetTime`/`UpdateAdsorption`/`GetAdsorptionTime` 和 R4 `Global.Chart.BpmData.cs` 的 `GetBeat`/`GetTime`。

有曲时按 `[-first, duration - first]` 裁剪，设备校准仍遵循既有音频设计，不混入文件 first；源独立设备偏移与物理同步继续待对照。无曲时保留 Web 的虚拟时间范围 `-2..maxSeconds`，以支持不载入歌曲的编辑。沿用5px拖动阈值和指针捕获；静止中键点中同一音符仍套用当前工具属性，拖动不提交编辑事务，pointercancel保留最后位置并清理手势。

产品变更仅涉及 `App.scrubTimeline`、`Timeline` 中键手势和纯函数 `scrub-time.ts`。普通点击定位、滚轮定位和圆形中键模板入口保持各自的既有调用路径。

## 验收

2026-09-27，100项单元测试、类型/素材检查和生产构建通过。现有 Chromium 153.0.8010.12、1920×1080、DPR 1 的真实鼠标流程通过，主入口 `index-BYynT38X.js`（SHA-256 `291710770fe10335a0c9a1903e315fc4f1bed3f5d89d80fac851b9bc1f439199`）。

[浏览器脚本](../tests/timeline-scrub-browser.mjs) 使用双难度混合夹具、`first=0.25` 和已有10秒双声道参考音：暂停时从1.4拖到1.6秒，再松开吸附到1.6249秒；有曲范围为[-0.25,9.75]，触及两端后反向0.01秒立即生效；取消手势停留1.6秒，不吸附。整个流程文档版本保持v0、撤销禁用。播放中拖动不执行位移，松开后真实AudioBufferSourceNode的重新启动offset减first落在拍格，且继续播放；不以带输出延迟估计的可听显示时间代替软件时钟/音源偏移。报告见 [timeline-scrub.json](results/2026-09-27/timeline-scrub.json)。

纯函数测试覆盖跨 BPM、正负半格舍入和负数预滚。本项仍是源码依据与Web运行验证，不是原生操作对照通过。

静止中键模板的10组流程也重新通过，见 [回归结果](results/2026-09-27/tool-template-scrub-regression.json)。只读保护夹具由已支持的单段Slide替换为仍只读的现代逐段括号路线，同时保留一个普通Tap用于命中；这修正了旧测试前提，没有改变产品支持范围。
