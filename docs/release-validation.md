# Release 验收

本地 release 检查会把生产 `dist` 挂在 `/maijdata/` 子路径下，在第一次 Tap 编辑提交前验证真实 Worker 和 .NET WebAssembly 能从该路径加载，并检查源码包与许可文件。检查只使用已有的 Playwright Chromium，不下载或安装浏览器。当前交付范围是本地版本，不做公网部署。

Run the production build, then the focused release check:

```sh
pnpm build
RELEASE_REPORT_PATH=/tmp/maijdata-release-results.json \
  node tests/release-browser.mjs dist
```

如果 Playwright 未配置现有浏览器路径，可通过 `BROWSER_EXECUTABLE` 指定本机 Chromium。脚本启动本地 HTTP 服务，只从 `/maijdata/` 暴露所选 release 目录，所有响应均禁缓存并以 gzip 传输。一个共享服务端限速器将响应体限制为 20 Mbps，Worker 与 WASM 请求也经过同一限速器；每个响应在发送首字节前延迟 50 ms。报告记录首次编辑确认前发送的压缩资源字节数及首次编辑耗时。首次编辑资源量的初始目标为 6 MiB，超过 10 MiB 需重新评估。

网络模型有明确边界：50 ms 是服务端在返回响应头前加入的延迟，不是包级 RTT；不模拟 DNS、TLS、丢包或浏览器侧上传延迟。限速由本地服务端对所有请求统一执行，因此不依赖 CDP 对专用 Worker 的网络节流是否继承。它提供可复现的本地启动采样，不能代替托管环境的真实网络追踪。浏览器测试使用新的 Chromium 进程和 context，不载入用户媒体。

浏览器测试开始前，脚本会检查 `source.tar.gz` 是否包含项目源码、构建信息、release 测试和上游许可，并排除 `node_modules`、`bin`、`obj` 与 `dist`。它还检查 release 目录中的项目许可、第三方通知、依赖通知及 .NET 运行时通知。源码包和站点资源必须来自同一版本；下面的干净复建步骤用于验证该流程，不能复用原源码树的构建输出。

## Clean source-archive rebuild

此步骤将源码包解压到全新的 `/tmp` 目录并重建 release。它只链接现有 .NET SDK、CLI home 和 NuGet 缓存；`node_modules`、`obj`、`bin`、WASM 发布产物和 `dist` 都在临时树中重新生成。步骤不运行 `tools/dotnet/setup.sh`，也不下载工具链。

```sh
PROJECT_ROOT="$(pwd)"
CLEAN_ROOT="$(mktemp -d /tmp/maijdata-release.XXXXXX)"
mkdir -p "$CLEAN_ROOT/source/.tools"
tar -xzf "$PROJECT_ROOT/dist/source.tar.gz" -C "$CLEAN_ROOT/source"
ln -s "$PROJECT_ROOT/.tools/dotnet" "$CLEAN_ROOT/source/.tools/dotnet"
ln -s "$PROJECT_ROOT/.tools/dotnet-cli-home" "$CLEAN_ROOT/source/.tools/dotnet-cli-home"
ln -s "$PROJECT_ROOT/.tools/nuget" "$CLEAN_ROOT/source/.tools/nuget"
cd "$CLEAN_ROOT/source"
pnpm install --offline --frozen-lockfile
"$CLEAN_ROOT/source/.tools/dotnet/dotnet" restore \
  packages/majsimai-browser/host/MajSimaiBrowser.csproj \
  --source "$PROJECT_ROOT/.tools/nuget" \
  --packages "$CLEAN_ROOT/source/.tools/nuget"
pnpm build
PLAYWRIGHT_BROWSERS_PATH="$PROJECT_ROOT/.tools/playwright" node tests/release-browser.mjs dist
```

Restore 会在临时树下生成项目 assets，并从现有本地 NuGet 缓存/源读取依赖。如果缓存无法离线满足 restore，应记录缺少的包，不要改为运行可能下载工具链的 setup 脚本。报告应保留 `/tmp` 路径和命令输出；只有重建后的资源与通知通过同一 release 检查，才算复建成功。

## Results

2026-09-27 恢复实施后，已完成含原皮肤的生产构建、子路径冷启动及源码归档干净复建。后续已用包含 Slide 预览、时间轴指引、提示音和 Tab 试听的源码归档重新验证。下面是本地构建链验收；目标程序运行对照、Slide 全链路和内存预算仍未通过，因此不称完整复刻候选。

| Check | Result |
| --- | --- |
| Source archive and release notices | 通过；15 个依赖包通知，源码包含原 PNG、三张端点、渲染/路径 fixture、生成器和静态素材页，不含完整 Visual Maimai 安装目录、node_modules、bin/obj 或旧 dist。 |
| Release test syntax | `node --check tests/release-browser.mjs` 通过。 |
| Clean source-archive build | 通过：`/tmp/maijdata-release.onUJIw/source`。63 个 JS 包从离线缓存安装，WASM 原生链接与前端重新生成，只复用 SDK/NuGet 缓存；没有原安装包也通过全部素材校验。 |
| `/maijdata/` PNG / Worker / WASM load | 通过；必需皮肤加载就绪后真实编辑提交，浏览器无页面错误。 |
| 20 Mbps / 50 ms first-edit sample | 干净重建产物：1,779,909 字节压缩响应（1.70 MiB），首次编辑 1,414.2 ms；低于 6 MiB 初始资源目标。 |
| Browser coverage / deployment | 仅已有 Chromium 153.0.8010.12；未测试其他浏览器，未部署公网。 |

原始报告见 [干净重建结果](results/2026-09-27/clean-release.json)。源码路径可能影响 .NET 输出指纹，因此此步骤验证可重新构建并执行的行为，不声称跨路径逐字节可复现。编译中出现的上游分析告警未阻止真实 WASM 导入和编辑检查。


圆形41区输入后续版本已重新执行素材校验、类型检查、生产构建及源码打包，浏览器检查见[圆形输入验收](place-area-validation.md)。上表干净WASM复建与冷启动数值仍属于先前Slide/Tab阶段，不作为新增圆形交互的重新性能测量。

方向键快速放置版本已通过61项单测和类型检查，完成生产构建，并补充15组交互流程以及圆形/纵向回归。源码归档收录新增实现、测试与 [验收记录](fast-placement-validation.md)；本阶段没有重测上表干净WASM复建和冷启动数值。

中键/Touch烟花阶段已重新构建WASM及前端，63项单测和类型/素材检查通过；中键、烟花、P3和Slide模型浏览器流程通过。发布归档补充对应源码、测试和结果；上表的干净目录重建及冷启动数值仍属于此前阶段，未以此次普通构建替代该测量。

静态烟花标记阶段新增1张直接提取纹理，素材总数65、核心预载21；完整素材校验、63项单测、类型检查与前端生产构建通过，烟花和皮肤浏览器流程重新通过。已同步素材来源、fixture派生哈希、测试与源码归档。此前冷启动和干净构建数据不覆盖这次新增素材；单首音频阶段诊断不替代完整内存验收。

单 `$` 星形Tap阶段已重建WASM（5,901,252字节）与前端，68项测试、类型和素材检查通过；新增9组真实浏览器流程以及烟花、P3、Slide模型/恢复回归通过。源码归档同步当前字段、界面、渲染与验收资料。此前内存诊断的index哈希属于该诊断时构建，不代表当前新增星形Tap版本已重新通过内存或冷启动预算。


## 连续路线与混合验收后的本地构建

该阶段生产入口 `index-TYMxAMaV.js`、Worker `chart.worker-aspj87W7.js`；97项单测、类型/素材检查、生产构建和源码打包通过。重新执行 `/maijdata/` 子路径首次编辑：20Mbps/每响应50ms延迟模型下 1,516.2ms，首次编辑前压缩响应 2,044,574字节（1.95MiB），PNG/Worker/WASM加载与原许可归档通过，页面错误0，见 [当前发布链结果](results/2026-09-27/release-current.json)。这次是在工作目录重新构建的产物，没有冒充上表干净目录WASM复建重测。

源码归档同步混合编辑、连续路线性能夹具、近反向条带bevel修复及音频测量审查。完整本地闭环见 [混合编辑](mixed-edit-validation.md) 与 [连续路线性能](slide-performance-validation.md)。当前能本地运行，但原生画面/操作/播放器对照与512MiB内存预算未通过，不称完整复刻候选。

## 中键播放头阶段：当前源码归档干净复建

最新源码归档解压到 `/tmp/maijdata-final-rebuild.7G1vIk/source`，离线安装63个JS包、下载0个；只复用已有SDK、CLI home和NuGet缓存，在临时目录重新生成node_modules、obj、bin、WASM和dist，没有原Visual安装包。完整构建、65张素材校验、类型检查通过；上游.NET分析告警和Vite包体建议仍存在，不影响本轮运行检查。

重建前端入口 `index-BYynT38X.js`、Worker `chart.worker-aspj87W7.js` 与工作目录一致；具体哈希见 [构建记录](results/2026-09-27/clean-release-current-build.json)。重新执行子路径PNG/Worker/WASM加载、许可和源码清单检查，并完成首次真实编辑。20Mbps/每响应50ms延迟模型下首次编辑1,550.1ms，压缩响应2,044,814字节（1.95MiB），页面错误0，见 [重建运行结果](results/2026-09-27/clean-release-current.json)。本次覆盖当前解析宿主、连续路线和中键播放头实现；不是对早期重建记录的沿用。

验收记录入库后只重新打包文档和结果；产品源码与上述干净重建相同。原生运行对照及内存验收继续保持未完成。

## v/s/z扩展后的发布链

新增v/s/z后重新构建真实WASM与前端：主入口 `index-Bu6yDX1X.js`、Worker `chart.worker-DnxaBYKk.js`；104项单测、29条路径和65张素材校验通过，功能闭环见 [v/s/z验收](slide-vsz-validation.md)。子路径PNG/Worker/WASM加载、首次真实编辑、许可与源码归档检查再次通过：1,867.0ms、2,049,243字节压缩响应（1.95MiB）、页面错误0，见 [发布结果](results/2026-09-27/release-vsz.json)。

本次是工作目录完整构建；上一节的全新临时目录离线重建明确属于中键阶段，未把它标作新增解析路径的干净复建测量。文档和原始结果收录后再次打包并逐文件比较归档与工作目录；产品运行代码未再改动。原生对照、其余路径和总内存预算仍未通过。

归档复核发现macOS的tar默认附加AppleDouble文件元数据；打包命令现设置COPYFILE_DISABLE=1，最终源码包不再包含这些自动条目。442个实际文件逐字节匹配工作目录，清理后的归档通过上面的最终发布检查。

## 编辑菜单阶段发布链

前端生产入口为 `index-DzjdcFNV.js`（SHA-256 `6d4bc3465bef33180964da67cd947a35e3c14176000b1fa0474bda0327483860`），Worker 与 WASM 延用上一节已构建的 v/s/z 版本。104项单测、类型/素材检查、16组新菜单流程、既有基础编辑与中键两组回归通过，见 [菜单验收](edit-menu-validation.md)。

重新测试 `/maijdata/` 子路径：原素材、Worker、WASM 加载、许可和源码清单、首次真实编辑均通过。20Mbps/每响应50ms延迟模型下首次编辑1,876.2ms，首次编辑前压缩响应2,052,278字节（1.96MiB），页面错误0，见 [发布结果](results/2026-09-27/release-edit-menu.json)。本轮重建前端并重新打包，没有重测全新临时目录的WASM编译；原生对照及完整页面内存预算仍待完成。

## Visual碰撞检查阶段发布链

最终前端入口 `index-BdIOoNSY.js`（SHA-256 `b7368eba368e13c1b75b10e444d3423a83edb00948d20703eef59e922754e621`），Worker `chart.worker-CNE-G0AS.js`（SHA-256 `5a6c6686c85a86413add7a8c381b12d5051ffd7f883c23821bc4cab2d5b65aa4`）；WASM沿用已验证解析宿主。174项测试、类型和素材检查通过。碰撞检查9组生产流程、编辑菜单16组回归通过，千音符均匀/密集负载以相同页面内计时达到导入、帧和输入预算，见 [检查器验收](visual-checks-validation.md)。

`/maijdata/` 子路径PNG、Worker、WASM加载，许可与源码归档清单，以及首次真实编辑检查均通过。20Mbps/每响应50ms延迟模型下首次编辑1,552.3ms，首次编辑前压缩响应2,078,454字节（1.98MiB），页面错误0；原始数据见 [发布结果](results/2026-09-27/release-visual-checks.json)。此轮在工作目录重建前端，没有重测全新临时目录WASM编译。结果与最终文档随后收录源码归档，产品运行代码未再改变。原生对照、时间轨告警图标、其余路径和完整页面内存预算仍未完成。
