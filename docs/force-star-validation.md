# 静态星形 Tap

## 来源与范围

单个 `$` 对应 Visual Maimai 的 `TapData.toStar`、打包 MajSimai 的 `IsForceStar`；两个 `$` 还会设置 `IsFakeRotate`。Visual 导出只保存一个 `$`，不能用布尔字段折叠后者。当前实现仅接受外圈 Tap 的单个 `$`；Hold、Touch、双 `$$` 和既有未支持 Slide 语法继续诊断并原文只读保存。

目标 `TapControl.GetObject` 为 toStar Tap 从 `NoteType.Slide` 池取 `TapMono`，父节点仍是对应轨道，局部旋转 identity、缩放 1。这里复用静态 Star prefab（GO598，sorting order 5），不是路径运动的 Slide Star（GO597，order 4、子节点缩放 1.5）。当前场景参数 `slide-parameters.head` 保存 126×126、PPU 100、真实 pivot 与层级；Simple 模式下 sprite 大小为 1.26 场景单位。Break 素材优先于 each，其后为普通星形；EX 独立叠层，色调优先 Break 橙、each 黄、普通星形蓝。

## 编辑约定

新增可选布尔字段 `forceStar`，旧检查点缺省 false。它是 Tap 的外观属性，既有 Tap 切换星形不改变身份、拍点、轨道或修饰符。外圈模板单独保存该开关，新建 Tap 的时间轴、圆形区域和方向键入口共用；Hold 只接收 Break / EX，Touch 继续使用独立烟花属性。中键套用时按实际命中音符家族处理，队列在用户输入时捕获模板值，防止异步提交改用后来的配置。

工具图标和紧凑时间轴使用相同静态原素材组合，Pixi 预览按音符所需资源动态预载；不为单个 `$` 增加运动星形或路径。源 UtagePanel 的开关 / J 快捷键及关闭面板清空规则尚未复刻，当前 Web 以显式复选框提供入口；这仍是 V2 操作差异。强制非 each 的跨解析器语义冲突单独保留，不随本项开放。

## 验收

68 项核心测试、类型检查、素材检查和完整 WASM / 前端构建通过。现有 Chromium 与生产构建上的 `tests/force-star-browser.mjs` 通过 9 组流程，无页面异常：

- 真实 WASM 接受单星形 Tap 及 Break / EX 组合 `1$bx/2$,3$`；未修改时导出原字节。
- 模板属性修改、撤销 / 重做、导出重开，以及工具图标和时间轴像素变化。
- 时间轴、圆形区域和方向键三种放置入口共用星形 Tap 模板；Hold 不继承星形。
- 圆形中键模板、Pixi 实际星形切换，以及撤销后原画面逐字节复现。
- 双 `$$` 与 Hold / Touch 上的 `$` 继续只读并保留原文。

详细报告见 [浏览器结果](results/2026-09-27/force-star.json)，[暂停预览截图](results/2026-09-27/force-star.png) 已保存并人工查看。Touch 烟花、Slide 模型 / 恢复和 P3 基础流程回归通过。

核心测试还确认候选解析若丢失 `forceStar` 会拒绝导出，以及旧检查点省略字段时按 false 恢复。C# 单 token 与全谱结果同时核对 `IsForceStar` 与 `IsFakeRotate`，当时保持 Slide 只读诊断；后续单段编辑开放见 [Slide 编辑验收](slide-edit-validation.md)；没有修改上游 vendor 或检查点 schema。目标原生运行对照仍未取得，本项不能作为 V2、V3 或整份 ROADMAP 完成依据。
