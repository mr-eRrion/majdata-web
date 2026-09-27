# `*` 共享头 Slide 的源语义

本报告只覆盖 `*` 连接的同头 Slide，不代表运行时绘制已完成目标校准。源码比较对象为 `Visual Maimai` 的 `ChartImporter`、`SlideData`、`SlidePartData`、`InitManager`，以及仓库固定版本的 `vendor/MajSimai`。另外用项目已有 `.tools/dotnet` 编译一份 `/tmp` 临时探针，直接调用 vendored `SimaiNoteParser.GetNotes` 核验 MajSimai 的事件输出；未改仓库源码。

## Visual Maimai 的数据模型

`ChartImporter.cs:227-365` 先从首段数字后读取共享头修饰符：前缀 `b`、`x` 分别写入整个 `SlideData` 的头部 Break、EX；`@` 写入 `toTap`，`!`/`?` 写入 `hindHead`。起始轨道和 `hitTime` 也只保存在这一个 `SlideData` 上。随后从首个路径命令开始按 `*` 拆段，每段由 `DecryptSlide` 创建一个 `SlidePartData`。

`DecryptSlide` 对每段独立读取 wait/move：默认写法是 wait 一拍、move 按 `division:beats`；`BPM#...` 与 `wait##move` 也各自计算该段时间。段内 `b` 写入该 part 的 `isBreak`，`w` 标为 Wi-Fi。普通路径会逐个解析 route fragment；每段开始解析时的当前轨道都重置为共享 `SlideData.button`，所以 `*` 是从同一头部发出的分支，不是从前一分支终点继续的串行链。见 `ChartImporter.cs:420-519`。`SlidePartData.GetCommand` 以共享起始轨道回写 Wi-Fi/路径、该段 `b` 和该段时长；`SlideData.GetCommand` 只写一次共享头并用 `*` 连接各段（`SlideData.cs:15-29`、`SlidePartData.cs:30-49`）。

段数大于 1 时，`InitManager.InitChartData` 对每个 part 调用 `SetSlideMulti`，把所有路径分支标成 Each（`InitManager.cs:117-138`）。这是组内 part 的 Each 派生，不要求另一个同拍音符。共享头的同拍 Each 另由同 beat 扫描处理，并受 `hindHead` 与 `isNoMulti` 分支影响（`InitManager.cs:72-115`）。编辑显示的准备线长度使用所有分支中最大的 prepare time：`SlideData.GetMaxPrepareTime` 取 max，`NoteEdit.cs:224-230` 将这段时长换成显示长度。

## MajSimai 的事件模型

`SimaiNoteParser.GetNotes` 发现 `*` 后调用 `GetSameHeadSlide`（`SimaiNoteParser.cs:42-90`）。该方法先把首段原样解析成一个 `SimaiNote`；对每个后续段，前置首段的首个轨道字符，再解析成一个新的事件，并强制设 `IsSlideNoHead = true`（`SimaiNoteParser.cs:109-152`）。因此有 $N$ 个非空分支就有 $N$ 个 Slide 事件：首事件承载共享头，后续事件是同轨起点的无头分支。

每个事件都以同一个 chart timing 为基准，但使用自己分支里的 wait/move：`TryGetSingleNote` 设置 `SlideStartTime = timing + wait`、`SlideTime = move`（`SimaiNoteParser.cs:241-262`）。前缀 Break/EX/head 只出现在首事件；后续段不会继承它们。MajSimai 的 `NoteFlag.Detect` 在遇到路径命令后把路径命令前的 `b` 归为 `IsBreak`，把路径命令后的段内 `b`（紧邻 `[` 或放在参数后末尾）归为 `IsSlideBreak`；`x` 设当前事件的 `IsEx`（`SimaiNoteParser.cs:632-710`）。

没有 `@`、`!`、`?` 时首事件是默认星头（`IsSlideNoHead=false`、`IsTapHeadSlide=false`）；`@` 让首事件 `IsTapHeadSlide=true`；`!`/`?` 让首事件 `IsSlideNoHead=true`。无论首头类型如何，所有后续 `*` 事件都会被强制标为 `IsSlideNoHead=true`。`SlideStartTime` 仍是各自分支的起动时刻，不是共享星头的 hit 时刻。

## 探针样例

| 输入（BPM 120，hit=10 秒） | Visual Maimai 预期 | MajSimai 实测事件 |
| --- | --- | --- |
| `1-5[4:1]*<7[4:2]` | 一个 `SlideData`，两个从轨道 1 发出的 part；各自 wait=.5 秒，move 分别为 .5/1 秒；两 part 均 `IsMulti=true`；默认星头 | 两个事件：`1-5[4:1]`（wait=.5、move=.5、非无头），`1<7[4:2]`（wait=.5、move=1、无头） |
| `1bx-3b[240#8:1]*-5b[0.25##0.5]` | 一个头部 Break+EX 的 `SlideData`；两个 part 均 path Break；wait 都是 .25 秒，move 分别 .125/.5 秒 | 首事件 `IsBreak=true, IsEx=true, IsSlideBreak=true, IsSlideNoHead=false`；次事件 `IsBreak=false, IsEx=false, IsSlideBreak=true, IsSlideNoHead=true` |
| `1@b-3[240#8:1]*-5b[0.25##0.5]` | 共享头为 Tap + 头部 Break；第一条 path 无 Break，第二条 path 有 Break | 首事件 `IsTapHeadSlide=true, IsBreak=true, IsSlideBreak=false`；次事件 `IsTapHeadSlide=false, IsBreak=false, IsSlideBreak=true, IsSlideNoHead=true` |
| `1!-3[0.25##0.5]*-5[4:1]` | 共享头隐藏；两个独立 part，保留各自 wait/move | 两事件都无头；首 branch 移动在 10.25 秒开始，后续 branch 在 10.5 秒开始 |

上述 probe 将 parser timing 设为 10 秒、BPM=120，输出与源码的拆分逻辑一致。样例只确认语法/数据事件，不代表 target runtime 中各分支的动画细节已验证。

## 供严格解析器实现的边界

可以把共享头保存在一个 `ParserNoteDto`，首分支继续放在原 `SlideDto`，后续分支放 `AdditionalPaths`；每个附加路径只含 command、endPosition、slideBreak、wait、move，不重复 head 或头部 modifiers。所有分支均以主 note 的起始轨道和 hit time 为基准，`DurationSeconds` 取各自 `wait + move` 的最大值，`MoveStartSeconds` 保留首分支的 `hit + wait`。MajSimai 对该 token 的图级结果仍须逐分支对照，预期 event 数等于分支数。

严格子集只接受首分支的现有单段头部语法，以及后续 `command + endpoint + 可选 path b + [duration]`。共享头修饰符只属于首事件；后续事件的 Break/EX 预期必须为 false，path Break 逐支验证。多余 `*`、空分支、后续头修饰符、连接路线或不能无损写入 DTO 的组合，必须让难度只读且不部分发射。运行时验证仍由现有 `slide-validation-pending` 警告表达。
