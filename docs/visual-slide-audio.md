# Slide 音效触发与素材来源

静态证据来自 `Assembly-CSharp.dll`（SHA-256 `e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`）。反编译方法 token 可在 `.tools/visual-reverse/r2/` 与 `.tools/visual-reverse/r4/` 对照；音频引用来自 `level0` 的 AudioManager MonoBehaviour（component 3581，GameObject 187），指向 `sharedassets0.assets` 的 AudioClip 对象。此处恢复的是静态条件，未做目标程序运行帧或耳听验收。

## 触发规则

| 事件 | 代码条件与调用 | 播放内容 |
| --- | --- | --- |
| Slide 头命中 | `SlideControl.OnJudge` (`0x06000334`)；仅 `!hindHead` 时调用 `NoteControl.PlayTapSound` (`0x06000329`) | 总是 sound[0] `answer`、sound[1] `judge`；head 的 break 再加 sound[2] `break` 与 sound[9] `judge_break`；head 的 EX 再加 sound[3] `judge_ex`。调用顺序是 0、break 的 2/9、EX 的 3、最后 1。 |
| 移动起点 | 每个 `SlidePartData` 各有一个 `SlideLineControl`；当更新首次满足 `time >= _prepareTime` 且早于 `_moveTime` 时，`UpdateSlide` (`0x06000339`) 调 `PlaySlideSound` (`0x0600033B`) | 普通 part 播 sound[6] `slide`；break part 播 sound[7] `break_slide_start`。这是 prepare 等候结束、路径开始移动的时刻，不是 hit 时刻。 |
| 移动完成 | `UpdateAlways` (`0x0600033A`) 首次满足 `time >= _moveTime` | 每个 part 记一次完成；仅 break part 播 sound[8] `break_slide`，普通 part 没有尾音。 |

`SlideData.hindHead` 由源文本 `!` 或 `?` 设置。`SlideControl.GetObject` (`0x06000330`) 会隐藏 note head 与 BeatLine；`OnJudge` 也跳过头部音效、hit effect 和计数。不过 `UpdateAlways` 仍持续更新所有 SlideLineControl，因此 headless 不会静音路径的移动起音或 break 尾音。`@` (`toTap`) 只改变头部使用的 prefab/type，不改变命中音效分支。EX 只影响可见头部的 `judge_ex`；隐藏头不会发出它。

每段的 `SlidePartData.isBreak` 选择路径起音与尾音，`SlideData.isBreak` 选择头部音效。`IsMulti` 不参与上述音效选择；普通/each 使用同一组 Slide 起音和尾音。Wi-Fi 也由同一个 `SlideLineControl` 驱动：`isWifi` 只分支箭头和三颗移动星的显示/位置逻辑；11 个箭头和 3 颗星都不会单独触发音效，每个 Wi-Fi part 仍只触发一次移动起音和至多一次 break 尾音。`StarMono.Init/SetAlpha/SetActive` (`0x06000291`–`0x06000293`) 没有音频调用。

## Seek 行为边界

`ProgressManager.Time` setter 会调用 `RuntimeManager.UpdateNoteJudge`，按目标时间重置 note 的 `Judged/HoldJudging`，但不会重置 SlideLineControl 的 `_slideSoundPlayed` 或 `_slideJudged`。控制器每帧继续跑状态分支；`AudioManager.PlaySound` (`0x060002A9`) 只在 `ProgressManager.IsRunning` 为 true 且音量高于阈值时播放。

- seek 到 hit 之后会把 Slide head 标成已判定，所以不会补发头部命中音效。
- seek 到移动中段没有“按历史事件回放”的调度。如果首个中段更新发生在播放状态，移动起音会当场触发；若在暂停状态更新，`PlaySound` 被忽略，但随后 `_slideSoundPlayed` 仍设为 true，恢复播放后不会补发。
- seek 到 break part 的结束之后也会尝试尾音并置 `_slideJudged=true`。暂停 seek 时音频门禁会吞掉这次播放，恢复后不补发。seek 回 `_moveTime` 之前，下一次 `UpdateAlways` 会把 `_slideJudged` 复位，正常播放再次越过结束时可触发尾音。
- `AudioManager.PlaySound` 会先停止该 clip index 专属的 AudioSource，再 `PlayOneShot`。同一音效索引被同帧多个 part 重复调用时，后一次会先停止前一次来源。

所以这里是逐帧阈值检查加状态标志，不是可按 seek 位置补齐的音效事件时间线。编辑器 `ProgressPanel` 拖动只在暂停状态执行，正符合上面“静音调用仍置标志”的路径；这是反编译所得行为，尚未在目标播放器动态验证。

## 包内音频

AudioManager `sounds` 数组有 10 项，按序号绑定如下。Sound.group 用于音量组索引，不是播放时机或 each/break 分类器。

| sound index | AudioClip ID | 包内名称 | volume group |
| --- | ---: | --- | ---: |
| 0 | 221 | `answer` | 6 |
| 1 | 223 | `judge` | 0 |
| 2 | 225 | `break` | 3 |
| 3 | 227 | `judge_ex` | 4 |
| 4 | 224 | `touch` | 1 |
| 5 | 220 | `hanabi` | 5 |
| 6 | 230 | `slide` | 2 |
| 7 | 229 | `break_slide_start` | 2 |
| 8 | 222 | `break_slide` | 3 |
| 9 | 228 | `judge_break` | 3 |

独立的 `touchHoldClip` 是 AudioClip ID 226（`touchHold_riser`），不在上表数组中。上述 clips 的数据位于包内 `sharedassets0.resource`，AudioClip PPtr 位于 `sharedassets0.assets`。UnityPy 1.20.26 的 `AudioClip.samples` 可从这些流资源直接生成 WAV 样本：Slide 三个相关 clip 当前可解码为 RIFF/PCM、双声道、16-bit（`slide` 48 kHz；两个 break clip 44.1 kHz）。这证明包内音频内容可直接提取，无需外部下载；包中流块本身是压缩资源，导出的 WAV 是解码结果，不是原始压缩块的逐字节副本。本次调查没有把音频导出到仓库。

## Web 接入

`audio/chart-cues.ts` 将已编译音符转换为绝对时刻事件，App 交给现有 AudioTransport 调度。普通音符保留既有提示音；Slide 的可见头部按头部 Break 选择 880/1320 Hz，移动起点按路径 Break 选择同样的音高，路径 Break 另在结束时发出 1320 Hz 尾音。Wi-Fi 每段只生成一次起音，不按星星数量叠加。零移动时长跳过移动起音，仅保留有条件的尾音。三项单元测试检查了独立头/路径修饰、无头 Wi-Fi 和零时长。

这些频率是既有 Web 合成提示音约定，不来自原包声音；没有复刻原 EX 叠音或同一个 AudioSource 被后续事件截断的行为。Web 保留原有按绝对时刻预调度、暂停 seek 不补发过去事件的策略；不依赖 Unity 控制器帧更新的偶然顺序。原音色、物理输出延迟及播放器兼容仍待验证。

`tests/slide-audio-browser.mjs` 已在生产页面及已有 Chromium 中通过。测试监听真实 AudioContext 振荡器调度：无头 Break Wi-Fi 只产生移动起音和尾音，两次调度相隔 1 秒；暂停定位到移动中段后，只发尚未到达的尾音，没有补发头部或移动起音。没有替换播放器或声音节点，也没有据此声称物理输出同步。[原始结果](results/2026-09-27/slide-audio.json)。
