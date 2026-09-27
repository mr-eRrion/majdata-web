# 时间轴告警图标验收

日期：2026-09-27。本文验收告警标记的原图标来源、时间轴绘制与悬浮交互；检查器算法本身的来源和边界见 [检查器来源](chart-warning-source.md)，算法与结果列表的 Web 验收见 [检查器验收](visual-checks-validation.md)。

## 原图标与显示规格

目标包 `sharedassets0.assets` 的 SHA-256 为 `83f743d5f7c522ee436941ddbd647dbdf0dc80ea61354c410934d55cbf7a8104`。已提取的 Unity 资源记录见 [原图标来源清单](../fixtures/visual-maimai/check-icons/source.json)：Warning 使用 Sprite 375 / Texture2D 170，Bad 使用 Sprite 303 / Texture2D 76；两个 Sprite 都完整引用 84×84 纹理，PNG 原样导出，解码像素与 Sprite 图像一致。打包清单继续保留源对象 ID、尺寸和 SHA-256。`node tools/visual-assets/prepare-check-icons.mjs --check-packaged` 验证通过，确认 2 张图标共 5,770 字节。

源 prefab 的 `Check Result` 根 RectTransform 为 42×42，序列化的 `CheckResultKeyframe` 引用 Warning Sprite 375 与 Bad Sprite 303。定向反编译的 `EditorScene.Check.CheckResultTrack.UpdateCheckResult` 默认选择 Warning；同拍结果中出现任一 Bad 时切到 Bad。它以 BPM 转换后的秒数和当前进度计算纵坐标，斜率是 `150 × beatScale`；`SettingsData` 字段默认 `beatScale = 2`，即 300 屏幕单位/秒。程序集身份与静态证据边界见 [检查器来源记录](chart-warning-source.md)：这些资源和源码证据不能替代目标程序的运行画面对照。

Web 的 [告警轨绘制器](../apps/web/src/timeline/warning-track.ts) 使用同一 42 CSS 像素图标尺寸与中心命中框，中心位于时间轴网格左侧 20 像素；纵坐标由告警秒数、视图秒数、缩放比例和播放头位置换算。绘制只保留图标中心仍在时间网格内的标记。warning 与 bad 分别从 `check.warning` / `check.bad` 资源映射加载。它与目标源码采用相同的默认缩放斜率；工作区实际布局的绝对位置仍属于 Web 布局，不据此声称与目标窗口逐像素一致。

## 验证结果

[标记分组逻辑](../apps/web/src/checks/warning-markers.ts) 将等价有理拍点合并，保留同拍 code 的首次出现顺序，并在任一 code 为 Bad 时提升整组图标严重级别；秒数使用该难度 BPM 表换算。定向 Vitest 通过 3 项：等价拍合并与严重级别、跨 BPM 秒数映射、检查不可用时返回空结果。

使用仓库已安装的 Playwright Chromium 153.0.8010.12，视口 1920×1080、DPR 1，在本地生产预览 `http://127.0.0.1:4174/` 运行 [告警轨浏览器流程](../tests/warning-track-browser.mjs)。8 项流程全部通过，页面错误为 0：

- 同拍 code 按源顺序展示，Bad 优先级对应红色图标；不同拍 warning 对应黄色图标。初始样例的三个 marker 分别位于 beat `0/1`、`1/1`、`2/1`，画布中心 x 均为 60 px，y 为 657、507、357 px。marker 时间相隔 0.5 秒，与 300 px/s 的缩放一致。
- Canvas 像素采样中，黄色 marker 区域检测到 121 个黄像素；红色 Bad marker 检测到 194 个红像素。配合原资源 SHA-256 与对象引用校验，确认生产绘制使用两张不同的原图标。
- 悬浮 Bad marker 会显示同拍全部 5 条原因；对 marker 单击、双击或右键均不编辑、不移动播放头，也不弹出编辑菜单。seek 到 0.5 秒后对应 marker 与播放头对齐，缩放后 marker 仍保持在告警轨中心。
- 切换至无检查结果的难度会清空时间轨 marker，切回后恢复；删除后 marker 消失，撤销后恢复；载入只读谱面时 marker 清空。

浏览器脚本原先的诊断读取在设置 `data-measure-warnings` 后没有触发 Canvas 重绘，且把当前难度 `<select>` 当成按钮点击。已在 [浏览器流程](../tests/warning-track-browser.mjs) 中让鼠标移动触发一次绘制，并改用选择框切换难度。调整只修正验收驱动方式；没有修改 Timeline/App 集成或告警轨产品逻辑。

主代理已查看悬浮提示截图，完整原因可读，未遮挡被悬浮的标记。归档见 [浏览器结果](results/2026-09-27/roadmap-followup/warning-track.json) 和 [工作区截图](results/2026-09-27/roadmap-followup/warning-track-hover.png)。

## 尚未验证

本轮未在目标程序运行环境对照实际窗口，因此不宣称目标程序与 Web 的最终像素位置、过滤采样或不同 marker 距离小于图标宽度时的重叠层级一致。Web 按 beat 升序绘制，重叠命中时优先最后绘制的 marker；当前浏览器样例的 marker 间距为 0.5 秒，没有覆盖近距离重叠样例。上述差异需要目标运行画面对照后再判断是否调整。
