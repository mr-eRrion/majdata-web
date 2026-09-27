# P3 Touch、Break/EX 与镜像源码核对

本文是固定源码的语义审阅与人工预期，不代表解析器、编辑器或目标游戏已通过运行验收。Touch 的参考语法来自 MajSimai README；字段行为来自 vendored parser；游戏侧转发行为来自 MajdataPlay 固定源码快照。人工时间样例见 [`fixtures/charts/p3-touch-expected.json`](../fixtures/charts/p3-touch-expected.json)。

## 固定来源

| 来源 | 固定版本 / 许可 | 用途 |
| --- | --- | --- |
| [MajSimai parser](https://github.com/TeamMajdata/MajSimai/tree/fdb2a3e39d8997a0abbf8b4679062d854473cc77) | commit `fdb2a3e39d8997a0abbf8b4679062d854473cc77`，`GPL-3.0-or-later`；本地版本记录在 `vendor/MajSimai/UPSTREAM.md` | Touch/TouchHold token、位置、时长和修饰符解析 |
| [MajdataPlay Touch loader](https://github.com/TeamMajdata/MajdataPlay/tree/850f3e3eac354d328b1e9e8bde50b64c4946faf5) | commit `850f3e3eac354d328b1e9e8bde50b64c4946faf5`，GPL-3.0；代表几何文件与许可在 `vendor/MajdataPlay-geometry/` | SensorArea 编号、触摸点坐标公式、Touch/TouchHold 字段转发 |
| [MajdataEdit `Mirror.cs`](https://github.com/LingFeng-bbben/MajdataEdit/blob/963812b6ec3e023360993f50fbbd7f51e9de9180/Mirror.cs) | 归档仓库的 HEAD commit `963812b6ec3e023360993f50fbbd7f51e9de9180`；同提交 [`LICENSE`](https://github.com/LingFeng-bbben/MajdataEdit/blob/963812b6ec3e023360993f50fbbd7f51e9de9180/LICENSE) 为 GPL-3.0 | 仅作镜像映射对照。未复制其代码；核对的原文件 SHA-256 为 `f7e4edcba04c87f7662a50e54479e3cf20bf65f7685375d16ab5509f2abb36d8`，许可文件 SHA-256 为 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` |

PLAN 原来链接 MajdataEdit 的可变 `master`。上表将审阅基线固定到实际查询到的 HEAD，便于回归核对。上游源码审阅不是目标游戏二进制的行为测试。

## Touch 的位置和时间语义

MajSimai 在 `vendor/MajSimai/README.md:55–69` 列出 Touch `B1`、TouchHold `B1h[duration]`、Break `b`、EX `x`，并列出常见拍数、绝对秒数和指定 BPM 拍数格式。README 也列了 Touch 的 Hanabi `f`、Mine `m`；它们不是当前图形编辑模型中的字段。

固定 parser 的 `SimaiNoteParser.cs:165–187` 读取 A–E 区。A、B、D、E 取一个位置数字；C 不带位置，并把 `StartPosition` 设成 8。这个 8 是 parser 的哨兵值，不是 C 区的物理位置。游戏端 `SensorArea` 枚举在 `vendor/MajdataPlay-geometry/Assets/Scripts/IO/Base/Enums/SensorArea.cs:3–37` 列出 A1–A8、B1–B8、C、D1–D8、E1–E8；`NoteHelper.GetSensor` 显示各区到该枚举的映射（`NoteHelper.cs:16–32`）。

内核建议沿用当前项目已经冻结的最小增量：将 `kind` 扩为 `touch` / `touchHold`，增加可选 `touchArea: 'A' | 'B' | 'C' | 'D' | 'E'`；Touch 位置 A/B/D/E 为 1–8，C 规范化为 0。Tap/Hold 继续使用 1–8 的环形 `position`。TouchHold 复用 `HoldDuration`，并保留 Break 与 EX 两个独立 modifier 布尔值。这样不用暴露上游 C=8 的实现细节，也不会把 Touch 错画成外圈 Tap。

游戏源码把 A/B/C/D/E 分别映射到 SensorArea；Touch 几何使用 `NoteHelper.GetTouchAreaPosition`（`NoteHelper.cs:34–87`）。代码中的实际半径为 A=4.0、B=2.2、C=0、D=4.1、E=3.1（`NoteHelper.cs:90–104`），A/B 角度为 `-index·π/4 + 5π/8`，D/E 为 `-index·π/4 + 6π/8`。相邻注释仍写 A/D=4.8，与方法返回值不一致，应以方法代码为当前提取依据。坐标和半径来自 Unity 源码，尚未对游戏内画面或命中区域做实测。

## Break 与 EX

MajSimai 的 flag scanner 独立记录 `b` 和 `x`，随后把它们赋给 `SimaiNote.IsBreak`、`SimaiNote.IsEx`（`SimaiNoteParser.cs:265–270`）。README 明列 `B1b` 和 `B1x`，以及 `B1hb[duration]` 和 `B1hx[duration]`。

MajdataPlay 的 Touch 和 TouchHold 构造函数都会转发 `IsBreak`，但两处都将 `IsEX` 硬编码为 `false`（`NoteLoader.cs:740–755`、`807–820`）。因此解析结果中的 Touch EX 与目标 loader 行为不一致；Touch/TouchHold + EX，包括同时带 Break 和 EX 的组合，在兼容对照补齐前必须保持只读。Touch/TouchHold + Break 是源码层面的候选语义，但仍需完成编辑往返和目标表现验收后才能声明可编辑。

TouchHold 的公共 parser 分支调用 `TryGetHoldTimeFromBeats`；无法读出方括号时会把时长降为 0（`SimaiNoteParser.cs:203–216`），而 README 将不带参数的 `B1h` 列为短式。目标 loader 将该数值作为 `LastFor` 使用（`NoteLoader.cs:791`）。现有代码审阅无法证明短式的渲染、判定和导出语义等同于 `HoldDuration.kind === 'short'`，所以裸 `TouchHold` 暂时只读。带参数 TouchHold 必须拒绝负数、非有限数、分母为零和格式错误，不能把 parser 的 0 秒回退当作格式错误的合法结果。显式 `[#0]` 的零时长不预先判为非法，但在严格解析与序列化往返通过前保持只读候选。常见时长换算为 `seconds = 60 / bpm × 4 / division × beats`；例如 120 BPM 下 `[4:4]` 是 2 秒，`[#0.25]` 是 0.25 秒。

## 镜像映射的比较预期

固定 `Mirror.cs` 的普通按键左右映射为 1↔8、2↔7、3↔6、4↔5；上下映射为 1↔4、2↔3、5↔8、6↔7。顺时针 45° 将 8→1、7→8、…、1→2；逆时针将 1→8、2→1、…、8→7。180° 是先做左右，再做上下。

D/E Touch 在左右与上下镜像中使用专门的位置表，区域字母不变。例如左右下 `D1→D1`、`D3→D7`，上下下 `D1→D5`，顺序合成为 180° 后 `D1→D5`。45° 用普通环形位置移动，代码没有为 D/E 单独换表。以下是从该文件映射表直接推导的对照，不是已运行测试：

| 输入 | 变换 | 人工推导 |
| --- | --- | --- |
| `B1` | 左右 | `B8` |
| `D1` | 左右 | `D1` |
| `D3` | 左右 | `D7` |
| `D1` | 180° | `D5` |
| `B1` | 顺时针 45° | `B2` |
| `B1` | 逆时针 45° | `B8` |

`Mirror.cs` 是按文本切段转换：跳过 `[...]` 时长内容，对花括号和圆括号区段不作变换；其源码注释特别指出 `1-5[8:1]{16}` 能被解析但不能正确镜像。45° 的 `<`/`>` 方向替换也没有先确认当前 token 是否是 Tap。因此应用应在完整 AST/source mapping 上做变换，并以这些映射作人工回归预期；不能对任意原始文本直接运行字符替换。

## 保守只读范围

- 任意 Touch/TouchHold + EX；包括 `x` 与 `b` 同时出现的组合，因为固定目标 Touch loader 不转发 EX。
- 不带时长的 TouchHold，以及负时长、非有限时长、零分母、坏格式或额外未消费字符。显式 `[#0]` 保留为待严格往返验证的零时长候选。
- A/B/D/E 之外的位置值、缺少位置、多个位置数字、`C` 后带多余字符。固定 parser 对外围索引只读一个字符且没有 1–8 范围检查；严格 parser 应精确消费并验证输入。
- Hanabi、Mine 与反引号 fake-each 分组。当前编辑类型未保留 Hanabi/Mine 修饰或 fake-each 关系；普通 `/` 同拍音符可以按相同 beat 与 source order 保留，不应一概设为只读。
- 含 Slide、未知装饰或未消费尾随内容的 Touch token，以及任何目标预览轨迹/判定尚未完成比对的谱面难度。

可逐步开放的候选顺序：无附加修饰的 A/B/C/D/E Touch；单独 Break 的 Touch/TouchHold；明确拍数或秒数的 TouchHold。每个小类都需解析诊断、编辑、撤销、保存重开与目标表现使用同一人工 fixture 验证后再解除只读。
