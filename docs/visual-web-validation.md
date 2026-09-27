# 原素材与纵向编辑验收

2026-09-27，macOS arm64 / Apple M4，已有 Chromium 153.0.8010.12，生产构建、1920×1080、DPR 1。目标 Windows 程序未运行，以下只证明 Web 行为和静态规则实现，不代表目标画面校准。

## 功能与显示

- `pnpm test`：本轮素材与纵向时间轴阶段 37 项通过，包含同拍 each 推导、各状态切片边界、绝对时间 seek 状态和基础 Slide 路径计算；类型检查通过。后续 Slide 模型的验收另记。
- `tests/editor-browser.mjs`、`p3-browser.mjs`、`failure-browser.mjs`：编辑、复制、撤销、导出重开、Touch 变换、BPM、元数据、只读保护、恢复与故障处理通过。
- `tests/vertical-browser.mjs`：轨道 8→1、反向点击 Hold 两端仍保留第一次轨道、跨 BPM 保存实际秒数、C TouchHold、右键取消、撤销重做和重开通过；Hold 拖头保留显式 BPM 时长、Touch 拖动不改区域编号，以及滚轮/Shift 滚轮、逗号/Backspace、Ctrl+O/P 均通过。
- `tests/skin-browser.mjs`：65 张 PNG（含后续新增原始烟花标记）均能解码且尺寸吻合；必需图片请求失败时显示路径错误，不用几何图形替代。
- 人工查看 1080p 浏览器截图，修正了时间轴轨道标题被工具条遮挡的问题。当前面板比例参考场景序列化值，保留 Web 表单样式和部分输入习惯。

同日后续已补上独立 Touch 轨与 33 传感器面板：先在轨道释放鼠标选时间，再点击传感器创建；TouchHold 再点击终点。同拍 Touch/TouchHold 聚合显示、选中与拖动，保持每个音符的区域和编号。重新构建后，`p3-browser`、`vertical-browser`（含五传感器同拍整组拖动）、基础编辑和故障恢复均通过；目检 1080p 结果无轨道标题遮挡。

用户本地 `Pure Ruby (Short Version)` 也通过只读导入、原 4,192 字节完全一致导出，以及 157.3 秒 MP3 解码/波形完成检查。解析出 1,021 个已识别音符，其中 44 个基础 Slide；其余不支持 Slide 通过诊断保留原文，不能据此声称 1,033 项原谱已完整预览。素材不上传、不加入发布归档。[结果](results/2026-09-27/real-example.json)。

基础 PNG 原样复制；Hold 端点来自包内原纹理。Canvas 与 Pixi 共用切片/锚点/旋转组合，选择辅助独立绘制。后续已按 [Shader 字节码](touchhold-shader.md) 恢复的方向接入 Touch Hold 动态环，目标像素对照仍待完成。Slide 全链路尚未开放。

## 性能

`tests/performance-browser.mjs` 使用 300 秒合成 Tap/Hold 谱面，不含 Slide、Touch 或实际音频；预览皮肤就绪后采样。10 次热导入（剔除最初两次）、5 秒帧采样、10 次定位和 10 次真实指针输入。毫秒数据如下。

| 指标 P95 | 1,000 音符（常规） | 10,000 音符（压力观察） | 常规预算 |
| --- | ---: | ---: | ---: |
| 帧间隔 | 16.8 | 33.3 | ≤20 |
| 输入到两帧反馈 | 31.9 | 33.5 | ≤50 |
| 热导入到 Worker 快照 | 82.3 | 152.6 | ≤200 |
| 定位到两帧反馈 | 47.6 | 50.2 | ≤100 |

常规负载满足以上预算；压力负载帧间隔超过常规目标，作为观察记录，不将 10k 称为流畅保证。热导入不含文件读取和 React 绘制；输入反馈测临时放置显示，不含 Worker 提交；帧采样不等于端到端物理显示延迟。主页面 JS heap 分别约 15.4/50.3 MiB，不是整页总内存，不能替代媒体和纹理峰值验收。

原始数据见 [1k](results/2026-09-27/maijdata-performance-1000-results.json)、[10k](results/2026-09-27/maijdata-performance-10000-results.json)、[纵向操作](results/2026-09-27/maijdata-vertical-results.json)、[基础编辑](results/2026-09-27/maijdata-editor-results.json)。

原素材 Slide 预览接入后，另以同一脚本 `--mixed-slide` 测生产版本：300 秒 / 1,000 音符，含 100 段 Slide（33 段 Wi-Fi）、10 个 Hold，无歌曲。10 次热导入 P95 51.6 ms，12 秒帧间隔 P95 16.7 ms，10 次定位 P95 33.4 ms，页面错误为零。含 Slide 的难度保持只读，因此没有测输入编辑延迟。12 秒采样实际经过直线、弧线与 Wi-Fi，并包含时间轴指引和合成提示音；该稀疏负载仅验证新增绘制路径能正常运行，不代表高密度 Slide 或带音频总内存验收；可见条带峰值尚未采样。[原始结果](results/2026-09-27/performance-1000-slide.json)。

## 未完成对照

固定 Windows 版本的截图/操作录像、Touch Hold 扇形填充、原生菜单与快捷键、完整 Slide/Wi-Fi 编辑和固定 MajdataPlay 播放行为仍缺证据。采集方式见 [目标对照清单](target-capture.md)。V0/V2/V3/V4 的这些出口继续保持未完成。
