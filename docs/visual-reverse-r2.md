# R2：Slide 与 Wi-Fi 的静态规则

2026-09-27。来源是固定主程序集 `e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`，使用 ILSpyCmd 11.1.0.9782 定向反编译；原始输出 `.tools/visual-reverse/r2/`。尚未取得目标程序运行帧，不以静态恢复冒充动态验收。

## 路径来源与坐标

`Gameplay.Data.SlideTypesData.GetPath` (`0x06000310`) 在序列化 `types[].infos[]` 中选择 `SlidePathData`，不是现场计算曲线。选择键是 command、终点与起点差、V 的中点差；负差加 8。起点在 3–6 时交换 `<` / `>`，其他命令不交换。`GetPaths` (`0x06000311`) 用同一映射列出给定端点可选路径。

`SlidePathData` 的序列化数据包含 `points`、`splitIndexes`、`enterAreaData`。`Length` 为相邻点的欧氏距离总和。点列实际沿消退保留方向存储：`SlideLineMono.SetSlide` (`0x06000282`) 的进度 0 取点列末端作为星星起点，进度 1 取点列开头作为终点。Web 不可按常见的起点→终点约定直接使用原数组。

`SlideLineControl.GetObject` (`0x0600033D`) 将每段置于 slideBase，局部 z 为移动开始秒数 / 100 + 段序号 × 0.001，局部旋转 `(startButton - 1) * -45°`。后一段起点取前段 endButton。Web 转为屏幕坐标需翻转 Y，同时调整旋转符号；不得直接套用 Majdata Prefab 坐标。

## 等候、运动与消退

`SlideLineControl` 构造函数通过目标 BPM 积分得到三个绝对时间：hit、hit + prepare、hit + prepare + move。与源 Simai 跨 BPM 的差异见 [R4](visual-reverse-r4.md)。

| 时间 | `UpdateSlide` (`0x06000339`) 行为 |
| --- | --- |
| 晚于 hit 前 0.2 s 且早于结束 | 创建可见条带；透明度 `1 - (hit - now) / 0.2`，材质最终颜色范围需渲染时处理。 |
| hit 前 | 条带全长，星星隐藏。 |
| hit 到移动开始 | 路径保持全长；星星透明度等于等候进度，scale 从 0.4 到 1，进度 ≤0.001 时隐藏。 |
| 移动期间 | 星星按整条 part 的总弧长匀速运动，跨 fragment 用各段长度分配时间；已过段清空，后段维持全长。 |
| 结束及之后 | 整条回收；seek 回到之前由绝对时间直接恢复。 |

`SlideLineMono.SetSlide` 以 `L * (1 - clamp(p)) - 0.001` 从点列开头量剩余长度，星星在线段间插值，朝向为段向量角度 +90°。条带裁切按采样点数量推进，星星可在线段内部运动。每个 `splitIndexes` 分段的最后线段被伸缩，使该段总长四舍五入到 0.5 单位倍数；这影响平铺材质，不能简单用等距 Sprite 假装完全一致。LineRenderer 的场景宽度、Tile 模式及材质平铺参数已提取，见下方参数记录和预览验收；原生网格像素仍待校准。

## Wi-Fi

`SlideWifiMono.SetSlide` (`0x0600028D`) 同时摆放 11 个箭头 Sprite；编号是空间序列，不是 11 帧动画。进度 p 隐藏前 `floor(p * arrows.Length)` 个，其余保持显示。normal / each / break 是完整数组替换，break 优先。

三颗星分别从 `RuntimeManager.tracks[0]` 线性移动到 tracks[3]、tracks[4]、tracks[5]；对应基准起点 1 到终点 4、5、6。对象整体按实际起点旋转。11 张箭头的位置、scale、Sprite pivot 必须读 Prefab/场景；仅凭文件宽高不能恢复空间排布。

## 共享头纹理与旋转

`SlideControl` 与 `Global.Chart.TimeData` 没有单独保存在仓库的反编译 `.cs` 文件中；下列结论由固定主程序集定向 ILSpy 输出及 `metadata-methoddef.json` 对应 token 核对，未把临时反编译内容当作仓库路径引用。

`SlideControl.GetObject` (`0x06000330`) 对非 `@` 星头按 part 数选择 NoteType：单 part 用 `Slide`，多 part 用 `SlideMulti`；`SkinManager.LoadSkin` (`0x060002FD`) 分别按 `star` 与 `star_double` 文件族装载，因此多支共享星头使用 `star_double`、`star_double_each`、`star_double_break`、`star_double_ex` 中与头部状态对应的一套。`@` 头始终取 Tap prefab 和 Tap 皮肤，即使有多个 part；`!`/`?` 头隐藏。`TapMono.InitNote` 仍独立处理同拍 `IsMulti`、头部 Break 与 EX 覆层。

头部旋转不是由最长分支决定。`SlideControl` 构造函数 (`0x0600032F`) 遍历全部 `SlidePartData.moveTime`，忽略小于等于 `0.001` 的值，取最小的正值后设速率为 `-360 / min(moveTime)`；若没有合格时长则为零。`UpdateNote` (`0x06000333`) 每帧写入 `time * rate` 的局部 Z 角，没有按星头类型分支，所以 Tap 头也沿用该旋转。这里 `moveTime` 是 `TimeData`，不是秒：`TimeData.op_Implicit` (`0x06000263`) 转为 `4 * beat / split`，单位为四分音符拍。`DecryptSlide` 对裸 `division:beats` 使用原分数；显式 BPM 写法先以 split `384` 存储并截断整数 beat；`wait##move` 秒数先以 split `400` 存储并截断整数 beat。因此 Web 从保留的移动时长复算旋转输入时，对应换算为 `4 * trunc(beats / division * 384 * sourceBpm / explicitBpm) / 384` 与 `4 * trunc(seconds * 10 * sourceBpm / 6) / 400`；裸拍数为 `4 * beats / division`。

多 part 的每条路径在 `InitManager.InitChartData` 中被设为 `IsMulti`，所以移动星和路径各自使用 Each 皮肤；每条路径的 `isBreak` 仍单独优先。共享头的 Break/EX 属于 `SlideData`，不会传给分支材质或移动星。Web 当前按这些状态选择路径纹理，`slideHeadEntry` 用最短分支时长驱动单个共享头旋转；原生逐帧像素仍需目标程序对照。

## 最小人工预期与 Web 落点

- `1-5[4:2]` 在 BPM120 下 hit=0、移动开始=0.5 s、结束=1.5 s。t=-0.1 s 条带半透明而星星隐藏；t=0.25 s 星星 alpha=0.5、scale=0.7；t=1 s 已走总弧长一半；t=1.5 s 整条回收。
- `1w5[4:2]` 在移动中点应隐藏前 5 张、显示后 6 张；三颗星分别位于 1→4、1→5、1→6 的中点，而非共用一条路径。
- 两段长度 2 与 6 的连接 part，整体移动进度 0.25 时到段边界；不是每段各分一半时间。现代分段独立时长写法仍需单独验证，不能据此转换。

路径数据应生成到 `fixtures/visual-maimai/`，由现有编译快照携带 Slide 的时序与关系，`apps/web/src/skin/` 按绝对时间生成显示状态，PixiJS 预览负责原素材组合。解析、编辑、序列化、撤销、变换和恢复同步贯通后才可开放对应类型。

本报告恢复了代码路径和公式，路径坐标、材质、Wi-Fi 空间排列以场景提取结果补充；播放器兼容与目标动画对照仍未完成。

## 纯预览路径内核准备

`tools/visual-assets/prepare-slide-paths.mjs` 从 `fixtures/visual-maimai/rendering.json` 投影 `-`、`<`、`>` 的已序列化路径点，以及 Wi-Fi 星星使用的 tracks[0] → tracks[3]/[4]/[5] 局部端点；输出 `apps/web/src/skin/slide-paths.json`。`resolvePath` 只接受这三类路径，按源码的 lane 3–6 `<`/`>` 互换和负距离加 8 规则查表，未序列化的直线距离及其他命令明确报错。`pointAtProgress` 按源 `points` 的反序总弧长取样，应用起点根旋转，并还原线段切向 +90°；`slideFrame` 根据绝对时间重算 0.2 秒显示窗、淡入、星星预显和移动进度，支持 seek。Wi-Fi 星星位置按 `SlideWifiMono.SetSlide` 对三条固定轨迹分别线性插值，并应用整体起点旋转。

这只是预览内核准备，maidata 解析、DisplayNote、编辑、序列化、撤销及变换都尚未接入。`V/v/s/z/p/q/pp/qq` 等其他类型仍明确不支持。Wi-Fi 箭头位置与 Sprite 布局已另由 [场景提取](visual-scene.md) 恢复，并在 `/skin-reference.html` 静态展示；路径函数本身不绘制箭头。源码 `Map01` 不做 clamp；`slideFrame` 的 `alpha` 保留控制器原式，渲染端需处理颜色范围。`pointAtProgress` 复刻路径端部 0.001 单位偏移；隐藏阶段源码不更新星星缩放，纯状态将其归一化为 0.4。尚未用目标运行帧验证像素效果。

## SortingGroup 与叠放顺序

`tools/visual-scene/extract_rendering.py` 从 `sharedassets0.assets` 的 `SortingGroup` 序列化类型树读取组件 ID、GameObject/Transform ID、Sorting Layer 原值、Order、启用状态和 `sortAtRoot`，并将祖先组链写入 [场景 fixture](../fixtures/visual-maimai/rendering.json)。[Slide 精简投影](../apps/web/src/skin/slide-parameters.json) 保留 Slide 头、移动星、线段、Wi-Fi arrows 的组链及 renderer ID；普通 Tap/Hold/Touch prefab 的根组也投影到 `parameters.prefabs.<kind>.sortingGroups`。目标组均为 layer ID/raw 0、enabled=true、sortAtRoot=false：Wi-Fi Base GO489/group854 的 order=2；Lines GO592/group858 为 3；移动星 Slide Star GO597/group862 为 4；Slide 头 Star GO598/group863 为 5。Tap GO596/group861 与 Hold GO634/group853 同为 5，Touch GO629/group857 为 6，Touch Hold GO435/group859 为 7；SlideMulti GO595/group860 也为 5。相应 renderer ID 可在 projection 的 `sorting.rendererOrders` 查到：Wi-Fi arrows 为 0、移动星为 0、头部两个 renderer 为 0，LineRenderer IDs 843/844/845 在 Lines 组内分别为 1/2/3。

Unity 的 [SortingGroup 参考](https://docs.unity3d.com/cn/6000.0/Manual/sprite/sorting-group/sorting-group-reference.html)说明，组按 Sorting Layer 和 Order 与其他组排序，较低 Order 先进入渲染队列；组内 renderer 再按自身排序值排序。因此静态证据给出的组级顺序是 Wi-Fi arrows → Slide line → 移动星 → Slide head；Tap/Hold/SlideMulti 与 Slide head 的 Order 同为 5，仅靠组 Order 无法彼此区分，Touch/Touch Hold 则依次更后。反编译的 `SlideLineControl.GetObject` 设置 Slide fragment 局部 z（prepare 秒 / 100 + fragment 序号 × 0.001），并把移动星设为首段子节点；`SlideLineMono.InitSlide/SetSlide` 与 `SlideWifiMono.InitSlide/SetSlide` 改变材质、点列、Sprite、可见性及星星 Transform，没有修改 SortingGroup 或 renderer sortingOrder。没有发现运行时把路径材质队列改到星星之上的代码。相交位置的最终像素仍受相同 Order 下的深度排序及目标 Camera/透明度设置影响；完成目标程序交叠场景的像素对照前，这只是静态排序结论。
