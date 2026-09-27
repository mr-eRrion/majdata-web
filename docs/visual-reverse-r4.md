# R4：时间、导入、同拍与导出

2026-09-27，静态逻辑恢复。目标 `Assembly-CSharp.dll` SHA-256 为 `e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`；工具 ILSpyCmd 11.1.0.9782。未执行目标 Windows 程序，不代表播放器运行兼容已通过。

## 来源与复现

使用 `DOTNET_ROOT="$PWD/.tools/dotnet" .tools/visual-reverse/bin/ilspycmd -t '<类型>' 'Visual Maimai/Visual Maimai_Data/Managed/Assembly-CSharp.dll'` 定向读取下列类型。原始输出在 `.tools/visual-reverse/r4/`，不加入网页或源码分发。

| 类型 / 成员 | 已恢复的规则 |
| --- | --- |
| `Gameplay.Manager.RuntimeManager.GetDistance` (`0x060002F4`) / `GetTouchDistance` (`0x060002F5`) | 显示距离为 `time * speed * 1.44444f`；Touch 用独立 `touchSpeed`。不是原 Web 固定 2.5 秒的接近动画。 |
| `Gameplay.Manager.ProgressManager.Time` (`0x060002DB` / `0x060002DC`) | 谱面时间 = RawTime − Chart offset；设置谱面时间时 Timer 和音频位置加回 offset。设备音频偏移由 InitManager 独立传给 AudioManager。与 Web 三种时间分离一致。 |
| `Gameplay.Manager.InitManager.InitChartData` (`0x060002C3`) | each 来自相同 `hitTime` 的音符；排除 `isNoMulti`。隐藏 Slide 头不使普通头变 each；多 Slide part 可独立为 each。 |
| `Global.Chart.ChartImporter.ImportChart / ImportNotes / DecryptNote / DecryptSlide` | 自有导入流程，不是对附带 SimaiSharp 的简单封装。时间位置用 `TimeData`；拍分上限截为 384；`/` 同拍，反引号后音符设 `isNoMulti`，`*` 为共享头下独立 part。 |
| `Global.Chart.BpmData.GetTime / GetBeat / ConvertKeyframes` | 对 BPM 段积分；Linear 类型以 1/16 或 1/8 小节离散采样后积分，不是连续线性 BPM 的解析积分。 |
| `Global.Chart.HoldData.GetCommand` | Hold 时长为零导出裸 `h`；起终处于同 BPM 段时保留拍数；跨段则输出固定秒 `[ #seconds ]`（实际字符串没有空格）。 |
| `Global.Chart.SlidePartData.GetCommand` | 默认等候 1/4 小节且头部/移动起点/终点同 BPM 段才导出普通拍数；否则输出 `[wait##move]`，秒数取 4 位。Wi-Fi 终点固定为 `(start + 3) % 8 + 1`。 |
| `Global.Chart.ChartExporter.ExportNote` (`0x0600024C`) / `SortElements` | 同时刻 BPM 在音符前输出；按精确 TimeData 合并；非 each 音符排到同拍组后并用反引号分隔；保留注释取决于设置。 |

`Settings.Data.SettingsData` 构造默认 speed / touchSpeed 都是 8、beatSplit=16、beatScale=2、trackSortType=1（8→1）。这些只是首次初始化候选，不证明用户保存设置或目标运行状态；最终对照需记录实际设置。

## 与现有内核的必要差异处理

1. **each 只派生显示。** `compile.ts` 按约分后的精确 beat 统计当前支持家族，写入 `DisplayNote.isEach`；不修改谱面 Note / 修饰符 / 导出表达。长 Hold 与后来 Tap 在显示时间上重叠不算同拍。反引号、隐藏 Slide 头与共享头未开放前仍只读，不能用简单计数泛化到这些写法。
2. **保留精确时长。** 目标把固定秒数转为 `TimeData(400, floor(seconds * 10 * bpm / 6))`，会损失精度；指定 BPM 的 Slide 时长还会量化为 1/384 小节。Web 继续保留源时长表达，避免导入、编辑、导出导致不可逆截断。
3. **跨 BPM 差异明确记录。** 目标 Hold 把拍数作为编辑时间轴上的长度，跨 BPM 按各段积分；现有 MajSimai 兼容内核按起点 BPM 解释普通 Simai 时长。Web 保持 Simai 语义，不把目标编辑器的内部模型强加给已导入文件。若之后支持目标式拖动，应将所选两端的秒差转成显式秒数表达。
4. **不复刻宽松导入与重写行为。** 目标吞掉单难度导入异常、可忽略未知元数据、first 导出到 3 位。Web 保留原字节、按难度只读、严格完整消费和候选语义校验。
5. **连接 Slide 继续逐个验证。** 目标 `DecryptSlide` 在共享 part 内读取首个时长段，之前的路径描述串分解成 fragments；这与现代逐段独立时长连接写法不等价。`*` 与连接路径不能当同一种结构。

## 最小样例与人工预期

| 输入 / 状态 | 预期 |
| --- | --- |
| `(120){4}1/Ch[4:2],2,E` | 首拍 Tap 和 Touch Hold 各为 each；第二拍 Tap 不因 Hold 尚未结束而变 each。 |
| BPM120，`&first=0.25`，RawTime=1.25 s | 谱面时间 1 s；改变设备校准不写回 first。 |
| 目标 speed=8，time=0.5 s | 距离约 5.77776 Unity 单位；仅作为公式算例，不证明场景坐标和尺寸。 |
| `(120){4}1h[4:4],(240),,,E` | 原 Simai / Web 持续 2 s；目标内部积分模型持续 1.25 s，目标再导出为固定秒。此差异必须单独对照。 |
| BPM120，目标导入 `1h[#0.123]` | 量化为 24/400 小节，时长 0.12 s；Web 保持 0.123 s。 |
| BPM120，`1-5[4:2]` | 默认等待 0.5 s、移动 1 s；跨 BPM / 指定 BPM / 固定秒各需独立样例。 |

## Web 落点与剩余证据

`packages/chart-core/src/compile.ts` 提供 each；`apps/web/src/skin/` 将承接距离和状态映射；`audio/time.ts` 保留谱面/歌曲/设备时间边界。Slide 的时长和共享关系需在解析 DTO、Note 模型、序列化、变换和恢复校验一起扩展，不能仅添加一个预览字段。

本报告恢复 R4 的主要静态规则，尚缺固定 Visual Maimai 与 MajdataPlay 可执行构建的代表播放结果，以及新旧连接写法的逐段对照；不据此开放所有 Slide。
