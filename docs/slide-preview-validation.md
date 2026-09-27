# 基础 Slide 预览实现与校准边界

本页记录 V3.2 的 Web 实现和当前证据边界。单段 `-`、`<`、`>` 与 `w` 已接入原 PNG 皮肤的 Pixi 预览；含 Slide 的难度仍只读，已接入头部、移动起点和路径 Break 尾部的合成提示音。尚未与目标 Visual Maimai 或 MajdataPlay 的原生画面、播放器行为做对照。模型与真实 WASM 往返见 [模型验收](slide-model-validation.md)，路径与状态公式见 [R2](visual-reverse-r2.md)。

## 数据与绘制

`slide-parameters.json` 由包内场景 fixture 确定性生成，记录来源哈希、组件和资源 ID。头部 prefab、独立运动 StarMono、三条 LineRenderer 及 Wi-Fi 的 11 个箭头分别投影，生产页面不加载整个逆向 fixture。生成和校验纳入 `prepare:skin` / `check:skin`。

路径点保持目标的端点到起点顺序，星星与已消退条带按原 `SetSlide` 循环计算。保留原循环在最后线段暂不插值的端点行为；不能把理想化匀速曲线当成逐行复刻。每个 `splitIndexes` 分段单独调整末端，使长度四舍六入五成双到 0.5 单位倍数；不修改共享原始点列。

实读 LineRenderer 为局部坐标、TransformZ 对齐、常量宽度约 0.9、Tile 模式、textureScale=(2,1)、无端帽和额外圆角顶点。材质 MainTex 的缩放为 (1,1)、偏移为零。Web 使用原箭头 PNG、按世界长度重复的 UV 和平面斜接网格；每半个场景单位重复一次。世界长度平铺的含义有 [Unity 官方 API](https://docs.unity3d.com/2022.3/Documentation/ScriptReference/LineTextureMode.html) 支持，但网格连接、采样、抗锯齿和 Standard 材质最终亮度仍需目标像素校准，不能称为原生 LineRenderer 的逐顶点复制。

星星使用实际 Sprite pivot、126×126 纹理及独立模型的 1.5 倍子节点缩放；Wi-Fi 使用 11 个编号图的真实空间变换。等待时星星渐显和放大，移动时按源路径采样，Wi-Fi 按进度隐藏前若干编号；结束回收，seek 重新从绝对时间计算。零移动时长可正常结束，不因除零令预览失效。

头部 Break/EX 和路径 Break 独立：前缀修饰符控制头部，后缀 `b` 控制条带、Wi-Fi 和运动星。同拍 Tap+一个 Slide 可使头部 each，但不会使路径 each；多个同拍 Slide（包含无头）才赋路径 `isSlideEach`。派生显示字段不写回谱面。共享头及其他尚未建模语法仍只读保留，不扩展此结论。

场景 SortingGroup 的顺序已接入：Wi-Fi 箭头 2、条带 3、运动星 4、Slide 头与 Tap/Hold 5、Touch 6、TouchHold 7。Slide 头与普通音符合并排序，同组按源 hit 深度绘制；路径按移动起点深度绘制。条带自身的 renderer order 1/2/3 仅作用于条带组内，不能越过运动星和头部。排序证据见 R2；原生透明混合及重叠画面仍待对照。

## 浏览器验收

2026-09-27，`tests/slide-preview-browser.mjs` 使用现有 Chromium，在 Vite 开发页直接导入 `PixiSlideLayer` 和 `preloadSlideTextures`，以原 PNG 纹理分别渲染直线 `1-5`、弧线 `2<6` 和 Wi-Fi `1w5`。每条手工 `DisplayNote` 都检查 hit 前 0.1 秒、等待 0.25 秒、移动 1.0 秒、结束 1.5 秒和回跳至 0.25 秒，共保存 15 张阶段图、空白基线图及重建图，共 17 张。

三种音符的 hit 前、等待和移动画面均非空；等待与移动画面不同；结束帧为空；回跳画面与首次等待帧 PNG 字节一致。Wi-Fi 中点由实际 Pixi 节点统计为 6 个箭头和 3 个星形。销毁图层后用同一纹理缓存重建，画面仍与 Wi-Fi 等待帧逐字节一致；页面错误为 0。截图和 JSON 结果保存至 `/tmp/maijdata-slide-preview-*.png` 与 `/tmp/maijdata-slide-preview-results.json`。没有目标参考图，因此这些检查不构成原生像素一致性证明。

`tests/mixed-preview-browser.mjs` 在生产页面经真实 Worker 导入 [12 音符混合样例](../fixtures/charts/mixed-preview.maidata.txt)，包含普通长音符、Touch、TouchHold、直线、圆弧、Wi-Fi、头部 EX/Break、路径 Break 和 BPM 变化。`&first=±0.25` 下相同谱面时刻的预览 PNG 完全一致，回拖到 2.75 秒也逐字节复现；0.5/1/2 倍速的时钟推进、暂停冻结和 2–3 秒循环均通过。只读保护保留，诊断仅为 `slide-validation-pending`，无页面异常。这是无歌曲、合成提示音下的 Web 检查，不能代替物理音频同步或原生画面校准。[结果](results/2026-09-27/mixed-preview.json)，[2.75 秒画面](results/2026-09-27/mixed-preview-2.75.png)。

同一生产检查还验证了 Tab 临时试听：从暂停的 2.25 秒按住 Tab 后时钟推进，松键立即暂停并精确恢复至 2.25 秒。窗口失焦使用同一还原逻辑；表单输入保留原生 Tab 行为。Slide 提示音的独立浏览器调度证据见 [音效记录](visual-slide-audio.md)。

## 资源与未完成项

时间轴按 `SlideTrack.RenderSlide` 的范围显示移动开始到结束，头部按 hit 定位，等待段从 hit 延伸到移动起点。`SlideTrack` 是覆盖编号轨道的图层；Web 不新增列，也不改变 Touch 轨。头部复用原 PNG 组合，等待虚线和端点连线仅是 Web 时间范围辅助，不代表原生 SlideEdit 路径贴图。生产 `slide-browser` 已核对头部所在区域的像素差，单击 seek 后图标移动到新坐标，原位置只剩指引线；随后原文保存、编辑其他难度、导出重开和恢复均通过。[完整混合工作区](results/2026-09-27/mixed-workspace.png)。

Pixi 精灵与条带共用图片/纹理缓存。音符离开窗口时销毁其几何与实例，保留公共纹理；页面卸载销毁本页图层。Slide 的头、路径和运动星各有独立时间窗。音效事件按绝对谱面时刻调度，暂停定位不补发历史事件；合成音色沿用现有约定，不宣称原包声音复刻。Slide 时间轴编辑入口仍未开放，界面明确提示只读与待校准。

专项浏览器检查覆盖的是独立的 Pixi 预览层和三条代表路径。目标运行帧的原生像素对照、同组音符遮挡、混合谱面全部动态状态及播放器兼容仍待验证；这些缺口不影响当前只读预览状态，但不支持宣称视觉或播放器兼容已经完成。

后续静态审查发现普通星形头的EX层误用了Tap粉色，已按目标TapMono.StarColor修正为蓝色[0.22,0.71,0.92]；Break橙与each黄仍优先，Tap形头保持粉色。颜色优先级回归通过，核心测试总数64。该修正来自反编译源证据，仍不代替原生像素对照。
