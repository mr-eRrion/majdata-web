# 来源与许可

本项目以 GPL-3.0-or-later 提供，完整条款见 [LICENSE](LICENSE)。发布构建时应同时提供本仓库对应版本的可修改源码、上游材料、补丁与构建说明。

| 材料 | 固定来源 | 许可及本地材料 |
| --- | --- | --- |
| MajSimai C# 解析器 | [TeamMajdata/MajSimai](https://github.com/TeamMajdata/MajSimai/tree/fdb2a3e39d8997a0abbf8b4679062d854473cc77)，`fdb2a3e39d8997a0abbf8b4679062d854473cc77` | 上游声明 GPL-3.0-or-later；[COPYING](vendor/MajSimai/COPYING)、[版本与补丁说明](vendor/MajSimai/UPSTREAM.md)、[补丁](vendor/MajSimai/LOCAL_PATCH.diff) |
| MajdataPlay 代表几何与语义源码 | [TeamMajdata/MajdataPlay](https://github.com/TeamMajdata/MajdataPlay/tree/850f3e3eac354d328b1e9e8bde50b64c4946faf5)，`850f3e3eac354d328b1e9e8bde50b64c4946faf5` | [GPL v3](vendor/MajdataPlay-geometry/LICENSE)、[源输入说明](vendor/MajdataPlay-geometry/README.md)；未复制游戏音乐、皮肤、纹理或可执行播放器 |
| 镜像映射对照 | [MajdataEdit Mirror.cs](https://github.com/LingFeng-bbben/MajdataEdit/blob/963812b6ec3e023360993f50fbbd7f51e9de9180/Mirror.cs)，`963812b6ec3e023360993f50fbbd7f51e9de9180` | GPL v3；用于位置映射核对，记录见 [P3 语义说明](docs/p3-syntax-notes.md) |
| React / React DOM、PixiJS、Vite、TypeScript 等依赖 | 精确版本见 [package.json](package.json) 和 [pnpm-lock.yaml](pnpm-lock.yaml) | 各包的许可证随包保留；不将 GPL 声明替换到第三方原始文件中 |
| .NET 浏览器运行时与构建工具 | SDK 版本见 [global.json](global.json)，安装与构建脚本见 `tools/dotnet/` | 分发 runtime 的许可通知随 SDK/WASM 发布材料保留 |
| Visual Maimai 经典皮肤 PNG | 用户提供的 `Visual Maimai/Skins/经典/`，原样复制的 61 张图片 | 文件哈希、尺寸和来源路径见 [素材清单](apps/web/public/assets/visual-maimai/manifest.json)。这是用户提供的本地复刻素材，未据此授予第三方素材 GPL 许可；不包含整个安装包。 |
| Visual Maimai 场景参数、Hold 端点与烟花标记 | 同一安装包的 `level0`、`sharedassets0.assets` / `.resS`；定向提取三张端点纹理、一张烟花原纹理及渲染、路径、布局参数 | [提取记录](docs/visual-scene.md)、[场景 fixture](fixtures/visual-maimai/rendering.json) 与 [内嵌素材清单](apps/web/public/assets/visual-maimai/embedded/manifest.json) 保留源对象 ID、输入哈希及 PNG 哈希；同样不授予原素材新的 GPL 许可。 |
| TouchHold 进度环裁切规则 | 同一资源的 Shader 215 `Custom/SprFill`，定向提取 D3D11 字节码 | [恢复记录](docs/touchhold-shader.md) 保留对象 / 程序哈希、MIT 反汇编工具的固定提交和实现边界。工具、字节码及完整安装包不进入站点。 |

`fixtures/charts/` 中的谱面和 `fixtures/audio/` 的参考音轨生成器为本项目自制验证材料。应用使用系统字体，网格与辅助选择图形由程序绘制，音符皮肤按上表记录来源，试听音效由 Web Audio 合成。用户导入的媒体不属于项目分发内容，不上传也不自动进入版本控制。

几何 JSON 保留源文件哈希、固定提交、提取方式和证据状态。离线提取成功不代表对应 Slide 已取得目标播放器行为验证。
