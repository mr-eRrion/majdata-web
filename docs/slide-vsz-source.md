# `v`, `s`, `z` 路径来源

本页记录 lowercase `v`、`s`、`z` 的静态路径数据和几何解析。源数据来自 `fixtures/visual-maimai/rendering.json` 的 `sharedassets0.assets`，fixture 使用 UnityPy 1.20.26；对应 `Assembly-CSharp.dll` SHA-256 为 `e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`。`tools/visual-assets/prepare-slide-paths.mjs` 按命令、距离和 source path object ID 提取点列、分片索引及长度，并校验固定的覆盖表；生成的浏览器路径表和 Core 长度表都可用 `node tools/visual-assets/prepare-slide-paths.mjs --check` 复验。

`Gameplay.Data.SlideTypesData.GetPath` / `GetPaths`（见 [R2 静态恢复](visual-reverse-r2.md)）按序列化的 command、端点距离筛选已有 `SlidePathData`，不是运行时构造曲线。源表中 lowercase `v` 只有距离 `1, 2, 3, 5, 6, 7`，source IDs 为 `1246–1251`；`s` 只有距离 4、ID `1245`；`z` 只有距离 4、ID `1252`。本次纳入的 8 条路径全部 `centerDistance=0`。`v` 点列为 41 点、split `[20]`，`s/z` 为 61 点、split `[20,40]`。数组按目标绘制流程的反向点序保存；解析器只在根节点应用 `(start - 1) × -45°` 旋转。`<` / `>` 在起点 3–6 的源交换规则保持原样；源没有对小写 `v/s/z` 做该交换。大写 `V` 是独立的带中点命令，本批不包含。

镜像行为来自同一程序集的 `EditorScene.Select.OperationUtility.FlipNotes` / 局部 `FlipSlideFragment`。水平轨道映射为 `[8,7,6,5,4,3,2,1]`，垂直映射为 `[4,3,2,1,8,7,6,5]`。翻转先按该表映射首尾轨道；`v` 命令保持不变，`s` 与 `z` 则无论水平还是垂直翻转都会互换。旋转路径 `RotateNotes` / `RotateSlideFragment` 不改小写 `v/s/z` 命令；它对大写 `V` 和 `<` / `>` 有单独逻辑。当前 Web 的 `resolvePath` 因此只负责选源 path 和根旋转，翻转后的命令选择遵循内核模型的命令变换。

用 fixture 点列按轨道映射后比较全局坐标：`1v2` 镜像到 `8v7` 或 `4v3` 的最大采样点差约为 `7.4 × 10⁻⁷` 场景单位。`1s5` 镜像到 `8z4` 或 `4z8` 的最大点差约为 `0.03746`；`z→s` 对应相同。也就是说源明确规定两轴都换 `s/z`，但这两份独立序列化曲线不是逐点完全镜像。实现保留各自源点列，不按几何对称性重造曲线。此静态匹配不替代目标程序运行画面对照。

路径单元测试还核对了 `v` 的两片及 `s/z` 的三片 LineRenderer 范围：`[0,20]/[20,40]` 和 `[0,20]/[20,40]/[40,60]`，每片起点直接取对应的源 split 点。这样能发现路径白名单正确但分片索引丢失的错误。
