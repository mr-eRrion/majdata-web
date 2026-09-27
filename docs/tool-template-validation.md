# 中键套用工具属性

## 静态来源

目标程序集 `EditMono.OnPointerClick` 将中键交给具体音符的 `OnSelect`。`NoteEdit.OnSelect` 把当前工具属性写入命中的既有音符：外圈 Break、EX、强制非 each，以及适用的星形头转换字段；不转换音符家族，不改拍点、位置或时长。单个 `$` Tap 星形另有独立的 `forceStar` 实现与边界，见 [星形 Tap 验收](force-star-validation.md)。`TouchPlacing.OnSelect` 写入强制非 each 与 Touch 烟花。这里是把工具配置应用到音符，不是从音符采样工具。

圆形 `NotePlaceArea.UpdateSet` 只检查中键按下沿，每次按下最多应用一次，按住跨区不重复。优先匹配当前吸附拍点的 Tap，再匹配覆盖此时刻的 Hold；Touch 类似。时间轨入口通过 `EditMono` 禁止在长音符待完成时应用；圆形入口没有此门控。两入口不能机械共用这项限制。

## 当前实现及未完成范围

Web 工具区保存独立的外圈 Break / EX 属性，普通时间轨、圆形区与方向键放置使用同一模板；Tap / Hold 工具图标同步显示对应原素材。单个 `$` 静态星形 Tap、Touch 烟花字段分别用于新建、单音符属性和中键套用。时间轴中键点击命中音符后套用模板，移动达到 5 px 则拖动播放头，松开吸附到拍线，见 [播放头拖动验收](timeline-scrub-validation.md)。圆形区中键在按下时处理一个区域。修改进入同一输入队列和既有撤销事务；未命中或属性无变化时不新增历史，不创建音符。无变化不记历史是 Web 约定，源码修改回调没有显式相等检查。

Slide 中键头部转换已贯通，套用起点 Break/EX 与 star/tap/none，保持路径 Break 和时长；圆形模板、删除与撤销见 [Slide 编辑验收](slide-edit-validation.md)。强制非 each 尚未贯通；双 `$$` 与 Hold / Touch 上的 `$` 继续只读。原 Touch 编辑对象的命中层和同拍多传感器选择布局也未完全复刻。中键拖动播放时间及松开吸附已按源码接入并通过 Web 检查；上述完整模板与原生对照缺口仍使 V2 保持未完成。

## 外圈浏览器证据

`tests/tool-template-browser.mjs` 使用真实 WASM 和生产构建，覆盖时间轨中键、模板无变化、Hold 时长保留、撤销重做 / 导出重开、圆形仅按下一次、Touch 不受外圈模板影响、中键拖动不套用、三种放置入口共用模板、待定 Hold 的入口门控和只读保护。现有 Chromium 运行无页面异常，截图已人工查看；最终报告见 [结果](results/2026-09-27/tool-template.json)。

## Touch 烟花数据与编辑

Touch / TouchHold 的 `f` 已从 MajSimai `IsHanabi` 贯通到 C# DTO、TS `firework`、规范化、撤销 / 恢复、候选语义比较和生成器。只接受 Touch 家族，`f` 位于 Hold 标记之前；重复 `f`、外圈 `f`、Touch EX 及错误次序保留诊断和原文。旧检查点没有该可选字段时按 false 解释，继续使用 schema 3；没有改上游 vendor 解析器。

独立的 Touch 烟花工具用于新建与中键套用，现有单音符属性也可编辑。圆形按传感器精确定位，时间轨只有单个 Touch 的命中可中键应用；同拍聚合组不任意选择隐藏成员，可通过圆形区域或组内单选后的属性编辑。烟花是独立字段，不套用外圈 Break / EX。已有 Touch Break 仍是 Web / MajSimai 能力，目标 Visual Maimai 的 Touch 导出类不包含该字段，不能据此声称目标完全兼容。

`tests/firework-browser.mjs` 在生产构建和真实 WASM 上通过 8 组流程：`A1f`、`Cf`、`B2fh[4:2]` 导入、未改原字节导出、分别修改 Touch 与 TouchHold 烟花、撤销重做 / 导出重开、Touch Break 与烟花组合规范生成为 `D3fb` 后回读、独立模板放置、单 Touch 中键、属性修改和非法语法只读保留。报告见 [烟花结果](results/2026-09-27/firework.json)，[属性截图](results/2026-09-27/firework.png) 已人工查看。时间轴静态烟花标记已接入并通过属性开关的像素变化检查；命中烟花动画仍未实现。当前总计 68 项核心测试通过。

## 强制非 each 的跨工具冲突

后续静态核对发现，这一字段不能只加开关和分隔符便开放：Visual Maimai 的 `ChartImporter` 先按 `/` 分段，再按反引号分段，把后续项的 `isNoMulti` 设为 true；`InitManager` 只让同拍、且都未设置该标志的音符互相参与 `IsMulti` 推导。当前固定 MajSimai 的 `SimaiParser.cs`（约 868–896 行）则将同一逗号格内的反引号段当作 fake-each，逐段增加 `1.875 / BPM` 秒。以 BPM 120 为例，每段增加 0.015625 秒。

因此把 Visual 的同拍标志直接输出为反引号，会在当前播放器内核中引入时差；把该时差反向当作原始拍点也无法保留 Visual 语义。当前继续严格诊断 / 只读保留这类原文，不添加会暗改时间的“强制非 each”编辑开关。后续需固定目标播放器运行证据并确定明确的兼容边界；该项仍属于完整模板的未完成部分，不能以派生的 `isEach` 字段替代原始标志。

## 星形 Tap 的实现依据

`TapToStar` 来自 `EditorScene.Utage.UtagePanel` 的运行时开关，快捷键 J；关闭该面板会清空 `TapToStar` / `StarToTap` / `HindStarHead`，未见持久化。单个 `$` 表示 Tap 数据的 `toStar`，目标 `TapControl` 为它取 `NoteType.Slide` 对应的 `TapMono`，使用 star 系列原素材及 Break / EX 组合，根旋转为 identity；它不使用路径运动的 `StarMono`。固定 MajSimai 把单个 `$` 设为 `IsForceStar`，双 `$$` 还设 `IsFakeRotate`；目标 Visual 导出只保存一个 `$`。Web 现已开放可保留语义的单个 `$` Tap，双 `$$` 继续只读保留。

## 原始静态烟花标记

从 Unity 容器的 Sprite386 追踪到 Texture185，直接导出 1080×1080 原始纹理，保留透明边；输出 132,194 字节，SHA-256 为 `b97333cb22c82b130760e0c9c29b872ba263438298bc0b1ca985e2a551c70c4a`。Sprite 裁片为 1074×1074，在约 (3,3) 像素偏移处与原纹理的 alpha 及非透明 RGB 一致，不比较全透明像素的隐藏 RGB。提取器重跑后 JSON 和 PNG 逐字节一致。

参数分别保留 TouchEdit 时间轴、TouchPlacing 传感器和 Pointer 引用，避免混用：时间轴标记 40×40，对应 Touch glyph 28×28、TouchHold 35×35；传感器标记 110×110；Pointer 标记 40×40、alpha 0.470588。时间轴标记的 sibling 顺序在音符 glyph 之前，Web 也先画标记再画音符。当前紧凑时间轴会统一缩放 glyph；混合聚合组只画一次标记，并优先按普通 Touch 比例缩放，尚非原 TouchEdit 多层布局的完整复刻。

Canvas 辅助函数读取生成参数，供既有音符、Touch 悬停和待定 TouchHold 使用；Pointer 透明度独立保留。此图只代表编辑标记，不用于冒充 HitEffectManager 的运行中烟花动画。素材清单现为 65 张，核心预载 21 张；全图解码、缺图提示、68 项核心测试、类型检查及生产构建通过。

## 星形几何与色彩

单个 `$` 的几何已定位到静态 `Star` TapMono（GO598、sorting order 5），生成参数为 `slide-parameters.head`；实际路径运动的 `Slide Star`（GO597、order 4、子节点缩放 1.5）属于另一模型。静态 sprite 为 126×126、PPU 100、pivot 约 [0.486226, 0.498852]，几何宽高为 1.26 场景单位；Simple 模式下不使用 Renderer.size=1.22 代替实际 sprite 尺寸。根 rotation identity 是相对于 lane track，仍需要父轨道旋转。工具图标启用星形时额外加载 star 系列资源。

共享 `composePrefab` 的普通星形 EX 色按 TapMono.StarColor 设为 [0.22, 0.71, 0.92]；Break 橙和 each 黄继续优先，普通 Tap 仍为粉色，这也同步修正既有 Slide 星形头。颜色优先级有回归测试；总计 68 项核心测试通过。静态 Tap 的模型、工具、原素材与 9 组浏览器证据见 [星形 Tap 验收](force-star-validation.md)。
