# 多难度混合编辑验收

2026-09-27 使用现有 Chromium 153.0.8010.12，在 Apple M4、1920×1080、DPR 1 的本地生产页面完成 5 组流程，页面异常 0。主入口 `index-TYMxAMaV.js`，Worker `chart.worker-aspj87W7.js`。此项验证编辑与保存语义，不替代原生画面、歌曲同步或播放器兼容对照。

自制夹具 [mixed-edit-flow.maidata.txt](../fixtures/charts/mixed-edit-flow.maidata.txt) 包含两个可编辑难度。难度 1 同时包含 Tap/单 `$` 星形、Hold、Touch/Touch Hold 烟花、共享头 Slide、旧式基本连续路线、Wi-Fi、Break/EX 与 120→240 BPM 事件；难度 2 包含独立音符和 150→180 BPM 事件，作为未修改对照。

[浏览器流程](../tests/mixed-edit-flow-browser.mjs) 通过真实工具执行共享头镜像、撤销/重做、连接路线旋转，以及 BPM 240→180 修改和撤销/重做。每次检查难度 2 的完整快照保持不变；导出还检查它的原始 `&inote_2` 行原样保留。IndexedDB 刷新恢复后、候选重新导入后均逐难度比较完整规范化快照，并核对再次导出的字节一致性。

规范化仅删除不稳定的音符 ID、顺序号、源范围与诊断源范围，结构、拍点和时长表达保持严格比较；派生秒数 `startSeconds`、`moveStartSeconds`、`endSeconds` 使用绝对 `1e-8` 秒容差。显示快照没有内核内部的 `modified` 字段，不人为补入该字段。另用独立手算核查：第 4 拍起点由 1.75 秒变为 11/6 秒；修改后两拍 Hold 长 2/3 秒；第 2 拍的连接路线从 1 秒开始，等待 0.5 秒、总移动 2 秒，仍按起点 BPM 解释其时长。

报告见 [mixed-edit-flow.json](results/2026-09-27/mixed-edit-flow.json)。复现需先运行本地生产预览，并通过 `BROWSER_EXECUTABLE` 指定已有 Chromium：

```sh
node tests/mixed-edit-flow-browser.mjs http://127.0.0.1:4173/
```

生产绘制入口另经只读核查：`App → CircularPreview → PixiNoteLayer/PixiSlideLayer`、`Timeline → drawNoteGlyph` 和 `ToolIcon → Canvas` 均使用原素材组合；缺图上报加载错误，不用几何音符代替。没有发现可删除的旧生产占位入口。时间轴的 Hold 时长段、Slide 时间指引以及网格/波形/选择框属于编辑辅助，保留；Slide 时间指引尚不是目标原版编辑路径 Sprite，外观对照仍待完成。独立渲染 harness 保留作测试。
