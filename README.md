# majdata-web

面向桌面浏览器的 maimai 可视化谱面编辑器。打开本地 `maidata.txt` 和歌曲，在时间轴中编辑音符，通过圆形预览试听，再导出谱面。

项目使用 React、TypeScript 和 PixiJS 构建界面，并通过 .NET WebAssembly 复用 MajSimai C# 解析器。谱面与音频在浏览器本地处理，无需账号或后端服务。

> 项目仍在开发中，当前仅支持部分 Simai 语法。遇到未支持语法时，对应难度会保持只读。完整范围见[支持矩阵](docs/support-matrix.md)。

## 功能

- **可视化编辑**：Tap、Hold、Touch、Touch Hold，支持放置、移动、复制粘贴、批量属性修改、镜像旋转和撤销重做。
- **Slide 编辑与预览**：支持单段 `-<>vszw`、基础路径的共享头组合及单括号连续路线，可通过路径候选或手绘放置。
- **谱面管理**：切换多难度，修改 BPM、偏移与谱面信息，在时间轴中选择和移动 BPM 事件。
- **试听与检查**：歌曲波形、播放定位、变速试听、圆形音符预览，以及碰撞告警和定位。
- **导出与恢复**：导出前重新解析并核对候选谱面；在浏览器中保存最近一份文档检查点。

## 快速开始

需要 **Node.js 26.9.0** 和 **pnpm 12.4.1**。首次安装需要联网；初始化脚本会将 .NET SDK 和 WASM 工具链安装到项目的 `.tools/` 目录。

```sh
git clone https://github.com/mr-eRrion/majdata-web.git
cd majdata-web
pnpm install --frozen-lockfile
pnpm setup:wasm
pnpm build:wasm
pnpm dev
```

打开终端显示的地址，点击“打开示例”体验内置谱面，或选择自己的 `maidata.txt` 与歌曲。普通构建所需的皮肤资源和场景参数已包含在源码中，无需安装 Unity 或提供完整的 Visual Maimai 安装包。

## 基本使用

1. 打开谱面和歌曲，选择要编辑的难度。
2. 选择音符工具，在时间轴或圆形区域放置音符。Hold 需要依次确定起点和终点；Touch 先选时间，再选传感器位置。
3. 播放歌曲检查预览，使用属性面板、右键菜单和告警定位调整谱面。
4. 点击“导出 maidata.txt”，下载通过校验的当前版本。导出不会覆盖本地原文件。

时间轴向上表示未来，普通轨道从左至右为 8 → 1，右侧为独立 Touch 轨。右键可取消未完成的长音符或粘贴操作。

| 操作 | 快捷方式 |
| --- | --- |
| 移动一个吸附格 | 滚轮 |
| 移动一小节 | Shift + 滚轮 |
| 缩放时间轴 | Ctrl / ⌘ + 滚轮 |
| 暂停时前进 / 后退一个格 | 逗号 / Backspace |
| 删除选中音符 | Delete |
| 粘贴并预览落点 | Ctrl / ⌘ + V，左键确认、右键取消 |
| 暂停时临时试听 | 在输入框外按住 Tab，松开后返回原位置 |

未修改的谱面按原始字节导出；编辑后只重建已修改且受支持的难度，其他难度和未知字段保留原文。浏览器检查点不包含歌曲或撤销历史，恢复后需要重新选择歌曲。请定期导出，避免浏览器清理存储后丢失修改。

## 开发与构建

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动开发服务器 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | 运行单元测试 |
| `pnpm test:geometry` | 校验几何提取逻辑 |
| `pnpm check:skin` | 校验素材哈希和场景参数 |
| `pnpm build` | 构建 WASM、前端及发布材料 |
| `pnpm build:web` | 仅构建前端及发布材料，需要已有匹配的 WASM |
| `pnpm check` | 类型检查、单元测试和完整生产构建 |

生产构建输出到 `dist/`，包含静态站点、源码归档和许可文件。可以通过以下命令在本地预览：

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 4173
```

部署时将 `dist/` 托管到静态服务器，并确保正确提供 JavaScript 和 WebAssembly 的 MIME 类型。资源使用相对路径，支持部署到子目录。

浏览器端到端测试需要已有的 Playwright Chromium。保持上述生产预览运行，在另一个终端执行：

```sh
PLAYWRIGHT_BROWSERS_PATH=.tools/playwright pnpm test:browser
```

若浏览器位于其他目录，调整 `PLAYWRIGHT_BROWSERS_PATH`。发布校验与干净构建说明见[发布验证文档](docs/release-validation.md)。

## 项目结构

```text
apps/web/                  编辑器界面、时间轴、预览和 Worker
packages/chart-core/       谱面模型、编辑操作、时间换算与导出
packages/majsimai-browser/  MajSimai 的 .NET WASM 宿主
fixtures/                  测试谱面、音频与几何参考数据
tests/                     浏览器集成与发布检查
tools/                     工具链安装、素材提取和打包脚本
vendor/                    固定版本的上游源码、补丁和许可
docs/                      支持范围、实现说明与验证记录
```

## 已知限制

- 面向桌面浏览器，当前主要在 Chromium 环境验证，其他浏览器的兼容性尚未完成验收。
- 部分 Slide 路径、现代逐段括号语法、双 `$$` 等扩展仍只读保留，详见[支持矩阵](docs/support-matrix.md)。
- 与原生 Visual Maimai 的画面、操作及目标播放器行为对照尚未完成；本地编辑和导出通过校验不代表完整兼容。
- 长音频及反复换歌的内存占用仍需优化，Touch 烟花命中动画尚未实现。

提交问题时，请附上复现步骤、浏览器版本和能复现问题的最小谱面。修改解析或导出逻辑时，请同时验证导出后重新打开的结果。

## 许可与来源

项目代码采用 [GPL-3.0-or-later](LICENSE)。MajSimai、MajdataPlay 相关材料及其他依赖的来源、固定版本和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

Visual Maimai 的皮肤与提取素材保留各自的来源说明，项目代码的 GPL 声明不替代这些素材的原有权利。仓库不包含完整安装包或用户歌曲。
